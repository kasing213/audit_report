/**
 * How many numbers can this workspace actually contact? Answers whether the
 * 180-day cooldown ever binds: at 15 sends/day it takes ~2,700 sends before any
 * number recycles, so a pool above that behaves as if contact were permanent.
 *
 * Usage: node scripts/count-contactable-pool.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');
const { OUTREACH_ORGS, orgMatch } = require('../dist/outreach/orgs');
const { CONTACT_COOLDOWN_DAYS } = require('../dist/outreach/outreach-suppression-repository');

const COOLDOWN_DAYS = CONTACT_COOLDOWN_DAYS;
const DAILY_CAP = Number(process.env.DAILY_CAP) || 15;

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const now = new Date();

  for (const org of OUTREACH_ORGS) {
    const match = orgMatch(org.id);

    const distinct = await db.collection('leads_events').aggregate([
      { $match: { org_id: match, 'customer.phone': { $ne: null } } },
      { $group: { _id: '$customer.phone' } },
      { $count: 'total' },
    ]).toArray();
    const pool = distinct[0]?.total ?? 0;

    const blocked = await db.collection('outreach_suppressions').countDocuments({
      org_id: match,
      $or: [
        { failure_kind: { $in: ['privacy', 'invalid'] } },
        { failure_kind: 'contacted', eligible_again_at: { $gt: now } },
      ],
    });

    const contactable = Math.max(0, pool - blocked);
    const recycleAfter = DAILY_CAP * COOLDOWN_DAYS;

    console.log(`\n=== ${org.id} (${org.label}) ===`);
    console.log(`distinct phones in leads_events : ${pool}`);
    console.log(`blocked (permanent + cooldown)  : ${blocked}`);
    console.log(`contactable now                 : ${contactable}`);
    console.log(`sends before any number recycles: ${recycleAfter}`);
    console.log(
      contactable >= recycleAfter
        ? '→ pool exceeds the recycle threshold: the 180d cooldown never binds.'
        : `→ pool is BELOW the threshold: expect the queue to thin out after ~${Math.floor(contactable / DAILY_CAP)} days.`
    );
  }

  await client.close();
})();
