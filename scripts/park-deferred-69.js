/**
 * Backfill for the 2026-08-01 outreach-failure-taxonomy spec: re-flags the
 * 69 suppressions that unblock-deferred-privacy.js resolved earlier today.
 *
 * Those 69 were wrongly recorded PERMANENT ('privacy', next_retry_at=null)
 * during the 2026-07-30..08-01 contact-import throttle, then cleared to
 * status='resolved' by unblock-deferred-privacy.js so they'd re-enter the
 * pool. Now that 'deferred' exists as its own kind, the correct record for
 * "Telegram deferred the import, not proof the number is dead" is 'deferred'
 * on a temporary DEFERRED_COOLDOWN_DAYS clock — not silently resolved (which
 * looks, on the Failed-numbers page, like nothing ever happened) and not
 * re-opened as permanent 'privacy' either.
 *
 * They are set aside, not written off: if the throttle theory holds, the next
 * attempt reaches them and recordContacted() overwrites this record; if any
 * genuinely is unreachable, the next attempt re-suppresses it correctly under
 * the fixed classifyFailure().
 *
 * Targets exactly the population unblock-deferred-privacy.js touched: privacy
 * suppressions, now status='resolved', last_failed_at on/after the same
 * throttle-window CUTOFF. unblock-deferred-privacy.js is the only writer of
 * resolved() in this codebase (grepped — no other caller), so this query
 * uniquely identifies its output; nothing else in the system resolves a
 * privacy suppression.
 *
 *   node scripts/park-deferred-69.js            # dry run, prints only
 *   node scripts/park-deferred-69.js --apply    # performs the change
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

// Same throttle-window cutoff unblock-deferred-privacy.js used, so this query
// selects exactly its output population.
const CUTOFF = new Date('2026-07-30T00:00:00Z');
const APPLY = process.argv.includes('--apply');
const DAY_MS = 24 * 60 * 60 * 1000;

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
    status: 'resolved',
    last_failed_at: { $gte: CUTOFF },
  };
  const victims = await db.collection('outreach_suppressions').find(query).sort({ resolved_at: 1 }).toArray();

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — privacy suppressions resolved by unblock-deferred-privacy.js, re-flagging as deferred`);
  console.log(`matched: ${victims.length}\n`);
  victims.forEach((v) => console.log(
    `${new Date(v.last_failed_at).toISOString().slice(0, 16)}  ${String(v.customer_phone).padEnd(15)} ` +
    `${String(v.customer_name || '-').slice(0, 22).padEnd(22)} org=${v.org_id} resolved_at=${v.resolved_at ? new Date(v.resolved_at).toISOString().slice(0, 16) : '-'}`));

  // Sanity: none of these should have been contacted since being resolved. A
  // sent proposal here would mean recordContacted() should have already
  // overwritten failure_kind to 'contacted' (see recordContacted, which
  // updates unconditionally regardless of prior status) — so seeing one still
  // 'privacy'/'resolved' AND sent means something bypassed that path. Refuse
  // rather than clobber a real contact with a 30-day park.
  const phones = victims.map((v) => v.customer_phone);
  const everSent = await db.collection('outreach_proposals')
    .countDocuments({ customer_phone: { $in: phones }, status: 'sent' });
  console.log(`\nsanity: proposals ever SENT to these phones = ${everSent} (expected 0)`);
  if (everSent > 0) {
    console.error('Refusing: some of these were actually contacted. Re-check the query.');
    await client.close();
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to re-flag these suppressions as deferred.');
    await client.close();
    return;
  }

  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const { deferredCooldownDays } = require('../dist/outreach/outreach-suppression-repository');
  const cooldownDays = deferredCooldownDays();

  let done = 0;
  const now = new Date();
  const eligibleAgainAt = new Date(now.getTime() + cooldownDays * DAY_MS);
  for (const v of victims) {
    await db.collection('outreach_suppressions').updateOne(
      { _id: v._id },
      {
        $set: {
          failure_kind: 'deferred',
          status: 'active',
          eligible_again_at: eligibleAgainAt,
          next_retry_at: eligibleAgainAt,
          resolved_at: null,
          updated_at: now,
        },
      }
    );
    done++;
  }
  console.log(`\nre-flagged ${done} suppressions as deferred, eligible_again_at = ${eligibleAgainAt.toISOString()} (+${cooldownDays}d).`);

  const left = await db.collection('outreach_suppressions').countDocuments(query);
  const stillDeferredParked = await db.collection('outreach_suppressions').countDocuments({
    failure_kind: 'deferred', eligible_again_at: { $gt: new Date() },
  });
  console.log(`still matching the pre-backfill query (privacy/resolved): ${left} (expected 0)`);
  console.log(`total phones currently parked under an active deferred cooldown: ${stillDeferredParked}`);

  await client.close();
  await DatabaseConnection.getInstance().disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
