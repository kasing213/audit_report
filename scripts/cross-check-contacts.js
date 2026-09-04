/**
 * READ-ONLY. How much of the account's address book could the outreach worker
 * plausibly have created? Anything it did NOT create is the operator's real
 * business book and must not be pruned automatically.
 *
 * Usage: node scripts/cross-check-contacts.js <path-to-contacts-dump.json>
 */
require('dotenv').config();
const fs = require('fs');
const { MongoClient } = require('mongodb');

(async () => {
  const dumpPath = process.argv[2];
  const contacts = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();

  const leadPhones = new Set((await db.collection('leads_events').distinct('customer.phone')).filter(Boolean));
  // Phones the worker actually resolved+sent to — the only ones it ever created
  // a contact for (import happens, then DeleteContacts runs on success).
  const sentPhones = new Set(await db.collection('outreach_proposals').distinct('customer_phone', { status: 'sent' }));

  const withPhone = contacts.filter((c) => c.phone);
  const inLeads = withPhone.filter((c) => leadPhones.has(c.phone));
  const inSent = withPhone.filter((c) => sentPhones.has(c.phone));

  console.log(`address book entries          : ${contacts.length}`);
  console.log(`  with a phone number         : ${withPhone.length}`);
  console.log(`  phone appears in leads_events: ${inLeads.length}`);
  console.log(`  phone was ever SENT to      : ${inSent.length}   <- max the worker could have left behind`);
  console.log(`  no relation to outreach     : ${withPhone.length - inLeads.length}`);

  console.log('\n=== entries the worker may have left behind (sent, still a contact) ===');
  inSent.slice(0, 20).forEach((c) => console.log(
    `${String(c.phone).padEnd(16)} ${`${c.firstName} ${c.lastName}`.trim().slice(0, 30).padEnd(30)} mutual=${c.mutualContact}`));

  // Naming convention check: the worker sets firstName=<customer name>, no last
  // name, no username. Human-curated entries look nothing like that.
  const workerShaped = withPhone.filter((c) => !c.lastName && !c.username);
  console.log(`\nentries with no last name AND no username: ${workerShaped.length}`);
  console.log('(worker-created entries always look like this — but so do many real ones,');
  console.log(' so this is an upper bound, not a delete list)');

  const overCap = contacts.length - 5000;
  console.log(`\nover the ~5,000 cap by       : ${overCap}`);
  console.log(`worker-attributable entries  : ${inSent.length}`);
  console.log(inSent.length >= overCap
    ? 'Pruning only worker leftovers WOULD get under the cap.'
    : `Pruning every worker leftover still leaves ${overCap - inSent.length} over the cap.`);

  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
