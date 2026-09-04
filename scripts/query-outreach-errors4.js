// Discriminator: is "privacy" real, or is the resolver producing false negatives?
// A phone that was successfully SENT earlier but reports "not on Telegram" now
// cannot genuinely be off Telegram — that would be proof of a resolver problem.
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const prop = db.collection('outreach_proposals');
  const sup = db.collection('outreach_suppressions');

  const privPhones = (await sup.find({ failure_kind: 'privacy' }).toArray()).map(r => r.customer_phone);
  console.log(`privacy-suppressed phones: ${privPhones.length}`);

  // A) privacy-suppressed phones that ALSO have a successful send in history
  const contradiction = await prop.find({ customer_phone: { $in: privPhones }, status: 'sent' }).toArray();
  console.log(`\n=== CONTRADICTION: privacy-suppressed BUT previously sent OK: ${contradiction.length} ===`);
  contradiction.forEach(r => console.log(
    `${String(r.customer_phone).padEnd(15)} sent_at=${r.sent_at ? new Date(r.sent_at).toISOString().slice(0,16) : '-'} ` +
    `${String(r.customer_name||'-').slice(0,20)}`));

  // B) phones with BOTH a privacy failure and a sent proposal, ordered — did privacy come after success?
  console.log('\n=== per-phone attempt history for the 15 most recent privacy failures ===');
  const recent = await sup.find({ failure_kind: 'privacy' }).sort({ last_failed_at: -1 }).limit(15).toArray();
  for (const s of recent) {
    const hist = await prop.find({ customer_phone: s.customer_phone })
      .sort({ created_at: 1 }).project({ status: 1, created_at: 1, sent_at: 1, failed_reason: 1 }).toArray();
    console.log(`\n${s.customer_phone}  (${s.customer_name || '-'})  attempts_field=${s.attempts ?? '-'}`);
    hist.forEach(h => console.log(
      `   ${new Date(h.created_at).toISOString().slice(0,10)}  ${String(h.status).padEnd(9)} ${h.failed_reason || (h.sent_at ? 'sent ' + new Date(h.sent_at).toISOString().slice(0,16) : '')}`));
  }

  // C) how many distinct phones have EVER been attempted, and the pool left
  const attempted = await prop.distinct('customer_phone');
  const poolAll = await db.collection('leads_events').distinct('customer.phone');
  const pool = poolAll.filter(Boolean);
  const supAll = await sup.distinct('customer_phone');
  console.log(`\n=== pool burn-down ===`);
  console.log(`distinct phones in leads_events : ${pool.length}`);
  console.log(`distinct phones ever proposed   : ${attempted.length}`);
  console.log(`distinct phones in suppressions : ${supAll.length}`);
  console.log(`never attempted                 : ${pool.filter(p => !attempted.includes(p)).length}`);

  // D) daily FIRST-ATTEMPT success rate — controls for pool burn-down.
  // Only counts proposals for phones with no prior proposal.
  console.log('\n=== first-attempt-only outcome by day (controls for pool burn-down) ===');
  const all = await prop.find({}).sort({ created_at: 1 })
    .project({ customer_phone: 1, status: 1, created_at: 1 }).toArray();
  const seen = new Set(); const firstBy = {};
  for (const p of all) {
    if (seen.has(p.customer_phone)) continue;
    seen.add(p.customer_phone);
    const d = new Date(p.created_at).toISOString().slice(0, 10);
    (firstBy[d] ||= { sent: 0, failed: 0, other: 0 });
    if (p.status === 'sent') firstBy[d].sent++;
    else if (p.status === 'failed') firstBy[d].failed++;
    else firstBy[d].other++;
  }
  console.log('date         sent  failed  fail%   (first attempt for that phone only)');
  for (const [d, v] of Object.entries(firstBy)) {
    const t = v.sent + v.failed;
    console.log(`${d}  ${String(v.sent).padStart(4)}  ${String(v.failed).padStart(6)}   ${t ? Math.round(100*v.failed/t) : 0}%`);
  }

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
