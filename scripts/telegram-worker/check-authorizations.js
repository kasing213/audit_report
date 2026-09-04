// Read-only: list all active Telegram authorizations (sessions) for the account
// held in a StringSession file. Recreated per OUTREACH_RUNBOOK.md §6 pattern.
//   node check-authorizations.js ./telegram-string-session.txt
// Stop that org's pm2 worker first so this doesn't double-connect the session.
require('dotenv').config();
const fs = require('fs');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');

(async () => {
  const file = process.argv[2] || './telegram-string-session.txt';
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  if (!fs.existsSync(file)) { console.log(`${file}: MISSING`); process.exit(0); }
  const session = fs.readFileSync(file, 'utf8').trim();
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 2 });
  await client.connect();
  const me = await client.getMe();
  console.log(`${file}: phone=+${me.phone || '?'} name=${me.firstName || ''} ${me.lastName || ''} id=${me.id}`);
  const result = await client.invoke(new Api.account.GetAuthorizations({}));
  for (const a of result.authorizations) {
    console.log(
      `  current=${a.current} platform=${a.platform} deviceModel=${a.deviceModel} appName=${a.appName} ` +
      `ip=${a.ip} country=${a.country} dateCreated=${new Date(a.dateCreated * 1000).toISOString()} ` +
      `dateActive=${new Date(a.dateActive * 1000).toISOString()}`
    );
  }
  await client.disconnect();
  process.exit(0);
})().catch((e) => { console.error('err:', e.message); process.exit(1); });
