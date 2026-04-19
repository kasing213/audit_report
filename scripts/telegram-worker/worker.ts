/**
 * Outreach send-worker.
 *
 * Polls the CRM for approved proposals, opens each customer's Telegram Web chat
 * using the sales account's saved storage state, types the message, clicks Send,
 * and reports back. Respects DAILY_CAP + per-send random delay. Halts cleanly
 * when the session is gone or PAUSE=true.
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { chromium, Browser, BrowserContext, Page } from 'playwright';

dotenv.config();

// ---- Config ----
const BASE_URL = must('BASE_URL');
const WORKER_TOKEN = must('WORKER_TOKEN');
const STORAGE_STATE = process.env.STORAGE_STATE || './telegram-session.json';
const DAILY_CAP = intEnv('DAILY_CAP', 15);
const MIN_DELAY_MS = intEnv('MIN_DELAY_SEC', 60) * 1000;
const MAX_DELAY_MS = intEnv('MAX_DELAY_SEC', 180) * 1000;
const POLL_INTERVAL_MS = 60_000;
const CLAIM_URL = `${BASE_URL}/crm/api/outreach/claim`;
const MARK_SENT_URL = (id: string) => `${BASE_URL}/crm/api/outreach/${id}/mark-sent`;
const MARK_FAILED_URL = (id: string) => `${BASE_URL}/crm/api/outreach/${id}/mark-failed`;

function must(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`${name} is required in .env`); process.exit(1); }
  return v;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isPaused(): boolean {
  return (process.env.PAUSE || '').toLowerCase() === 'true';
}

function randomDelay(): number {
  return MIN_DELAY_MS + Math.floor(Math.random() * Math.max(1, MAX_DELAY_MS - MIN_DELAY_MS));
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- Types ----
interface ProposalClaim {
  _id: string;
  customer_phone: string;
  customer_name: string | null;
  message: string;
  follower: string | null;
}

// ---- API helpers ----
async function claim(): Promise<ProposalClaim | null> {
  const resp = await fetch(CLAIM_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WORKER_TOKEN}` },
  });
  if (!resp.ok) {
    console.error(`claim ${resp.status}: ${await resp.text()}`);
    return null;
  }
  const data = await resp.json() as { proposal: ProposalClaim | null };
  return data.proposal;
}

async function markSent(id: string): Promise<void> {
  const resp = await fetch(MARK_SENT_URL(id), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WORKER_TOKEN}` },
  });
  if (!resp.ok) console.error(`mark-sent ${resp.status}: ${await resp.text()}`);
}

async function markFailed(id: string, reason: string): Promise<void> {
  const resp = await fetch(MARK_FAILED_URL(id), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WORKER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reason }),
  });
  if (!resp.ok) console.error(`mark-failed ${resp.status}: ${await resp.text()}`);
}

// ---- Telegram Web automation ----
async function sendViaTelegramWeb(
  page: Page,
  phone: string,
  message: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cleanPhone = phone.replace(/\s|[-()]/g, '');

  // Telegram Web's shortcut for opening a chat by phone number.
  await page.goto(`https://web.telegram.org/a/#?phone=${encodeURIComponent(cleanPhone)}`, {
    waitUntil: 'domcontentloaded',
  });

  // Wait for either the message input OR a "user not found" dialog.
  try {
    await page.waitForSelector(
      'div[contenteditable="true"][data-placeholder], .confirm-dialog, div:has-text("Phone number not found")',
      { timeout: 15_000 }
    );
  } catch {
    return { ok: false, reason: 'chat did not load within 15s' };
  }

  const notFound = await page.locator('text=/Phone number.*not.*Telegram|не найден/i').first().count().catch(() => 0);
  if (notFound > 0) return { ok: false, reason: 'phone number not on Telegram' };

  const messageBox = page.locator('div[contenteditable="true"][data-placeholder]').first();
  const boxVisible = await messageBox.isVisible().catch(() => false);
  if (!boxVisible) return { ok: false, reason: 'message input not visible' };

  await messageBox.click();
  // Type char-by-char for more human-like pacing and to ensure all Khmer codepoints land.
  await messageBox.type(message, { delay: 20 });

  // Click the send (paper plane) button. aria-label varies across locales — try a few.
  const sendCandidates = [
    'button[aria-label="Send Message"]',
    'button[aria-label="Send"]',
    'button.send-as-button',
    'button:has-text("Send")',
    '.Button.send',
  ];
  let clicked = false;
  for (const sel of sendCandidates) {
    const el = page.locator(sel).first();
    if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
      await el.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    // Fallback: Ctrl+Enter sends in some Telegram Web builds.
    await page.keyboard.press('Control+Enter');
  }

  // Confirm the message appears in the outgoing message list.
  try {
    await page.waitForSelector(`.message.own:has-text(${JSON.stringify(message.slice(0, 30))})`, { timeout: 10_000 });
  } catch {
    return { ok: false, reason: 'outgoing message did not appear in DOM' };
  }

  return { ok: true };
}

// ---- Main loop ----
async function main(): Promise<void> {
  if (!fs.existsSync(STORAGE_STATE)) {
    console.error(`Storage state missing at ${STORAGE_STATE}. Run \`npm run login\` first.`);
    process.exit(1);
  }

  console.log(`Worker online. Base=${BASE_URL}, daily cap=${DAILY_CAP}, delay=${MIN_DELAY_MS / 1000}-${MAX_DELAY_MS / 1000}s.`);

  const browser: Browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();

  let sentToday = 0;
  let sentDay = todayKey();

  const stop = async (reason: string, code = 0) => {
    console.log(`Stopping: ${reason}`);
    await browser.close().catch(() => undefined);
    process.exit(code);
  };

  process.on('SIGINT', () => stop('SIGINT', 0));
  process.on('SIGTERM', () => stop('SIGTERM', 0));

  while (true) {
    // Roll daily counter at UTC midnight.
    const today = todayKey();
    if (today !== sentDay) { sentDay = today; sentToday = 0; }

    if (isPaused()) { console.log('PAUSE=true, idle.'); await sleep(POLL_INTERVAL_MS); continue; }
    if (sentToday >= DAILY_CAP) {
      console.log(`Daily cap ${DAILY_CAP} reached. Waiting.`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    let proposal: ProposalClaim | null = null;
    try { proposal = await claim(); } catch (e) { console.error('claim err', e); }

    if (!proposal) { await sleep(POLL_INTERVAL_MS); continue; }

    console.log(`→ sending to ${proposal.customer_name || '?'} ${proposal.customer_phone}`);
    let result;
    try {
      result = await sendViaTelegramWeb(page, proposal.customer_phone, proposal.message);
    } catch (err) {
      result = { ok: false as const, reason: `exception: ${(err as Error).message}` };
    }

    if (result.ok) {
      await markSent(proposal._id);
      sentToday++;
      console.log(`  ✓ sent (${sentToday}/${DAILY_CAP} today)`);
    } else {
      await markFailed(proposal._id, result.reason);
      console.log(`  ✗ failed: ${result.reason}`);
      if (/session|log ?in|unauthorized|sign ?in/i.test(result.reason)) {
        await stop('Telegram Web session invalid. Re-run `npm run login`.', 2);
      }
    }

    const delay = randomDelay();
    console.log(`  next send in ~${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(async (err) => {
  console.error('worker crash:', err);
  process.exit(1);
});
