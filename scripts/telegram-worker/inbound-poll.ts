/**
 * Inbound-reply scraper.
 *
 * Runs in a second Playwright Page sharing the same BrowserContext as the
 * outbound send loop in worker.ts. Every INBOUND_POLL_SEC seconds:
 *   1. Navigate to https://web.telegram.org/a/ (chat list).
 *   2. Find chat tiles that show an unread badge.
 *   3. For each, open the chat, read the chat header to find the peer's phone
 *      (only chats with a visible phone are eligible — others are skipped).
 *   4. Walk visible incoming (.Message NOT .own) bubbles, extract data-message-id
 *      + text.
 *   5. POST every (phone, telegram_message_id, text) tuple to
 *      /crm/api/outreach/report-inbound. Server-side dedup on the unique
 *      compound index handles re-scraping idempotently; the local cursor map
 *      is just there to skip already-seen messages within a single worker
 *      lifetime.
 *
 * Selectors for /a/ (TGCloud Z) are not documented and may shift. Helpers are
 * tolerant: if a selector misses, we dump diagnostics, skip the tile, and move
 * on rather than crashing the loop.
 */

import { Page } from 'playwright';

// ---- Public API ----

export interface InboundPollerOptions {
  mutex: Mutex;
  baseUrl: string;
  agentToken: string;
  intervalMs: number;
  dumpDiagnostic: (page: Page, label: string) => Promise<unknown>;
}

export async function runInboundPoller(page: Page, opts: InboundPollerOptions): Promise<void> {
  const cursor = new Map<string, number>();
  let consecutiveFailures = 0;

  for (;;) {
    try {
      await opts.mutex.runExclusive(async () => {
        await scanOnce(page, cursor, opts);
      });
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      console.error(`[inbound] tick failed (${consecutiveFailures} in a row):`, (err as Error).message);
      if (consecutiveFailures === 1) {
        try { await opts.dumpDiagnostic(page, 'inbound-tick-failed'); } catch { /* ignore */ }
      }
    }
    await sleep(opts.intervalMs);
  }
}

// ---- Mutex (tiny, no dependency) ----

export class Mutex {
  private _tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const myTurn = this._tail;
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this._tail = next;
    await myTurn;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// ---- Scan implementation ----

async function scanOnce(
  page: Page,
  cursor: Map<string, number>,
  opts: InboundPollerOptions
): Promise<void> {
  const onChatList = await page.evaluate(() => location.href.includes('web.telegram.org/a/'));
  if (!onChatList) {
    await page.goto('https://web.telegram.org/a/', { waitUntil: 'domcontentloaded' });
  }

  // Wait for the chat list to render. /a/ wraps tiles in #LeftColumn-main.
  try {
    await page.waitForSelector('#LeftColumn-main, .chat-list, .Chat', { timeout: 10_000 });
  } catch {
    await opts.dumpDiagnostic(page, 'inbound-no-chat-list');
    return;
  }

  // Detect login wall.
  const onLogin = await page.locator('input[name="phone"], button:has-text("Log in"), .Login').count().catch(() => 0);
  if (onLogin > 0) {
    throw new Error('inbound: login wall detected — session may be expired');
  }

  // Collect unread tiles. Multiple selector permutations because /a/ shuffles
  // class names between versions.
  const unreadTiles = await page.evaluate(() => {
    const candidates: Element[] = [];
    const tileSelectors = ['.ListItem.Chat', '.Chat.ListItem', '.ChatListItem', '.Chat'];
    let tiles: Element[] = [];
    for (const sel of tileSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > 0) { tiles = found; break; }
    }
    for (const t of tiles) {
      const badge = t.querySelector('.Badge, .badge, .unread, .unread-count, [class*="ChatBadge"], [class*="badge"]');
      if (!badge) continue;
      const txt = (badge.textContent || '').trim();
      // Mute/pin badges have non-numeric content; require a digit.
      if (!/\d/.test(txt)) continue;
      candidates.push(t);
    }
    return candidates.map((t) => {
      const peerEl = t as HTMLElement;
      const peerId = peerEl.getAttribute('data-peer-id') || peerEl.getAttribute('data-chat-id') || null;
      const titleEl = peerEl.querySelector('.title, .ChatInfo .title, h3, .fullName');
      const title = titleEl ? (titleEl.textContent || '').trim() : null;
      return { peerId, title };
    });
  });

  if (unreadTiles.length === 0) {
    return;
  }

  console.log(`[inbound] ${unreadTiles.length} unread chat(s) detected`);

  // Open each unread chat in turn. We re-query each iteration because clicking
  // a tile re-orders the list and stale handles point at moved nodes.
  for (let i = 0; i < unreadTiles.length; i++) {
    const tileInfo = unreadTiles[i];
    if (!tileInfo) continue;

    let opened = false;
    if (tileInfo.peerId) {
      opened = await openChatByPeerId(page, tileInfo.peerId);
    }
    if (!opened && tileInfo.title) {
      opened = await openChatByTitle(page, tileInfo.title);
    }
    if (!opened) {
      console.log(`[inbound] could not open chat (peer=${tileInfo.peerId}, title=${tileInfo.title})`);
      continue;
    }

    const phone = await readChatPhone(page);
    if (!phone) {
      console.log(`[inbound] no phone visible on chat (peer=${tileInfo.peerId}, title=${tileInfo.title}) — skipping`);
      // Go back to chat list before continuing.
      await page.goto('https://web.telegram.org/a/', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      continue;
    }

    const messages = await readIncomingMessages(page);
    const lastSeen = cursor.get(phone) ?? 0;
    const newOnes = messages.filter((m) => m.id > lastSeen);

    let maxId = lastSeen;
    for (const msg of newOnes) {
      try {
        const ok = await reportInbound(opts.baseUrl, opts.agentToken, {
          phone,
          telegram_message_id: msg.id,
          text: msg.text,
          received_at: new Date().toISOString(),
        });
        if (ok) {
          if (msg.id > maxId) maxId = msg.id;
          console.log(`[inbound] reported ${phone} msg=${msg.id}`);
        }
      } catch (err) {
        console.error(`[inbound] report failed for ${phone} msg=${msg.id}`, (err as Error).message);
      }
    }
    if (maxId > lastSeen) cursor.set(phone, maxId);

    // Back to chat list for the next tile.
    await page.goto('https://web.telegram.org/a/', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForSelector('#LeftColumn-main, .chat-list, .Chat', { timeout: 5_000 }).catch(() => undefined);
  }
}

// ---- DOM helpers ----

async function openChatByPeerId(page: Page, peerId: string): Promise<boolean> {
  const sel = `[data-peer-id="${cssEscape(peerId)}"], [data-chat-id="${cssEscape(peerId)}"]`;
  try {
    const el = page.locator(sel).first();
    if ((await el.count()) === 0) return false;
    await el.click({ timeout: 5_000 });
    await page.waitForSelector('.MessageList, .messages-container, .bubbles', { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

async function openChatByTitle(page: Page, title: string): Promise<boolean> {
  try {
    const el = page.locator(`.ListItem.Chat:has-text(${JSON.stringify(title)}), .ChatListItem:has-text(${JSON.stringify(title)})`).first();
    if ((await el.count()) === 0) return false;
    await el.click({ timeout: 5_000 });
    await page.waitForSelector('.MessageList, .messages-container, .bubbles', { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

async function readChatPhone(page: Page): Promise<string | null> {
  const phone = await page.evaluate(() => {
    const candidates = [
      '.RightHeader .phone, .RightHeader .username, .ChatInfo .phone',
      '.ChatHeader .phone, .ChatHeader .username',
      '.Profile .phone, .Profile-info .phone',
      '.user-status, .info .subtitle',
      '[href^="tel:"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const txt = (el.textContent || '').replace(/\s+/g, '');
      const match = txt.match(/\+?\d[\d\-]{6,}/);
      if (match) return match[0].replace(/\D/g, '');
    }
    return null;
  });
  return phone;
}

interface IncomingMessage {
  id: number;
  text: string;
}

async function readIncomingMessages(page: Page): Promise<IncomingMessage[]> {
  return page.evaluate(() => {
    const results: { id: number; text: string }[] = [];
    const bubbleSelectors = [
      '.Message:not(.own)',
      '.message:not(.own)',
      '.bubble:not(.is-out)',
      '[data-is-own="false"]',
    ];
    let nodes: Element[] = [];
    for (const sel of bubbleSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > 0) { nodes = found; break; }
    }
    for (const n of nodes) {
      const idAttr = n.getAttribute('data-message-id') || n.getAttribute('data-mid');
      const id = idAttr ? parseInt(idAttr, 10) : NaN;
      if (!Number.isFinite(id)) continue;
      const textEl = n.querySelector('.text-content, .text, .message-text, .translatable-message') || n;
      const text = (textEl.textContent || '').trim();
      if (!text) continue;
      results.push({ id, text });
    }
    return results;
  });
}

// ---- HTTP ----

interface ReportPayload {
  phone: string;
  telegram_message_id: number;
  text: string;
  received_at: string;
}

async function reportInbound(baseUrl: string, agentToken: string, payload: ReportPayload): Promise<boolean> {
  const resp = await fetch(`${baseUrl}/crm/api/outreach/report-inbound`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${agentToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    console.error(`[inbound] /report-inbound ${resp.status}: ${await resp.text().catch(() => '')}`);
    return false;
  }
  return true;
}

// ---- Misc ----

function cssEscape(s: string): string {
  return s.replace(/(["\\\]])/g, '\\$1');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
