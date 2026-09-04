// Read-only snapshot of bulk-entry writes. Run with `railway run node scripts/query-bulk.js`.
const { MongoClient } = require('mongodb');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set; invoke via `railway run node scripts/query-bulk.js`');
    process.exit(1);
  }
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();

  const events = await db.collection('leads_events')
    .find({ 'source.model': 'bulk-paste' })
    .sort({ created_at: -1 })
    .limit(5)
    .toArray();

  const summaries = await db.collection('daily_summaries')
    .find({})
    .sort({ created_at: -1 })
    .limit(3)
    .toArray();

  const audits = await db.collection('audit_logs')
    .find({ action: 'bulk-data-entry' })
    .sort({ timestamp: -1 })
    .limit(3)
    .toArray();

  const eventsTotal = await db.collection('leads_events').countDocuments({ 'source.model': 'bulk-paste' });
  const summariesTotal = await db.collection('daily_summaries').countDocuments({});
  const auditsTotal = await db.collection('audit_logs').countDocuments({ action: 'bulk-data-entry' });

  const redactPhone = (p) => typeof p === 'string' && p.length > 4 ? `***${p.slice(-4)}` : p;
  const redactName = (n) => typeof n === 'string' && n.length ? `${n[0]}***` : n;
  const redactNote = (n) => typeof n === 'string' ? n.replace(/\+?\d[\d\s\-()]{6,}/g, '[phone]') : n;
  const redactEvent = (e) => ({
    _id: e._id,
    date: e.date,
    follower: e.follower,
    page: e.page,
    customer_name: redactName(e.customer_name),
    customer_phone: redactPhone(e.customer_phone),
    reason_code: e.reason_code,
    note: redactNote(e.note),
    promise_date: e.promise_date,
    source: e.source,
    created_at: e.created_at
  });

  console.log('=== counts ===');
  console.log(JSON.stringify({ bulk_events: eventsTotal, daily_summaries: summariesTotal, bulk_audits: auditsTotal }, null, 2));
  console.log('\n=== leads_events (source.model=bulk-paste, latest 5, PII redacted) ===');
  console.log(JSON.stringify(events.map(redactEvent), null, 2));
  console.log('\n=== daily_summaries (latest 3, raw_text omitted, counters visible) ===');
  console.log(JSON.stringify(summaries.map(s => ({
    _id: s._id, date: s.date, follower: s.follower, page: s.page,
    counters: s.counters, source: s.source, created_at: s.created_at,
    raw_text_chars: typeof s.raw_text === 'string' ? s.raw_text.length : null
  })), null, 2));
  console.log('\n=== audit_logs (action=bulk-data-entry, latest 3) ===');
  console.log(JSON.stringify(audits.map(a => ({
    _id: a._id, action: a.action, timestamp: a.timestamp,
    parsed_result: a.parsed_result, user_id: a.user_id
  })), null, 2));

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
