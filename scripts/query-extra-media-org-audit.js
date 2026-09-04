require('dotenv').config();
const { MongoClient } = require('mongodb');
(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const images = db.collection('outreach_images');
  const videos = db.collection('outreach_media');

  console.log('=== outreach_images: kind=extra, grouped by org_id/uploaded_by ===');
  const imgExtras = await images.aggregate([
    { $match: { kind: 'extra' } },
    { $project: { org_id: 1, uploaded_by: 1, uploaded_at: 1, filename: 1, size_bytes: 1 } },
    { $sort: { uploaded_at: 1 } },
  ]).toArray();
  imgExtras.forEach(d => console.log(
    `${String(d._id).padEnd(26)} org=${String(d.org_id).padEnd(10)} by=${String(d.uploaded_by).padEnd(12)} at=${d.uploaded_at?.toISOString?.() || d.uploaded_at} file=${d.filename}`
  ));

  console.log('\n=== outreach_media extras (video), grouped by org_id/uploaded_by ===');
  const vidExtras = await videos.aggregate([
    { $match: { org_id: { $exists: true } } },
    { $project: { org_id: 1, uploaded_by: 1, uploaded_at: 1, filename: 1, size_bytes: 1 } },
    { $sort: { uploaded_at: 1 } },
  ]).toArray();
  vidExtras.forEach(d => console.log(
    `${String(d._id).padEnd(26)} org=${String(d.org_id).padEnd(10)} by=${String(d.uploaded_by).padEnd(12)} at=${d.uploaded_at?.toISOString?.() || d.uploaded_at} file=${d.filename}`
  ));

  console.log('\n=== primary default images (non-extra), by org ===');
  const primaries = await images.find({ kind: { $ne: 'extra' } }).project({ org_id: 1, uploaded_by: 1, uploaded_at: 1, filename: 1 }).toArray();
  primaries.forEach(d => console.log(`_id=${d._id} org=${d.org_id ?? 'null(legacy=company)'} by=${d.uploaded_by} at=${d.uploaded_at?.toISOString?.() || d.uploaded_at} file=${d.filename}`));

  console.log('\n=== primary default videos (non-extra), by org ===');
  const primaryVids = await videos.find({ org_id: { $exists: false } }).project({ uploaded_by: 1, uploaded_at: 1, filename: 1 }).toArray();
  primaryVids.forEach(d => console.log(`_id=${d._id} by=${d.uploaded_by} at=${d.uploaded_at?.toISOString?.() || d.uploaded_at} file=${d.filename}`));

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
