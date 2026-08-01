/**
 * Recovery for the 2026-07-30..08-01 contact-import throttle.
 *
 * During that window Telegram returned these leads in `retryContacts` — it
 * deferred the import rather than answering "no such user". The worker read
 * only `users[]`, reported "not on Telegram (or hidden by privacy)", and the
 * server wrote a PERMANENT privacy suppression (next_retry_at=null). Proof the
 * numbers are fine: diagnose-resolve.js shows imported=0 retry=1 users=0 for
 * them, while numbers sent to successfully the same morning return retry=0.
 *
 * These leads were never contacted — nothing was consumed but the blacklist
 * entry — so resolving the suppression returns them to the pool. If any really
 * is unreachable, the next attempt re-suppresses it correctly under the fixed
 * classifier (worker.ts DEFERRED_IMPORT_REASON vs ABSENT_PEER_REASON).
 *
 * Uses the repository's own resolve() so the record is kept and audited
 * (status='resolved', resolved_at set) rather than deleted.
 *
 *   node scripts/unblock-deferred-privacy.js            # dry run, prints only
 *   node scripts/unblock-deferred-privacy.js --apply    # performs the change
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

// Throttle window opened on 07-30: first-attempt failure rate jumped 32% -> 68%
// that day, then 89% and 97%. Suppressions written before this are left alone.
const CUTOFF = new Date('2026-07-30T00:00:00Z');
const APPLY = process.argv.includes('--apply');

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  if (db.databaseName !== 'Audit') {
    console.error(`Expected production database "Audit", got "${db.databaseName}" — aborting.`);
    await client.close();
    process.exit(1);
  }

  const query = {
    failure_kind: 'privacy',
    status: { $in: ['active', 'exhausted'] },
    last_failed_at: { $gte: CUTOFF },
  };
  const victims = await db.collection('outreach_suppressions').find(query).sort({ last_failed_at: 1 }).toArray();

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — privacy suppressions recorded on/after ${CUTOFF.toISOString().slice(0, 10)}`);
  console.log(`matched: ${victims.length}\n`);
  victims.forEach((v) => console.log(
    `${new Date(v.last_failed_at).toISOString().slice(0, 16)}  ${String(v.customer_phone).padEnd(15)} ` +
    `${String(v.customer_name || '-').slice(0, 22).padEnd(22)} org=${v.org_id} status=${v.status}`));

  // Sanity: none of these should have been contacted. A sent proposal here
  // would mean the cutoff is wrong, so refuse rather than un-suppress blindly.
  const phones = victims.map((v) => v.customer_phone);
  const everSent = await db.collection('outreach_proposals')
    .countDocuments({ customer_phone: { $in: phones }, status: 'sent' });
  console.log(`\nsanity: proposals ever SENT to these phones = ${everSent} (expected 0)`);
  if (everSent > 0) {
    console.error('Refusing: some of these were actually contacted. Re-check the cutoff.');
    await client.close();
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to resolve these suppressions.');
    await client.close();
    return;
  }

  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const { OutreachSuppressionRepository } = require('../dist/outreach/outreach-suppression-repository');
  const repo = new OutreachSuppressionRepository();

  let done = 0;
  for (const v of victims) {
    await repo.resolve(v.customer_phone, v.org_id);
    done++;
  }
  console.log(`\nresolved ${done} suppressions.`);

  const left = await db.collection('outreach_suppressions').countDocuments(query);
  const blocking = await db.collection('outreach_suppressions').countDocuments({
    failure_kind: { $in: ['privacy', 'invalid'] }, status: { $in: ['active', 'exhausted'] },
  });
  console.log(`still matching the window: ${left} (expected 0)`);
  console.log(`total phones still permanently blocked: ${blocking}`);

  await client.close();
  await DatabaseConnection.getInstance().disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
