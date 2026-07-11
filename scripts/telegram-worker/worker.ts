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
import { CustomFile } from 'telegram/client/uploads';

dotenv.config();

// ---- Config ----
const BASE_URL = must('BASE_URL');
const AGENT_TOKEN = resolveAgentToken();
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION_PATH = process.env.STRING_SESSION_PATH || './telegram-string-session.txt';
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
const INBOUND_DISABLED = String(process.env.INBOUND_DISABLED || '').toLowerCase() === 'true';
const WORKER_ID = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
const CLAIM_URL = `${BASE_URL}/crm/api/outreach/claim`;
const STATUS_URL = `${BASE_URL}/crm/api/outreach/worker-status`;
const HEARTBEAT_URL = `${BASE_URL}/crm/api/outreach/worker-heartbeat`;
const ALERT_URL = `${BASE_URL}/crm/api/outreach/worker-alert`;
const REPORT_INBOUND_URL = `${BASE_URL}/crm/api/outreach/report-inbound`;
const MARK_SENT_URL = (id: string) => `${BASE_URL}/crm/api/outreach/${id}/mark-sent`;
const MARK_FAILED_URL = (id: string) => `${BASE_URL}/crm/api/outreach/${id}/mark-failed`;
const EFFECTIVE_IMAGE_URL = (id: string) => `${BASE_URL}/crm/api/outreach/${id}/effective-image`;
const DEFAULT_VIDEO_URL = `${BASE_URL}/crm/api/outreach/default-video-url`;

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

async function fetchEffectiveImage(proposalId: string): Promise<{ buffer: Buffer; filename: string; kind: string } | null> {
  try {
    const resp = await authedFetch(EFFECTIVE_IMAGE_URL(proposalId));
    if (!resp.ok) {
      console.error(`effective-image ${resp.status}: ${await resp.text().catch(() => '')}`);
      return null;
    }
    const arr = await resp.arrayBuffer();
    const buffer = Buffer.from(arr);
    const rawFilename = resp.headers.get('x-filename') || 'brand.jpg';
    const filename = (() => { try { return decodeURIComponent(rawFilename); } catch { return rawFilename; } })();
    const kind = resp.headers.get('x-image-kind') || 'unknown';
    return { buffer, filename, kind };
  } catch (err) {
    console.error('effective-image fetch err', err);
    return null;
  }
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

// Ask the server for a presigned URL to the default marketing video, download
// the bytes, and stage them in a temp file. Returns null when no video is
// available to send — either none is set (server 404) or R2 storage isn't
// configured yet (server 503) — the signal to fall back to an image-only
// send. Any other failure throws, which the send's catch turns into a
// marked-failed proposal (never a freeze — withTimeout bounds the whole send).
async function fetchDefaultVideo(): Promise<{ path: string; mime: string } | null> {
  const resp = await authedFetch(DEFAULT_VIDEO_URL);
  if (resp.status === 404) return null;
  if (resp.status === 503) {
    console.log('  video: R2 not configured on server — sending image-only');
    return null;
  }
  if (!resp.ok) {
    throw new Error(`default-video-url ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  const meta = (await resp.json()) as { url: string; mime_type?: string };
  const dl = await fetch(meta.url); // presigned R2 URL — no auth header
  if (!dl.ok) throw new Error(`video download failed: HTTP ${dl.status}`);
  const bytes = Buffer.from(await dl.arrayBuffer());
  const filePath = await writeTemp(bytes, 'mp4'); // upload endpoint accepts mp4 only
  console.log(`  video: ${bytes.length}B staged at ${path.basename(filePath)}`);
  return { path: filePath, mime: meta.mime_type || 'video/mp4' };
}

// ---- Telegram (MTProto via gramjs) ----
function isSessionExpiredError(err: Error): boolean {
  const m = err.message || '';
  return /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_INVALID/i.test(m);
}

// Resolve a raw phone number to a Telegram user. gramjs's getEntity(phone)
// only works for numbers already in the account's contacts/dialogs; a fresh
// lead's number throws "Cannot find any entity corresponding to …". The
// documented path for an arbitrary number is contacts.ImportContacts, which
// returns the user IFF the number is on Telegram AND their privacy settings
// permit phone lookup. Returns null (not throwing) when unreachable.
async function importPhoneAsPeer(
  client: TelegramClient,
  phoneDigits: string,
  firstName: string
): Promise<Api.User | null> {
  const imported = await client.invoke(new Api.contacts.ImportContacts({
    contacts: [new Api.InputPhoneContact({
      clientId: bigInt(0),
      phone: `+${phoneDigits}`,
      firstName: firstName || 'Lead',
      lastName: '',
    })],
  }));
  const user = imported.users.find((u): u is Api.User => u instanceof Api.User);
  return user || null;
}

// Remove a contact we imported only to reach it, so the account's address
// book doesn't balloon with every lead. Best-effort — a failure here never
// fails the send (the message is already delivered by the time we call this).
async function deleteImportedContact(client: TelegramClient, user: Api.User): Promise<void> {
  try {
    await client.invoke(new Api.contacts.DeleteContacts({
      id: [new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt(0) })],
    }));
  } catch (err) {
    console.error('  contact cleanup failed:', (err as Error).message);
  }
}

async function sendViaMTProto(
  client: TelegramClient,
  proposalId: string,
  phone: string,
  message: string,
  customerName: string | null
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const phoneDigits = phone.replace(/\D/g, '');

  // Fetch the image first; mandatory per spec.
  const img = await fetchEffectiveImage(proposalId);
  if (!img) {
    await postAlert('image-missing', `effective-image fetch failed for proposal ${proposalId}`);
    return { ok: false, reason: 'image fetch failed (no default or worker auth issue)' };
  }
  console.log(`  image: ${img.kind} ${img.filename} ${img.buffer.length}B`);

  let importedPeer: Api.User | null = null;
  let imageTmpPath: string | null = null;
  let videoTmpPath: string | null = null;
  try {
    importedPeer = await importPhoneAsPeer(client, phoneDigits, customerName || '');
    if (!importedPeer) {
      return { ok: false, reason: 'phone number not on Telegram (or hidden by privacy)' };
    }
    const peer = importedPeer;

    // Cache the phone now, before any cleanup, so inbound replies from this
    // user still resolve to a phone even after we delete the contact below.
    peerPhoneByUserId.set(peer.id.toString(), phoneDigits);

    // Pull the default marketing video (null when none set → image-only send).
    // Fetched after the peer resolves so unreachable numbers don't cost a 50MB
    // download.
    const video = await fetchDefaultVideo();
    const captionMode = message.length <= 1024;

    if (video) {
      // Album: image (legitimacy proof) + marketing video, sent as one Telegram
      // media group. Both staged as temp files so gramjs streams from disk.
      videoTmpPath = video.path;
      imageTmpPath = await writeTemp(img.buffer, img.filename.split('.').pop() || 'jpg');
      const album = [imageTmpPath, videoTmpPath];
      if (captionMode) {
        console.log(`  send mode: album+caption (img+video, msg=${message.length}B <= 1024)`);
        await client.sendFile(peer, { file: album, caption: message, forceDocument: false, supportsStreaming: true });
      } else {
        console.log(`  send mode: album+two_bubble (img+video, msg=${message.length}B > 1024)`);
        await client.sendFile(peer, { file: album, forceDocument: false, supportsStreaming: true });
        try {
          await client.sendMessage(peer, { message });
        } catch (err) {
          const e = err as Error;
          return { ok: false, reason: `album sent, text failed: ${e.message || String(err)}` };
        }
      }
    } else {
      // No default video set — image-only path (unchanged behavior).
      const file = new CustomFile(img.filename, img.buffer.length, '', img.buffer);
      if (captionMode) {
        console.log(`  send mode: caption (msg=${message.length}B <= 1024)`);
        await client.sendFile(peer, { file, caption: message });
      } else {
        console.log(`  send mode: two_bubble (msg=${message.length}B > 1024)`);
        await client.sendFile(peer, { file });
        try {
          await client.sendMessage(peer, { message });
        } catch (err) {
          const e = err as Error;
          return { ok: false, reason: `image sent, text failed: ${e.message || String(err)}` };
        }
      }
    }

    return { ok: true };
  } catch (err) {
    const e = err as Error;
    const msg = e.message || String(err);
    if (/PHONE_NOT_OCCUPIED|USER_NOT_FOUND|PHONE_NUMBER_INVALID|PEER_ID_INVALID/i.test(msg)) {
      return { ok: false, reason: 'phone number not on Telegram' };
    }
    return { ok: false, reason: `mtproto exception: ${msg}` };
  } finally {
    if (importedPeer) await deleteImportedContact(client, importedPeer);
    if (imageTmpPath) await fs.promises.unlink(imageTmpPath).catch(() => {});
    if (videoTmpPath) await fs.promises.unlink(videoTmpPath).catch(() => {});
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

  console.log(`Worker online. Base=${BASE_URL}, daily cap=${DAILY_CAP}, delay=${MIN_DELAY_MS / 1000}-${MAX_DELAY_MS / 1000}s, inbound=${INBOUND_DISABLED ? 'off' : 'realtime'}, id=${WORKER_ID}.`);

  const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, {
    connectionRetries: 5,
  });
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

  const stop = async (reason: string, code = 0) => {
    console.log(`Stopping: ${reason}`);
    clearInterval(heartbeatTimer);
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

    let claimResp: ClaimResponse | null = null;
    try { claimResp = await claim(); } catch (e) { console.error('claim err', e); }

    if (!claimResp || !claimResp.proposal) {
      if (claimResp?.daily_cap_reached) console.log('Server daily cap reached.');
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
    } else {
      await markFailed(proposal._id, result.reason);
      workerState.lastError = result.reason;
      console.log(`  ✗ failed: ${result.reason}`);
      if (isSessionExpiredError(new Error(result.reason))) {
        await postAlert('session-expired', result.reason);
        await stop('Telegram session invalid. Re-run `npm run login`.', 2);
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

main().catch(async (err) => {
  console.error('worker crash:', err);
  try { await postAlert('worker-fatal', (err as Error).message || 'unknown'); } catch {}
  process.exit(1);
});
