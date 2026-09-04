/**
 * READ-ONLY audit of the company account's address book. Deletes nothing.
 *
 * Before pruning toward Telegram's ~5,000 contact cap we have to know what the
 * 6,543 entries are. The worker imports each lead as firstName=<customer name>
 * (or 'Lead') and deletes it after a successful send, so leftovers from that
 * path should be recognisable — but anything synced from a real phone book is
 * NOT ours to delete.
 *
 * Usage (from scripts/telegram-worker):  node audit-contacts.js
 */
require('dotenv').config();
const fs = require('fs');
const bigInt = require('big-integer');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION_PATH = process.env.STRING_SESSION_PATH || './telegram-string-session.txt';
// Scratchpad, not the repo — this dump is a full list of customer phone numbers.
const OUT = process.env.CONTACTS_DUMP_PATH
  || 'C:/Users/SHCOMP~1/AppData/Local/Temp/claude/D--audit-sales/e57fa077-89e7-4271-bf65-682dcfe68dcc/scratchpad/contacts-dump.json';

(async () => {
  const sessionStr = fs.readFileSync(SESSION_PATH, 'utf8').trim();
  const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 3 });
  await client.connect();

  const res = await client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }));
  const users = res.users || [];
  console.log(`total saved contacts: ${users.length}`);

  const rows = users.map((u) => ({
    id: String(u.id),
    phone: u.phone ? `+${String(u.phone).replace(/\D/g, '')}` : null,
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    username: u.username || null,
    mutualContact: !!u.mutualContact,
    deleted: !!u.deleted,
  }));
  fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
  console.log(`full dump written to ${OUT}`);

  // --- shape of the book ---
  const withPhone = rows.filter((r) => r.phone).length;
  const mutual = rows.filter((r) => r.mutualContact).length;
  const named = rows.filter((r) => r.firstName === 'Lead').length;
  const hasLastName = rows.filter((r) => r.lastName).length;
  const deleted = rows.filter((r) => r.deleted).length;
  console.log(`\nwith phone number      : ${withPhone}`);
  console.log(`mutual contacts        : ${mutual}   <- these know you back; almost certainly real`);
  console.log(`firstName === 'Lead'   : ${named}   <- worker fallback name`);
  console.log(`has a last name        : ${hasLastName}   <- worker never sets one`);
  console.log(`deleted accounts       : ${deleted}`);

  // Cambodian mobile prefixes vs everything else — a synced personal book
  // would look different from a lead list.
  const kh = rows.filter((r) => r.phone && r.phone.startsWith('+855')).length;
  console.log(`+855 (Cambodia)        : ${kh} / ${withPhone}`);

  console.log('\n=== 15 sample entries ===');
  rows.slice(0, 15).forEach((r) => console.log(
    `${String(r.phone || '-').padEnd(16)} ${`${r.firstName} ${r.lastName}`.trim().slice(0, 28).padEnd(28)} ` +
    `@${r.username || '-'} mutual=${r.mutualContact}`));

  await client.disconnect();
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
