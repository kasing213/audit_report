// One-shot cleanup of test data after the outreach-image-attachment session.
//
// Default mode: dry-run — prints counts of what WOULD be deleted, deletes nothing.
// Pass `--confirm` to actually delete.
//
// Usage:
//   railway run node scripts/cleanup-test-data.js              # dry-run
//   railway run node scripts/cleanup-test-data.js --confirm    # delete
//
// Scope (matches the user-confirmed plan in conversation):
//   - leads_events:        customer.name matches /^test\d+$/i
//   - outreach_proposals:  ALL (feature just shipped, no prod proposals exist yet)
//   - outreach_images:     kind: 'proposal_custom' (orphaned after proposals wipe;
//                          the _id: 'default' brand image is kept)
//   - inbound_messages:    phone in test phones
//
// Things deliberately untouched:
//   - audit_logs, change_logs (append-only history)
//   - daily_summaries (follower 'Theary' might be a real person)
//   - leads_events for kasing's phones with NON-test names (real history)
//   - the default brand image
//
// After running, you can `git rm scripts/cleanup-test-data.js` if you don't need
// it again.

const { MongoClient } = require('mongodb');

const TEST_PHONES = ['85570597666', '85511228226', '85586226225'];
const TEST_NAME_REGEX = /^test\d+$/i;

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set; invoke via `railway run node scripts/cleanup-test-data.js`');
    process.exit(1);
  }

  const confirm = process.argv.includes('--confirm');
  console.log(confirm ? '*** DELETE MODE — will mutate the database ***' : '--- dry-run — no writes ---');
  console.log('');

  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();

  const leadsFilter = { 'customer.name': { $regex: TEST_NAME_REGEX } };
  const proposalsFilter = {};
  const customImagesFilter = { kind: 'proposal_custom' };
  const inboundFilter = { phone: { $in: TEST_PHONES } };

  const counts = {
    leads_events: await db.collection('leads_events').countDocuments(leadsFilter),
    outreach_proposals: await db.collection('outreach_proposals').countDocuments(proposalsFilter),
    outreach_images_custom: await db.collection('outreach_images').countDocuments(customImagesFilter),
    inbound_messages: await db.collection('inbound_messages').countDocuments(inboundFilter),
  };

  console.log('Targets:');
  console.log(`  leads_events           (name matches /^test\\d+$/i):   ${counts.leads_events}`);
  console.log(`  outreach_proposals     (all):                          ${counts.outreach_proposals}`);
  console.log(`  outreach_images        (kind=proposal_custom):         ${counts.outreach_images_custom}`);
  console.log(`  inbound_messages       (phone in test phones):         ${counts.inbound_messages}`);
  console.log('');

  if (counts.leads_events > 0) {
    const sample = await db.collection('leads_events').find(leadsFilter).limit(5).project({
      _id: 1, date: 1, follower: 1,
      'customer.name': 1, 'customer.phone': 1,
      'source.model': 1, created_at: 1,
    }).toArray();
    console.log('leads_events sample (first 5):');
    console.log(JSON.stringify(sample, null, 2));
    console.log('');
  }

  if (!confirm) {
    console.log('Dry-run complete. Re-run with --confirm to delete.');
    await client.close();
    return;
  }

  console.log('Deleting…');
  const r1 = await db.collection('leads_events').deleteMany(leadsFilter);
  const r2 = await db.collection('outreach_proposals').deleteMany(proposalsFilter);
  const r3 = await db.collection('outreach_images').deleteMany(customImagesFilter);
  const r4 = await db.collection('inbound_messages').deleteMany(inboundFilter);

  console.log('');
  console.log('Deleted:');
  console.log(`  leads_events:           ${r1.deletedCount}`);
  console.log(`  outreach_proposals:     ${r2.deletedCount}`);
  console.log(`  outreach_images custom: ${r3.deletedCount}`);
  console.log(`  inbound_messages:       ${r4.deletedCount}`);

  // Sanity-check the default brand image is still there.
  const defaultImg = await db.collection('outreach_images').countDocuments({ _id: 'default' });
  console.log('');
  console.log(`Default brand image preserved: ${defaultImg === 1 ? 'YES' : 'NO (re-upload via /crm/outreach)'}`);

  await client.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
