/**
 * READ-ONLY. Ground-truth reachability via contacts.ResolvePhone, which
 * answers "is this number registered on Telegram?" without touching the
 * address book and without the contact-import quota.
 *
 * Samples three cohorts:
 *   sent      - proposals that were delivered (must resolve; sanity check)
 *   recovered - the 69 privacy suppressions resolved by unblock-deferred-privacy.js
 *   fresh     - pool numbers never attempted
 *
 * PHONE_NOT_OCCUPIED = genuinely not on Telegram (permanent).
 * A resolve = reachable, so an ImportContacts deferral for it was a real throttle.
 *
 * Usage (from scripts/telegram-worker): node audit-reachability.js [perCohort]
 */
const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const fs = require('fs');
const { MongoClient } = require('mongodb');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION_PATH = process.env.STRING_SESSION_PATH || './telegram-string-session.txt';
const PER_COHORT = parseInt(process.argv[2] || '8', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function classify(client, phone) {
  try {
    const res = await client.invoke(new Api.contacts.ResolvePhone({ phone: phone.replace(/^\+/, '') }));
    return (res.users || []).some((u) => u instanceof Api.User) ? 'ON_TELEGRAM' : 'EMPTY';
  } catch (err) {
    const m = err.message || '';
    if (/PHONE_NOT_OCCUPIED/.test(m)) return 'NOT_REGISTERED';
    if (/FLOOD_WAIT/.test(m)) return `FLOOD(${m})`;
    return `ERR(${m.slice(0, 40)})`;
  }
}

(async () => {
  const mongo = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await mongo.connect();
  const db = mongo.db();

  const sent = await db.collection('outreach_proposals').distinct('customer_phone', { status: 'sent' });
  const recovered = (await db.collection('outreach_suppressions')
    .find({ failure_kind: 'privacy', status: 'resolved' }).toArray()).map((r) => r.customer_phone);
  const attempted = new Set(await db.collection('outreach_proposals').distinct('customer_phone'));
  const suppressed = new Set(await db.collection('outreach_suppressions').distinct('customer_phone'));
  const fresh = (await db.collection('leads_events').distinct('customer.phone'))
    .filter((p) => p && !attempted.has(p) && !suppressed.has(p));
  await mongo.close();

  const cohorts = {
    sent: sent.slice(0, PER_COHORT),
    recovered: recovered.slice(0, PER_COHORT),
    fresh: fresh.slice(0, PER_COHORT),
  };

  const client = new TelegramClient(
    new StringSession(fs.readFileSync(SESSION_PATH, 'utf8').trim()), API_ID, API_HASH, { connectionRetries: 3 });
  await client.connect();

  const totals = {};
  for (const [name, phones] of Object.entries(cohorts)) {
    console.log(`\n=== ${name} (n=${phones.length}) ===`);
    const tally = {};
    for (const p of phones) {
      const verdict = await classify(client, p);
      tally[verdict.split('(')[0]] = (tally[verdict.split('(')[0]] || 0) + 1;
      console.log(`  ${String(p).padEnd(16)} ${verdict}`);
      await sleep(1500); // be gentle; ResolvePhone has its own flood limits
    }
    totals[name] = tally;
  }

  console.log('\n=== summary ===');
  for (const [name, tally] of Object.entries(totals)) {
    console.log(`${name.padEnd(11)} ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }

  await client.disconnect();
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
