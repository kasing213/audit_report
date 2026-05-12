// Verify whether the Telegram bulk-confirm tap actually persisted records.
// Run with: railway run node scripts/check-bulk-confirm.js
// (or: node scripts/check-bulk-confirm.js with DATABASE_URL in the env)

const { MongoClient } = require('mongodb');

const TARGET_PHONES = ['+85570597666', '+85586226225'];
const TARGET_DATE = '2026-03-01';

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set; run via `railway run node scripts/check-bulk-confirm.js`');
    process.exit(1);
  }
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();

  console.log('DB name:', db.databaseName);

  const eventsByPhone = await db.collection('leads_events')
    .find({ 'customer.phone': { $in: TARGET_PHONES } })
    .sort({ created_at: -1 })
    .toArray();

  const eventsByDate = await db.collection('leads_events')
    .find({ date: TARGET_DATE })
    .sort({ created_at: -1 })
    .limit(20)
    .toArray();

  const latestBulkTelegram = await db.collection('leads_events')
    .find({ 'source.model': 'bulk-telegram' })
    .sort({ created_at: -1 })
    .limit(10)
    .toArray();

  const latestAudit = await db.collection('audit_logs')
    .find({ action: 'bulk-telegram' })
    .sort({ timestamp: -1 })
    .limit(5)
    .toArray();

  const latestSummaries = await db.collection('daily_summaries')
    .find({ date: TARGET_DATE })
    .sort({ created_at: -1 })
    .limit(5)
    .toArray();

  console.log('\n=== counts ===');
  console.log(JSON.stringify({
    events_for_target_phones: eventsByPhone.length,
    events_for_target_date: eventsByDate.length,
    bulk_telegram_events_latest10: latestBulkTelegram.length,
    bulk_telegram_audits_latest5: latestAudit.length,
    summaries_for_target_date: latestSummaries.length
  }, null, 2));

  const slim = (e) => ({
    _id: e._id,
    date: e.date,
    follower: e.follower,
    page: e.page,
    customer_name: e.customer?.name,
    customer_phone: e.customer?.phone,
    reason_code: e.reason_code,
    promise_date: e.promise_date,
    deleted: e.deleted ?? false,
    source: e.source,
    created_at: e.created_at
  });

  console.log('\n=== events matching target phones ===');
  console.log(JSON.stringify(eventsByPhone.map(slim), null, 2));

  console.log('\n=== events with date=' + TARGET_DATE + ' (first 20) ===');
  console.log(JSON.stringify(eventsByDate.map(slim), null, 2));

  console.log('\n=== latest 10 bulk-telegram events ===');
  console.log(JSON.stringify(latestBulkTelegram.map(slim), null, 2));

  console.log('\n=== latest 5 audit_logs (action=bulk-telegram) ===');
  console.log(JSON.stringify(latestAudit.map(a => ({
    _id: a._id, action: a.action, timestamp: a.timestamp,
    user_id: a.user_id, username: a.username,
    parsed_result: a.parsed_result,
    original_message: a.original_message
  })), null, 2));

  console.log('\n=== daily_summaries for date=' + TARGET_DATE + ' ===');
  console.log(JSON.stringify(latestSummaries.map(s => ({
    _id: s._id, date: s.date, follower: s.follower, page: s.page,
    counters: s.counters, source: s.source, created_at: s.created_at
  })), null, 2));

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
