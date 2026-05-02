/**
 * Outreach send-worker.
 *
 * Polls the CRM for approved proposals, opens each customer's Telegram Web chat
 * using the sales account's saved storage state, types the message, clicks Send,
 * and reports back. Respects DAILY_CAP + per-send random delay. Halts cleanly
 * when the session is gone or the server-side pause flag is set.
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { runInboundPoller, Mutex } from './inbound-poll';

dotenv.config();

// ---- Config ----
const BASE_URL = must('BASE_URL');
const AGENT_TOKEN = resolveAgentToken();
const STORAGE_STATE = process.env.STORAGE_STATE || './telegram-session.json';
const DAILY_CAP = intEnv('DAILY_CAP', 15);
const MIN_DELAY_MS = intEnv('MIN_DELAY_SEC', 60) * 1000;
const MAX_DELAY_MS = intEnv('MAX_DELAY_SEC', 180) * 1000;
const POLL_INTERVAL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const INBOUND_POLL_MS = intEnv('INBOUND_POLL_SEC', 30) * 1000;
const INBOUND_DISABLED = String(process.env.INBOUND_DISABLED || '').toLowerCase() === 'true';
const WORKER_ID = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
const CLAIM_URL = `${BASE_URL}/crm/api/outreach/claim`;
const STATUS_URL = `${BASE_URL}/crm/api/outreach/worker-status`;
const HEARTBEAT_URL = `${BASE_URL}/crm/api/outreach/worker-heartbeat`;
const ALERT_URL = `${BASE_URL}/crm/api/outreach/worker-alert`;
const MARK_SENT_URL = (id: string) => `${BASE_URL}/crm/api/outreach/${id}/mark-sent`;
const MARK_FAILED_URL = (id: string) => `${BASE_URL}/crm/api/outreach/${id}/mark-failed`;

function must(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`${name} is required in .env`); process.exit(1); }
  return v;
}

function resolveAgentToken(): string {
  const agent = process.env.AGENT_TOKEN;
  if (agent) return agent;
  const legacy = process.env.WORKER_TOKEN;
  if (legacy) {
    console.warn('WORKER_TOKEN is deprecated — rename to AGENT_TOKEN in .env.');
    return legacy;
  }
  console.error('AGENT_TOKEN is required in .env');
  process.exit(1);
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

interface ClaimResponse {
  proposal: ProposalClaim | null;
  paused?: boolean;
  daily_cap_reached?: boolean;
}

interface StatusResponse {
  paused: boolean;
  daily_cap?: number;
}

// ---- Shared state with the heartbeat thread ----
const workerState = {
  sentToday: 0,
  lastError: null as string | null,
  paused: false,
};

// ---- API helpers ----
async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      'Authorization': `Bearer ${AGENT_TOKEN}`,
      ...(init.headers || {}),
    },
  });
}

async function claim(): Promise<ClaimResponse | null> {
  const resp = await authedFetch(CLAIM_URL, { method: 'POST' });
  if (!resp.ok) {
    console.error(`claim ${resp.status}: ${await resp.text()}`);
    return null;
  }
  return (await resp.json()) as ClaimResponse;
}

async function fetchStatus(): Promise<StatusResponse | null> {
  try {
    const resp = await authedFetch(STATUS_URL, { method: 'GET' });
    if (!resp.ok) return null;
    return (await resp.json()) as StatusResponse;
  } catch {
    return null;
  }
}

async function postHeartbeat(): Promise<void> {
  try {
    const resp = await authedFetch(HEARTBEAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worker_id: WORKER_ID,
        sent_today: workerState.sentToday,
        last_error: workerState.lastError,
      }),
    });
    if (resp.ok) {
      const data = await resp.json() as { paused?: boolean };
      if (typeof data.paused === 'boolean') workerState.paused = data.paused;
    }
  } catch (err) {
    console.error('heartbeat err', err);
  }
}

async function postAlert(kind: string, reason: string): Promise<void> {
  try {
    await authedFetch(ALERT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, reason, worker_id: WORKER_ID }),
    });
  } catch (err) {
    console.error('alert err', err);
  }
}

async function markSent(id: string): Promise<void> {
  const resp = await authedFetch(MARK_SENT_URL(id), { method: 'POST' });
  if (!resp.ok) console.error(`mark-sent ${resp.status}: ${await resp.text()}`);
}

async function markFailed(id: string, reason: string): Promise<void> {
  const resp = await authedFetch(MARK_FAILED_URL(id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!resp.ok) console.error(`mark-failed ${resp.status}: ${await resp.text()}`);
}

// ---- Telegram Web automation ----
async function dumpDiagnostic(page: Page, label: string): Promise<{ screenshot: string; html: string }> {
  const stamp = Date.now();
  const screenshot = `./debug-fail-${stamp}.png`;
  const html = `./debug-fail-${stamp}.html`;
  try { await page.screenshot({ path: screenshot, fullPage: true }); } catch { /* ignore */ }
  try {
    const body = await page.content();
    fs.writeFileSync(html, body);
  } catch { /* ignore */ }
  console.log(`  diagnostic ${label}: screenshot=${screenshot} html=${html} url=${page.url()}`);
  return { screenshot, html };
}

async function sendViaTelegramWeb(
  page: Page,
  phone: string,
  message: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Strip non-digits — tg://resolve?phone= expects digits only.
  const phoneDigits = phone.replace(/\D/g, '');

  // /a/ (TGCloud Z) supports the tgaddr hash for tg:// deeplinks. The phone
  // resolver opens the user's chat if they are on Telegram. The plain
  // `#?phone=…` form doesn't work in /a/ — that's /k/ syntax.
  // Hop through about:blank so the next goto is a real page load — without
  // it, hash-only navigation in the SPA skips Telegram's tgaddr handler and
  // every send after the first one fails with "no composer".
  const tgaddr = encodeURIComponent(`tg://resolve?phone=${phoneDigits}`);
  await page.goto('about:blank');
  await page.goto(`https://web.telegram.org/a/#?tgaddr=${tgaddr}`, { waitUntil: 'domcontentloaded' });

  // Telegram applies the hash route async after first paint. Wait for either
  // the composer (chat opened) or a 'not on Telegram' style toast/dialog.
  const composerSelectors = [
    'div#editable-message-text',
    'div.input-message-input[contenteditable="true"]',
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"][role="textbox"]',
  ];
  const composerSelector = composerSelectors.join(', ');
  try {
    await page.waitForSelector(
      `${composerSelector}, .confirm-dialog, div:has-text("Phone number not found"), div:has-text("not on Telegram")`,
      { timeout: 30_000 }
    );
  } catch {
    const d = await dumpDiagnostic(page, 'no-composer-after-tgaddr');
    return { ok: false, reason: `chat did not load via tgaddr within 30s — screenshot=${d.screenshot} html=${d.html}` };
  }

  // Did Telegram tell us this number isn't on Telegram?
  const notFoundCount = await page.locator('text=/not on Telegram|Phone number.*not.*Telegram|не найден/i').first().count().catch(() => 0);
  if (notFoundCount > 0) return { ok: false, reason: 'phone number not on Telegram' };

  // Locate the visible composer (one of the selectors waited above must match).
  let messageBox = null as ReturnType<Page['locator']> | null;
  for (const sel of composerSelectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
      messageBox = el;
      break;
    }
  }
  if (!messageBox) {
    const d = await dumpDiagnostic(page, 'no-composer-visible');
    return { ok: false, reason: `composer never appeared — screenshot=${d.screenshot} html=${d.html}` };
  }

  // 5. Type the message.
  await messageBox.click();
  await messageBox.type(message, { delay: 20 });

  // Dump composer-state diagnostic so we can verify the send button is
  // actually present and visible at the moment we click.
  await dumpDiagnostic(page, 'pre-send');

  // 6. Click send. /a/ renders the send button with a paper-plane icon and
  // class .Button.send.main-button. We try a few permutations and log which
  // selector matched so we can prune the list once it's stable.
  const sendCandidates = [
    'button.Button.send.main-button',
    'button.Button.send',
    'button[aria-label="Send Message"]',
    'button[aria-label="Send"]',
    '.send-as-button',
    'button.send',
  ];
  let clickedWith: string | null = null;
  for (const sel of sendCandidates) {
    const el = page.locator(sel).first();
    if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
      await el.click();
      clickedWith = sel;
      break;
    }
  }
  if (!clickedWith) {
    // Fallback to keyboard. Telegram Web /a/ sends on Enter (no shift); we
    // must focus the composer first or the keypress is dropped.
    await messageBox.click();
    await page.keyboard.press('Enter');
    clickedWith = 'keyboard:Enter';
  }
  console.log(`  send via ${clickedWith}`);

  // 7. Wait for the composer to clear — that's the only reliable signal that
  // Telegram accepted the message. If the input still contains our text after
  // 6 s the click didn't fire (e.g. send button was a no-op for some other
  // reason), so dump diagnostic and fail rather than silently 'succeed'.
  const composerCleared = await page
    .waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const txt = (el.textContent || '').trim();
        return txt.length === 0;
      },
      composerSelectors[0],
      { timeout: 6_000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!composerCleared) {
    const d = await dumpDiagnostic(page, 'composer-not-cleared');
    return { ok: false, reason: `send did not fire — composer still holds the draft (clicked=${clickedWith}) — screenshot=${d.screenshot} html=${d.html}` };
  }

  // 8. Confirm the outgoing bubble actually rendered. We require a strict
  // outgoing-message class match — no broad [class*="own"] fallback (which
  // false-positive'd against the composer wrapper in an earlier iteration).
  const messageHead = message.slice(0, 30);
  const ownSelectors = [
    `.Message.own:has-text(${JSON.stringify(messageHead)})`,
    `.message.own:has-text(${JSON.stringify(messageHead)})`,
    `.bubble.is-out:has-text(${JSON.stringify(messageHead)})`,
    `[data-is-own="true"]:has-text(${JSON.stringify(messageHead)})`,
  ];
  let confirmed = false;
  for (const sel of ownSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 4_000 });
      confirmed = true;
      break;
    } catch { /* try next */ }
  }
  if (!confirmed) {
    const d = await dumpDiagnostic(page, 'no-outgoing-bubble');
    return { ok: false, reason: `outgoing bubble not visible — screenshot=${d.screenshot} html=${d.html}` };
  }

  return { ok: true };
}

// ---- Main loop ----
async function main(): Promise<void> {
  if (!fs.existsSync(STORAGE_STATE)) {
    console.error(`Storage state missing at ${STORAGE_STATE}. Run \`npm run login\` first.`);
    await postAlert('session-expired', `Storage state missing at ${STORAGE_STATE}`);
    process.exit(1);
  }

  console.log(`Worker online. Base=${BASE_URL}, daily cap=${DAILY_CAP}, delay=${MIN_DELAY_MS / 1000}-${MAX_DELAY_MS / 1000}s, inbound=${INBOUND_DISABLED ? 'off' : `${INBOUND_POLL_MS / 1000}s`}, id=${WORKER_ID}.`);

  const browser: Browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();
  const sendMutex = new Mutex();

  // Spawn the inbound-reply poller as a background loop on a second tab in
  // the same context — shares the Telegram session, never decrements DAILY_CAP.
  if (!INBOUND_DISABLED) {
    const inboundPage = await context.newPage();
    runInboundPoller(inboundPage, {
      mutex: sendMutex,
      baseUrl: BASE_URL,
      agentToken: AGENT_TOKEN,
      intervalMs: INBOUND_POLL_MS,
      dumpDiagnostic,
    }).catch((err) => {
      console.error('[inbound] poller crashed:', err);
    });
  }

  let sentDay = todayKey();

  const heartbeatTimer = setInterval(() => {
    postHeartbeat().catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  await postHeartbeat();

  const stop = async (reason: string, code = 0) => {
    console.log(`Stopping: ${reason}`);
    clearInterval(heartbeatTimer);
    await browser.close().catch(() => undefined);
    process.exit(code);
  };

  process.on('SIGINT', () => stop('SIGINT', 0));
  process.on('SIGTERM', () => stop('SIGTERM', 0));

  while (true) {
    // Roll daily counter at UTC midnight.
    const today = todayKey();
    if (today !== sentDay) { sentDay = today; workerState.sentToday = 0; }

    // Refresh paused flag each iteration (server controls it now).
    const status = await fetchStatus();
    if (status) workerState.paused = status.paused;

    if (workerState.paused) {
      console.log('Paused (server flag), idle.');
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (workerState.sentToday >= DAILY_CAP) {
      console.log(`Local daily cap ${DAILY_CAP} reached. Waiting.`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    let claimResp: ClaimResponse | null = null;
    try { claimResp = await claim(); } catch (e) { console.error('claim err', e); }

    if (!claimResp || !claimResp.proposal) {
      if (claimResp?.daily_cap_reached) console.log('Server daily cap reached.');
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const proposal = claimResp.proposal;
    console.log(`→ sending to ${proposal.customer_name || '?'} ${proposal.customer_phone}`);
    let result;
    try {
      // Mutex with the inbound poller — they share the same browser context
      // (and therefore the same Telegram session). Hold it for the whole send
      // sequence so the poller can't click into another chat mid-typing.
      result = await sendMutex.runExclusive(() =>
        sendViaTelegramWeb(page, proposal.customer_phone, proposal.message)
      );
    } catch (err) {
      result = { ok: false as const, reason: `exception: ${(err as Error).message}` };
    }

    if (result.ok) {
      await markSent(proposal._id);
      workerState.sentToday++;
      workerState.lastError = null;
      console.log(`  ✓ sent (${workerState.sentToday}/${DAILY_CAP} today)`);
    } else {
      await markFailed(proposal._id, result.reason);
      workerState.lastError = result.reason;
      console.log(`  ✗ failed: ${result.reason}`);
      if (/session|log ?in|unauthorized|sign ?in/i.test(result.reason)) {
        await postAlert('session-expired', result.reason);
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
  try { await postAlert('worker-fatal', (err as Error).message || 'unknown'); } catch {}
  process.exit(1);
});
