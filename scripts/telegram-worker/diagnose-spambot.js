// Ask Telegram's official @SpamBot whether THIS account (the company outreach
// account) is limited/restricted. Sends "/start" and prints the bot's reply.
// This is the canonical way to check account standing.
//
//   1) pm2 stop outreach-worker
//   2) node scripts/telegram-worker/diagnose-spambot.js
//   3) pm2 start outreach-worker

require('dotenv').config();
const fs = require('fs');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION_PATH = process.env.STRING_SESSION_PATH || './telegram-string-session.txt';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  if (!API_ID || !API_HASH) { console.error('API creds missing'); process.exit(1); }
  const sessionStr = fs.readFileSync(SESSION_PATH, 'utf8').trim();
  const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 3 });
  await client.connect();

  const me = await client.getMe();
  console.log(`Account: id=${me.id} phone=${me.phone} premium=${!!me.premium} restricted=${!!me.restricted}\n`);

  await client.sendMessage('SpamBot', { message: '/start' });

  // Give the bot a few seconds to answer, polling for its reply.
  let reply = null;
  for (let i = 0; i < 6 && !reply; i++) {
    await sleep(1500);
    const msgs = await client.getMessages('SpamBot', { limit: 3 });
    reply = msgs.find((m) => !m.out && m.message);
  }

  console.log('=== @SpamBot reply ===');
  console.log(reply ? reply.message : '(no reply received within timeout)');

  await client.disconnect();
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
