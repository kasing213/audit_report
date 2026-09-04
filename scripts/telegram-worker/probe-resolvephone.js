/**
 * READ-ONLY. Does contacts.ResolvePhone reach numbers that contacts.
 * ImportContacts is deferring?
 *
 * The worker resolves a lead by IMPORTING it as a contact and deleting it
 * afterwards — 358 import attempts on this account so far, plus a delete each.
 * That churn is what Telegram appears to be rate-limiting: since 12:05 today
 * every import comes back in `retryContacts` (deferred) rather than resolving.
 *
 * contacts.ResolvePhone asks "who owns this number?" without touching the
 * address book. If it resolves numbers that ImportContacts defers, the fix is
 * to stop importing contacts entirely.
 *
 * Creates nothing, deletes nothing, sends nothing.
 *
 * Usage (from scripts/telegram-worker): node probe-resolvephone.js
 */
require('dotenv').config();
const fs = require('fs');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION_PATH = process.env.STRING_SESSION_PATH || './telegram-string-session.txt';

// Numbers ImportContacts deferred today (retry=1, users=0).
const DEFERRED = ['+85581496675', '+85589338711', '+85510783766', '+855972248585', '+855962816168'];
// Known-good: this account messaged these successfully today.
const CONTROLS = ['+85587878965', '+85586610775'];

async function tryResolve(client, phone) {
  try {
    const res = await client.invoke(new Api.contacts.ResolvePhone({ phone: phone.replace(/^\+/, '') }));
    const user = (res.users || []).find((u) => u instanceof Api.User);
    return user
      ? `RESOLVED    id=${user.id} @${user.username || '-'}`
      : `EMPTY       (no user in response)`;
  } catch (err) {
    return `ERROR       ${err.message}`;
  }
}

(async () => {
  const client = new TelegramClient(
    new StringSession(fs.readFileSync(SESSION_PATH, 'utf8').trim()), API_ID, API_HASH, { connectionRetries: 3 });
  await client.connect();

  console.log('=== CONTROLS (ImportContacts resolves these) ===');
  for (const p of CONTROLS) console.log(`${p.padEnd(16)} ${await tryResolve(client, p)}`);

  console.log('\n=== DEFERRED by ImportContacts (retry=1) ===');
  for (const p of DEFERRED) console.log(`${p.padEnd(16)} ${await tryResolve(client, p)}`);

  await client.disconnect();
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
