// READ-ONLY. Where do outreach targets come from: QuickBook/CSV import, or
// manually-decoded Telegram entries? And do the two overlap on the same phone?
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const leads = db.collection('leads_events');

  console.log('=== leads_events by source.model ===');
  const bySource = await leads.aggregate([
    { $group: { _id: '$source.model', n: { $sum: 1 } } }, { $sort: { n: -1 } },
  ]).toArray();
  bySource.forEach(r => console.log(`${String(r._id).padEnd(20)} ${r.n}`));

  console.log('\n=== distinct phones per source ===');
  const models = bySource.map(r => r._id);
  const phonesBy = {};
  for (const m of models) {
    const p = (await leads.distinct('customer.phone', { 'source.model': m })).filter(Boolean);
    phonesBy[m] = new Set(p);
    console.log(`${String(m).padEnd(20)} ${p.length}`);
  }

  console.log('\n=== phone overlap between sources ===');
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const a = phonesBy[models[i]], b = phonesBy[models[j]];
      const shared = [...a].filter(p => b.has(p));
      console.log(`${models[i]} ∩ ${models[j]} : ${shared.length}`);
      shared.slice(0, 10).forEach(p => console.log(`    ${p}`));
    }
  }

  console.log('\n=== which source did OUTREACH actually target? ===');
  const proposed = await db.collection('outreach_proposals').distinct('customer_phone');
  for (const m of models) {
    const hit = proposed.filter(p => phonesBy[m].has(p)).length;
    console.log(`${String(m).padEnd(20)} ${hit} of ${proposed.length} proposed phones`);
  }
  const unknown = proposed.filter(p => !models.some(m => phonesBy[m].has(p))).length;
  console.log(`(matched no source)  ${unknown}`);

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
