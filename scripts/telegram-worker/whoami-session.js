// Read-only: load a StringSession file and print which Telegram account it is.
//   node whoami-session.js ./telegram-string-session.txt
// Uses the shared TELEGRAM_API_ID/HASH from .env. Connects, getMe(), disconnects.
require('dotenv').config();
const fs = require('fs');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

(async () => {
  const file = process.argv[2] || './telegram-string-session.txt';
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  if (!fs.existsSync(file)) { console.log(`${file}: MISSING`); process.exit(0); }
  const session = fs.readFileSync(file, 'utf8').trim();
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 2 });
  await client.connect();
  const me = await client.getMe();
  console.log(`${file}:`);
  console.log(`  phone=+${me.phone || '?'}  name=${me.firstName || ''} ${me.lastName || ''}  username=@${me.username || '-'}  id=${me.id}`);
  await client.disconnect();
  process.exit(0);
})().catch((e) => { console.error('err:', e.message); process.exit(1); });
