// Read-only diagnostic: connect as the COMPANY account (worker's StringSession)
// and probe phone->entity resolution to explain why numbers that are real on a
// personal account come back "not on Telegram" here.
//
// Does NOT send any message. It imports each contact (to read the response),
// then immediately deletes it, so the address book is left as it was.
//
//   1) pm2 stop outreach-worker        (avoid sharing the session)
//   2) node scripts/telegram-worker/diagnose-resolve.js
//   3) pm2 start outreach-worker
//
// CONTROL numbers = the old test phones that DID send successfully before.
// If the controls resolve but the leads don't  -> recipient privacy blocks it.
// If even the controls now fail                -> the company account is limited.

require('dotenv').config();
const fs = require('fs');
const bigInt = require('big-integer');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION_PATH = process.env.STRING_SESSION_PATH || './telegram-string-session.txt';

// CONTROLS = numbers this account SUCCESSFULLY sent to on 2026-08-01 (07:00,
// 07:04, 09:11). They were provably reachable hours ago, so an empty result
// here cannot mean "not on Telegram" — it means the account stopped resolving.
const CONTROLS = ['+85587878965', '+85512985737', '+85586610775'];
// LEADS = a sample of the 08-01 failures, all reported "not on Telegram".
const LEADS = ['+85581496675', '+85589338711', '+85510783766', '+855972248585', '+855962816168'];

async function probe(client, phone, savedSet) {
  const digits = phone.replace(/\D/g, '');
  const alreadySaved = savedSet.has(digits);
  let res;
  try {
    res = await client.invoke(new Api.contacts.ImportContacts({
      contacts: [new Api.InputPhoneContact({
        clientId: bigInt(0), phone: `+${digits}`, firstName: 'Probe', lastName: '',
      })],
    }));
  } catch (err) {
    return `${phone.padEnd(15)} preSaved=${alreadySaved ? 'YES' : 'no '} ERROR importing: ${err.message}`;
  }
  const user = res.users.find((u) => u instanceof Api.User);
  // Only delete if it wasn't already a saved contact (don't wipe real ones).
  if (user && !alreadySaved) {
    try {
      await client.invoke(new Api.contacts.DeleteContacts({
        id: [new Api.InputUser({ userId: user.id, accessHash: user.accessHash || bigInt(0) })],
      }));
    } catch (_) { /* best-effort */ }
  }
  const counts = `imported=${res.imported.length} retry=${res.retryContacts.length} users=${res.users.length}`;
  const detail = user
    ? `RESOLVED   (${counts}) -> id=${user.id} @${user.username || '-'} phoneVisible=${user.phone ? 'yes' : 'no'}`
    : `NOTRESOLVED(${counts})`;
  return `${phone.padEnd(15)} preSaved=${alreadySaved ? 'YES' : 'no '} ${detail}`;
}

(async () => {
  if (!API_ID || !API_HASH) { console.error('API creds missing'); process.exit(1); }
  const sessionStr = fs.readFileSync(SESSION_PATH, 'utf8').trim();
  const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 3 });
  await client.connect();

  const me = await client.getMe();
  console.log('=== Company account ===');
  console.log(`id=${me.id} username=@${me.username || '-'} phone=${me.phone || '-'} premium=${!!me.premium} restricted=${!!me.restricted}`);
  if (me.restricted && me.restrictionReason) {
    console.log('restrictionReason:', JSON.stringify(me.restrictionReason));
  }

  // Contact-list size is a strong signal for a limited/full account.
  const savedSet = new Set();
  try {
    const contacts = await client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }));
    const users = contacts.users || [];
    for (const u of users) { if (u.phone) savedSet.add(u.phone.replace(/\D/g, '')); }
    console.log(`saved contacts on this account: ${users.length}`);
  } catch (e) { console.log('GetContacts failed:', e.message); }

  console.log('\n=== CONTROL numbers (old test phones that DID send before) ===');
  for (const p of CONTROLS) console.log(await probe(client, p, savedSet));

  console.log('\n=== LEAD numbers (the ones failing outreach) ===');
  for (const p of LEADS) console.log(await probe(client, p, savedSet));

  await client.disconnect();
  console.log('\nDone.');
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
