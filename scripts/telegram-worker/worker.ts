/**
 * Outreach worker (MTProto / gramjs).
 *
 * Runs as the user's Telegram account via a saved StringSession. Single
 * unified path for both outbound sends (claim → ResolvePhone → sendMessage)
 * and inbound replies (NewMessage event handler → POST /report-inbound).
 * Replaces the previous Playwright-based worker and inbound poller. No
 * headless browser, no DOM scraping.
 *
 * Bootstrap: `npm run login` once to produce telegram-string-session.txt.
 * Run: `npm start`.
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import bigInt from 'big-integer';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { LogLevel } from 'telegram/extensions/Logger';
import { requireWorkerOrgId } from './worker-config';

dotenv.config();

// ---- Config ----
const BASE_URL = must('BASE_URL');
const AGENT_TOKEN = resolveAgentToken();
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION_PATH = process.env.STRING_SESSION_PATH || './telegram-string-session.txt';
// Which outreach workspace this worker sends for. The server scopes every
// claim / cap / mark-sent / inbound by this via the X-Org-Id header, so each
// worker (its own Telegram session + this env) never touches another's
// proposals or daily caps. Required — a worker that guessed 'company' here
// would send another workspace's messages from this account, so an unset or
// unrecognised value exits before any network activity.
const ORG_ID = requireWorkerOrgId(process.env.ORG_ID);
const DAILY_CAP = intEnv('DAILY_CAP', 15);
const MIN_DELAY_MS = intEnv('MIN_DELAY_SEC', 60) * 1000;
const MAX_DELAY_MS = intEnv('MAX_DELAY_SEC', 180) * 1000;
const POLL_INTERVAL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
// Hard ceiling on a single send. gramjs's client.invoke() has no per-call
// timeout: if the MTProto connection stalls mid-request (reconnect storm),
// the await blocks forever and freezes this single-threaded loop, so no
// further approved proposal is ever claimed. Racing every send against this
// timeout guarantees the loop always advances. Default is generous (240s)
// because a send now downloads a ~50MB video from R2 and uploads it to
// Telegram, which is slow on a home connection.
const SEND_TIMEOUT_MS = intEnv('SEND_TIMEOUT_SEC', 240) * 1000;
// After this many CONSECUTIVE 'deferred' ImportContacts outcomes, pause
// sending for a while instead of continuing to hammer Telegram's throttle
// every 60-180s. Pure pacing — does NOT cap attempts, requeue anything, or
// change suppression permanence (deferred is still a permanent phone-level
// suppression, see outreach-suppression-repository.ts). Just stops digging
// while the account is visibly being throttled right now.
const DEFERRAL_BACKOFF_THRESHOLD = intEnv('DEFERRAL_BACKOFF_THRESHOLD', 5);
// Cooldown length once the threshold is hit, in minutes. Ops-tunable via env
// without a redeploy.
const DEFERRAL_BACKOFF_MIN = intEnv('DEFERRAL_BACKOFF_MIN', 45);
const DEFERRAL_BACKOFF_MS = DEFERRAL_BACKOFF_MIN * 60_000;
const INBOUND_DISABLED = String(process.env.INBOUND_DISABLED || '').toLowerCase() === 'true';
const WORKER_ID = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
const CLAIM_URL = `${BASE_URL}/crm/api/outreach/claim`;
const STATUS_URL = `${BASE_URL}/crm/api/outreach/worker-status`;
const HEARTBEAT_URL = `${BASE_URL}/crm/api/outreach/worker-heartbeat`;
const ALERT_URL = `${BASE_URL}/crm/api/outreach/worker-alert`;
const REPORT_INBOUND_URL = `${BASE_URL}/crm/api/outreach/report-inbound`;
const MARK_SENT_URL = (id: string) => `${BASE_URL}/crm/api/outreach/${id}/mark-sent`;
const MARK_FAILED_URL = (id: string) => `${BASE_URL}/crm/api/outreach/${id}/mark-failed`;
const EFFECTIVE_MEDIA_URL = (id: string) => `${BASE_URL}/crm/api/outreach/${id}/effective-media`;
const SCHEDULE_URL = `${BASE_URL}/crm/api/outreach/schedule-settings`;
// How often to poll the dashboard-configured bounce time. Cheap GET, and the
// only thing that matters is catching the target minute within this window,
// so 5 min is generous margin without hammering the API.
const SCHEDULE_POLL_INTERVAL_MS = 5 * 60 * 1000;
// Captured once at process start. Bounce logic below only fires once per
// process lifetime — a process that was born AFTER today's bounce time is by
// definition already the fresh post-bounce process, so it must not re-exit
// and loop forever.
const PROCESS_STARTED_AT = new Date();

if (!API_ID || !API_HASH) {
  console.error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env. Get them from https://my.telegram.org/apps.');
  process.exit(1);
}

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
  outside_active_hours?: boolean;
}

interface StatusResponse {
  paused: boolean;
  daily_cap?: number;
}

// ---- Shared state ----
const workerState = {
  sentToday: 0,
  lastError: null as string | null,
  paused: false,
  // Consecutive 'deferred' ImportContacts outcomes in a row this process.
  // Reset to 0 on any non-deferred outcome (success or a different failure
  // kind). In-memory only — a fresh process is a fresh chance for Telegram to
  // reconsider, no need to persist across restarts.
  consecutiveDeferrals: 0,
  // Set once the backoff threshold is hit; cleared when the pause elapses.
  // While non-null and in the future, the main loop skips claim() entirely.
  deferralPauseUntil: null as Date | null,
};

// userId → phone, populated during send so inbound events can recover the
// customer's phone without a round-trip to Telegram for already-known peers.
const peerPhoneByUserId = new Map<string, string>();

// ---- API helpers ----
async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      'Authorization': `Bearer ${AGENT_TOKEN}`,
      'X-Org-Id': ORG_ID,
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
  } catch {
    // Transient connection blip to our own backend — next heartbeat retries.
  }
}

// 'HH:MM' (dashboard-configured, Cambodia local) -> today's instant for that
// clock time on THIS machine. Assumes the Mac's local clock is already
// Cambodia time (UTC+7) — same assumption the old pm2 cron_restart made,
// since cron_restart has no timezone option either.
function todayInstantAt(hhmm: string): Date | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), 0, 0);
}

/**
 * Replaces pm2's cron_restart: once today's dashboard-configured bounce time
 * arrives, exit cleanly so pm2's autorestart brings up a fresh process before
 * the day's scan/send window. Self-limiting via PROCESS_STARTED_AT — only the
 * stale pre-bounce process (started before today's target) ever exits here,
 * so this can't loop.
 */
async function checkDailyBounce(): Promise<void> {
  try {
    const resp = await authedFetch(SCHEDULE_URL, { method: 'GET' });
    if (!resp.ok) return;
    const settings = (await resp.json()) as { bounce_time?: string };
    const target = settings.bounce_time ? todayInstantAt(settings.bounce_time) : null;
    if (!target) return;
    if (new Date() >= target && PROCESS_STARTED_AT < target) {
      console.log(`Daily bounce time (${settings.bounce_time}) reached — restarting for a fresh process.`);
      process.exit(0);
    }
  } catch {
    // Transient connection blip to our own backend — next poll retries.
  }
}

async function postAlert(kind: string, reason: string): Promise<void> {
  try {
    await authedFetch(ALERT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, reason, worker_id: WORKER_ID }),
    });
  } catch {
    // Transient connection blip to our own backend — nothing to retry here.
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

async function reportInbound(payload: {
  phone: string;
  telegram_message_id: number;
  text: string;
  received_at: string;
}): Promise<void> {
  try {
    const resp = await authedFetch(REPORT_INBOUND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.error(`report-inbound ${resp.status}: ${await resp.text()}`);
    }
  } catch (err) {
    console.error('report-inbound err', err);
  }
}

// Monotonic counter for unique temp media filenames within this process.
let mediaSeq = 0;

// Write a buffer to a uniquely-named temp file with the given extension and
// return its path. Used to stage the image + video on disk so gramjs can send
// them as one album (sendFile with an array of file paths).
async function writeTemp(buffer: Buffer, ext: string): Promise<string> {
  const safeExt = (ext || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  const tmpPath = path.join(os.tmpdir(), `outreach-media-${process.pid}-${mediaSeq++}.${safeExt}`);
  await fs.promises.writeFile(tmpPath, buffer);
  return tmpPath;
}

interface ManifestItem {
  type: 'image' | 'video';
  source: string;
  id: string;
  filename: string;
  url: string;
}

// Fetch the ordered media manifest for a proposal, then download every item
// and stage it as a temp file. Images are server-relative paths (fetched
// with our bearer token, same auth as everything else); videos are already
// absolute, presigned R2 URLs (fetched with a plain, unauthenticated
// request, same as today's default-video-url flow). Empty manifest is a
// valid text-only send, not an error — matches existing behavior.
async function fetchEffectiveMedia(proposalId: string): Promise<string[]> {
  const resp = await authedFetch(EFFECTIVE_MEDIA_URL(proposalId));
  if (!resp.ok) {
    throw new Error(`effective-media ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  const manifest = (await resp.json()) as ManifestItem[];
  const paths: string[] = [];
  for (const item of manifest) {
    if (item.type === 'image') {
      const imgResp = await authedFetch(`${BASE_URL}${item.url}`);
      if (!imgResp.ok) throw new Error(`effective-media image fetch ${imgResp.status}: ${item.url}`);
      const buffer = Buffer.from(await imgResp.arrayBuffer());
      const ext = item.filename.split('.').pop() || 'jpg';
      paths.push(await writeTemp(buffer, ext));
    } else {
      const dl = await fetch(item.url); // presigned R2 URL — no auth header
      if (!dl.ok) throw new Error(`effective-media video download failed: HTTP ${dl.status}`);
      const bytes = Buffer.from(await dl.arrayBuffer());
      paths.push(await writeTemp(bytes, 'mp4'));
      console.log(`  video: ${bytes.length}B staged (${item.source})`);
    }
  }
  return paths;
}

// ---- Telegram (MTProto via gramjs) ----
function isSessionExpiredError(err: Error): boolean {
  const m = err.message || '';
  return /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_INVALID/i.test(m);
}

// Wording matters: the server's classifyFailure() decides which suppression
// kind a reason gets by regex on these strings. ABSENT matches the privacy
// pattern; DEFERRED matches its own separate pattern — both kinds are
// permanent (no auto-retry as of 2026-08), but kept distinct for audit
// visibility (genuinely unreachable vs. Telegram-throttled-us).
// check-import-outcome.ts guards DEFERRED never accidentally matching privacy.
export const DEFERRED_IMPORT_REASON = 'contact import deferred by Telegram';
export const ABSENT_PEER_REASON = 'phone number not on Telegram (or hidden by privacy)';

export type ImportOutcome =
  | { kind: 'user'; user: Api.User }
  | { kind: 'deferred' }
  | { kind: 'absent' };

// Resolve a raw phone number to a Telegram user. gramjs's getEntity(phone)
// only works for numbers already in the account's contacts/dialogs; a fresh
// lead's number throws "Cannot find any entity corresponding to …". The
// documented path for an arbitrary number is contacts.ImportContacts.
//
// Its response distinguishes three cases, and conflating the last two is what
// permanently blacklisted ~68 reachable leads on 2026-07-30..08-01:
//   users=[u]            -> resolved.
//   users=[] retry=[id]  -> Telegram DEFERRED the import (throttle/quota). This
//                           says nothing about the number; treat as transient.
//   users=[] retry=[]    -> genuinely not on Telegram, or privacy hides it.
async function importPhoneAsPeer(
  client: TelegramClient,
  phoneDigits: string,
  firstName: string
): Promise<ImportOutcome> {
  const imported = await client.invoke(new Api.contacts.ImportContacts({
    contacts: [new Api.InputPhoneContact({
      clientId: bigInt(0),
      phone: `+${phoneDigits}`,
      firstName: firstName || 'Lead',
      lastName: '',
    })],
  }));
  const user = imported.users.find((u): u is Api.User => u instanceof Api.User);
  if (user) return { kind: 'user', user };
  if (imported.retryContacts && imported.retryContacts.length > 0) return { kind: 'deferred' };
  return { kind: 'absent' };
}
export { importPhoneAsPeer };

async function sendViaMTProto(
  client: TelegramClient,
  proposalId: string,
  phone: string,
  message: string,
  customerName: string | null
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const phoneDigits = phone.replace(/\D/g, '');

  let mediaPaths: string[] = [];
  try {
    const outcome = await importPhoneAsPeer(client, phoneDigits, customerName || '');
    if (outcome.kind === 'deferred') {
      // Telegram refused the import, not the number. Reported as transient so
      // the server re-queues and refunds the attempt — never a suppression.
      return { ok: false, reason: DEFERRED_IMPORT_REASON };
    }
    if (outcome.kind === 'absent') {
      return { ok: false, reason: ABSENT_PEER_REASON };
    }
    const peer = outcome.user;

    peerPhoneByUserId.set(peer.id.toString(), phoneDigits);

    // Media (images + videos, primary + extras) is fully optional. The
    // message always exists (server falls back to the built-in template), so
    // a send with no media is a plain text message. Fetched only after the
    // peer resolves so unreachable numbers don't cost wasted downloads.
    mediaPaths = await fetchEffectiveMedia(proposalId);
    if (mediaPaths.length > 0) console.log(`  media: ${mediaPaths.length} item(s) staged`);

    const captionMode = message.length <= 1024;

    if (mediaPaths.length === 0) {
      // Text-only send — no image or video configured for this org.
      console.log('  send mode: text-only (no image/video configured)');
      await client.sendMessage(peer, { message });
    } else {
      // Send each media item as its OWN message. A mixed photo+video album via
      // messages.SendMultiMedia can fail with MEDIA_EMPTY; sequential single-file
      // sends are reliable. The caption rides on the first item when it fits
      // (<=1024); otherwise the text follows as its own bubble after all media.
      const kinds = `${img ? 'image' : ''}${img && video ? '+' : ''}${video ? 'video' : ''}`;
      console.log(`  send mode: ${mediaPaths.length} media (${kinds})${captionMode ? '+caption' : '+two_bubble'}`);
      for (let i = 0; i < mediaPaths.length; i++) {
        if (captionMode && i === 0) {
          await client.sendFile(peer, { file: mediaPaths[i], caption: message, forceDocument: false, supportsStreaming: true });
        } else {
          await client.sendFile(peer, { file: mediaPaths[i], forceDocument: false, supportsStreaming: true });
        }
      }
      if (!captionMode) {
        try {
          await client.sendMessage(peer, { message });
        } catch (err) {
          const e = err as Error;
          return { ok: false, reason: `media sent, text failed: ${e.message || String(err)}` };
        }
      }
    }

    return { ok: true };
  } catch (err) {
    const e = err as Error;
    const msg = e.message || String(err);
    // A permanently malformed number is distinct from privacy/not-on-Telegram:
    // the server classifies 'invalid (permanent)' as never-retry, the rest as
    // privacy (retried every 60d in case they open up / join Telegram).
    if (/PHONE_NUMBER_INVALID/i.test(msg)) {
      return { ok: false, reason: 'phone number invalid (permanent)' };
    }
    if (/PHONE_NOT_OCCUPIED|USER_NOT_FOUND|PEER_ID_INVALID/i.test(msg)) {
      return { ok: false, reason: 'phone number not on Telegram' };
    }
    return { ok: false, reason: `mtproto exception: ${msg}` };
  } finally {
    for (const p of mediaPaths) {
      await fs.promises.unlink(p).catch(() => {});
    }
  }
}

async function resolvePhoneForIncoming(
  client: TelegramClient,
  userId: bigInt.BigInteger
): Promise<string | null> {
  const cached = peerPhoneByUserId.get(userId.toString());
  if (cached) return cached;

  try {
    const entity = await client.getEntity(userId);
    if (entity instanceof Api.User && entity.phone) {
      const digits = entity.phone.replace(/\D/g, '');
      peerPhoneByUserId.set(userId.toString(), digits);
      return digits;
    }
  } catch (err) {
    console.error('[inbound] getEntity failed for', userId.toString(), (err as Error).message);
  }
  return null;
}

function attachInboundHandler(client: TelegramClient): void {
  if (INBOUND_DISABLED) {
    console.log('Inbound listener disabled by INBOUND_DISABLED env.');
    return;
  }

  client.addEventHandler(async (event: NewMessageEvent) => {
    try {
      const message = event.message;
      // Private chat only — peerId on a 1-on-1 is PeerUser. Group/channel
      // messages have PeerChat / PeerChannel and we ignore them.
      const peer = message.peerId;
      if (!(peer instanceof Api.PeerUser)) return;
      // Outbound messages are filtered by the NewMessage({ incoming: true })
      // subscription, but double-check defensively.
      if (message.out) return;

      const text = message.message || '';
      if (!text.trim()) return;

      const phone = await resolvePhoneForIncoming(client, peer.userId);
      if (!phone) {
        console.log(`[inbound] no phone resolvable for user ${peer.userId.toString()}, skipping`);
        return;
      }

      const messageId = typeof message.id === 'number' ? message.id : Number(message.id);
      const dateSec = typeof message.date === 'number' ? message.date : 0;
      const receivedAt = new Date((dateSec || Math.floor(Date.now() / 1000)) * 1000).toISOString();

      console.log(`[inbound] reply from ${phone} msg=${messageId}: ${text.slice(0, 60)}…`);
      await reportInbound({
        phone,
        telegram_message_id: messageId,
        text,
        received_at: receivedAt,
      });
    } catch (err) {
      console.error('[inbound] handler err', (err as Error).message);
    }
  }, new NewMessage({ incoming: true }));
}

// ---- Main loop ----
async function main(): Promise<void> {
  if (!fs.existsSync(SESSION_PATH)) {
    console.error(`String session missing at ${SESSION_PATH}. Run \`npm run login\` first.`);
    await postAlert('session-expired', `String session missing at ${SESSION_PATH}`);
    process.exit(1);
  }
  const sessionStr = fs.readFileSync(SESSION_PATH, 'utf8').trim();

  console.log(`Worker online. org=${ORG_ID}, Base=${BASE_URL}, daily cap=${DAILY_CAP}, delay=${MIN_DELAY_MS / 1000}-${MAX_DELAY_MS / 1000}s, inbound=${INBOUND_DISABLED ? 'off' : 'realtime'}, id=${WORKER_ID}.`);

  const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, {
    connectionRetries: 5,
  });
  // gramjs logs every reconnect/ping-timeout blip to console at INFO/WARN/ERROR
  // (it already retries these internally) — pure noise on an unstable
  // connection. Real failures still surface: they're thrown exceptions caught
  // and reported by our own code, not dependent on this logger.
  client.setLogLevel(LogLevel.NONE);
  await client.connect();

  // Verify the session is still valid before the loop starts.
  try {
    await client.getMe();
  } catch (err) {
    const e = err as Error;
    console.error('session check failed:', e.message);
    if (isSessionExpiredError(e)) {
      await postAlert('session-expired', e.message);
    }
    process.exit(2);
  }

  attachInboundHandler(client);

  let sentDay = todayKey();

  const heartbeatTimer = setInterval(() => {
    postHeartbeat().catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  await postHeartbeat();

  const bounceTimer = setInterval(() => {
    checkDailyBounce().catch(() => undefined);
  }, SCHEDULE_POLL_INTERVAL_MS);
  checkDailyBounce().catch(() => undefined);

  const stop = async (reason: string, code = 0) => {
    console.log(`Stopping: ${reason}`);
    clearInterval(heartbeatTimer);
    clearInterval(bounceTimer);
    await client.disconnect().catch(() => undefined);
    process.exit(code);
  };

  process.on('SIGINT', () => stop('SIGINT', 0));
  process.on('SIGTERM', () => stop('SIGTERM', 0));

  while (true) {
    const today = todayKey();
    if (today !== sentDay) { sentDay = today; workerState.sentToday = 0; }

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
    if (workerState.deferralPauseUntil) {
      const remainingMs = workerState.deferralPauseUntil.getTime() - Date.now();
      if (remainingMs > 0) {
        console.log(`Deferral backoff active — ~${Math.ceil(remainingMs / 60000)}min remaining. Idle.`);
        await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
        continue;
      }
      console.log('Deferral backoff window elapsed — resuming normal sending.');
      workerState.deferralPauseUntil = null;
    }

    let claimResp: ClaimResponse | null = null;
    try { claimResp = await claim(); } catch { /* transient connection blip — retries next poll */ }

    if (!claimResp || !claimResp.proposal) {
      if (claimResp?.daily_cap_reached) console.log('Server daily cap reached.');
      else if (claimResp?.outside_active_hours) console.log('Outside active-hours window — waiting.');
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const proposal = claimResp.proposal;
    console.log(`→ sending to ${proposal.customer_name || '?'} ${proposal.customer_phone}`);
    let result: { ok: true } | { ok: false; reason: string };
    try {
      result = await withTimeout(
        sendViaMTProto(client, proposal._id, proposal.customer_phone, proposal.message, proposal.customer_name),
        SEND_TIMEOUT_MS,
        'send'
      );
    } catch (err) {
      result = { ok: false as const, reason: `exception: ${(err as Error).message}` };
    }

    if (result.ok) {
      await markSent(proposal._id);
      workerState.sentToday++;
      workerState.lastError = null;
      console.log(`  ✓ sent (${workerState.sentToday}/${DAILY_CAP} today)`);
      if (workerState.sentToday === DAILY_CAP) {
        await postAlert('daily-cap-reached', `${workerState.sentToday}/${DAILY_CAP}`);
      }
    } else {
      await markFailed(proposal._id, result.reason);
      workerState.lastError = result.reason;
      console.log(`  ✗ failed: ${result.reason}`);
      if (isSessionExpiredError(new Error(result.reason))) {
        await postAlert('session-expired', result.reason);
        await stop('Telegram session invalid. Re-run `npm run login`.', 2);
      }
    }

    // Deferral-streak tracking: reset on success or any non-deferred failure,
    // increment only on DEFERRED_IMPORT_REASON specifically so a run of
    // unrelated errors doesn't falsely trip the backoff.
    if (result.ok || result.reason !== DEFERRED_IMPORT_REASON) {
      if (workerState.consecutiveDeferrals > 0) {
        console.log(`  (deferral streak broken at ${workerState.consecutiveDeferrals})`);
      }
      workerState.consecutiveDeferrals = 0;
    } else {
      workerState.consecutiveDeferrals++;
      console.log(`  consecutive deferrals: ${workerState.consecutiveDeferrals}/${DEFERRAL_BACKOFF_THRESHOLD}`);
      if (workerState.consecutiveDeferrals >= DEFERRAL_BACKOFF_THRESHOLD) {
        workerState.deferralPauseUntil = new Date(Date.now() + DEFERRAL_BACKOFF_MS);
        workerState.consecutiveDeferrals = 0;
        console.warn(`Telegram deferred ${DEFERRAL_BACKOFF_THRESHOLD} imports in a row — pausing sends for ${DEFERRAL_BACKOFF_MIN}min (until ${workerState.deferralPauseUntil.toISOString()}) to let the throttle lift.`);
        await postAlert('deferral-backoff', `${DEFERRAL_BACKOFF_THRESHOLD} consecutive deferred imports — pausing ${DEFERRAL_BACKOFF_MIN}min`);
        continue; // skip the normal randomDelay() below — the top-of-loop branch handles the wait
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

// Reject `p` if it doesn't settle within `ms`. Used to bound MTProto sends so a
// stalled Telegram connection can't wedge the main loop. The underlying promise
// keeps running (JS can't cancel it), but the loop moves on and marks the
// proposal failed — a false "failed" is acceptable; a frozen worker is not.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// Only run the worker when executed directly (`npm start` / pm2). Guarding this
// lets check-*.ts harnesses import the pure helpers above without booting a
// Telegram session.
if (require.main === module) {
  main().catch(async (err) => {
    console.error('worker crash:', err);
    try { await postAlert('worker-fatal', (err as Error).message || 'unknown'); } catch {}
    process.exit(1);
  });
}
