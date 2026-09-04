require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing');
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();
  const col = db.collection('outreach_proposals');

  const phones = ['+85570597666', '+85586226225'];
  const newCreated = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);

  const before = await col.find({
    customer_phone: { $in: phones },
    status: { $in: ['pending', 'approved', 'in_flight', 'sent'] },
  }).project({ _id: 1, customer_phone: 1, status: 1, created_at: 1 }).toArray();

  console.log('Blocking rows before backdate:', before);

  const result = await col.updateMany(
    {
      customer_phone: { $in: phones },
      status: { $in: ['pending', 'approved', 'in_flight', 'sent'] },
    },
    { $set: { created_at: newCreated } }
  );

  console.log('Matched:', result.matchedCount, 'Modified:', result.modifiedCount);
  console.log('New created_at:', newCreated.toISOString());

  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
