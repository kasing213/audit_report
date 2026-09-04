/**
 * Deletes ONLY the address-book entries the outreach worker itself created —
 * phones it successfully sent to, where the post-send DeleteContacts cleanup
 * evidently didn't stick. Everything else in this account is the operator's
 * real business book (6,296 of 6,412 entries have no relation to outreach)
 * and is never touched.
 *
 * Mutual contacts are EXCLUDED by default: mutual means the other party has
 * this account saved too, which is a real relationship rather than a leftover
 * import. Pass --include-mutual to override.
 *
 *   node prune-worker-contacts.js                  # dry run
 *   node prune-worker-contacts.js --apply          # delete
 *   node prune-worker-contacts.js --apply --include-mutual
 */
const path = require('path');
// Telegram creds live in this folder's .env; DATABASE_URL lives in the repo
// root's. dotenv does not overwrite already-set vars, so load local first.
require('dotenv').config();
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const fs = require('fs');
const bigInt = require('big-integer');
const { MongoClient } = require('mongodb');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION_PATH = process.env.STRING_SESSION_PATH || './telegram-string-session.txt';
const APPLY = process.argv.includes('--apply');
const INCLUDE_MUTUAL = process.argv.includes('--include-mutual');

(async () => {
  const mongo = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await mongo.connect();
  const sentPhones = new Set(
    await mongo.db().collection('outreach_proposals').distinct('customer_phone', { status: 'sent' }));
  await mongo.close();

  const client = new TelegramClient(
    new StringSession(fs.readFileSync(SESSION_PATH, 'utf8').trim()), API_ID, API_HASH, { connectionRetries: 3 });
  await client.connect();

  const res = await client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }));
  const users = res.users || [];
  console.log(`address book before: ${users.length}`);

  const candidates = users.filter((u) => u.phone && sentPhones.has(`+${String(u.phone).replace(/\D/g, '')}`));
  const mutual = candidates.filter((u) => u.mutualContact);
  const targets = INCLUDE_MUTUAL ? candidates : candidates.filter((u) => !u.mutualContact);

  console.log(`\nworker-attributable entries : ${candidates.length}`);
  console.log(`  mutual (real relationship): ${mutual.length} ${INCLUDE_MUTUAL ? '-> INCLUDED' : '-> HELD BACK'}`);
  console.log(`  to delete                 : ${targets.length}\n`);

  targets.forEach((u) => console.log(
    `  DELETE  +${String(u.phone).padEnd(15)} ${`${u.firstName || ''} ${u.lastName || ''}`.trim().slice(0, 30)}`));
  mutual.forEach((u) => console.log(
    `  ${INCLUDE_MUTUAL ? 'DELETE' : 'KEEP  '}  +${String(u.phone).padEnd(15)} ` +
    `${`${u.firstName || ''} ${u.lastName || ''}`.trim().slice(0, 30)}  (mutual)`));

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to delete.');
    await client.disconnect();
    return;
  }

  // One call, so the address book never sits half-pruned.
  await client.invoke(new Api.contacts.DeleteContacts({
    id: targets.map((u) => new Api.InputUser({ userId: u.id, accessHash: u.accessHash ?? bigInt(0) })),
  }));

  const after = await client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }));
  console.log(`\ndeleted ${targets.length}`);
  console.log(`address book after: ${(after.users || []).length}`);

  await client.disconnect();
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
