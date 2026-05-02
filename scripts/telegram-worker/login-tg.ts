/**
 * One-time interactive login. Run `npm run login` once to bootstrap a
 * Telegram MTProto session for the user account this worker will operate
 * as. Writes a string session blob to disk that the worker loads on every
 * start — no further interactive auth needed unless Telegram revokes the
 * session.
 *
 * Required env (.env in this folder):
 *   TELEGRAM_API_ID     — from https://my.telegram.org/apps
 *   TELEGRAM_API_HASH   — from https://my.telegram.org/apps
 *
 * Optional:
 *   STRING_SESSION_PATH — defaults to ./telegram-string-session.txt
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as readline from 'readline';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

dotenv.config();

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION_PATH = process.env.STRING_SESSION_PATH || './telegram-string-session.txt';

if (!API_ID || !API_HASH) {
  console.error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env.');
  console.error('Get them from https://my.telegram.org/apps (free).');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function prompt(q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a)));
}

async function main(): Promise<void> {
  const session = new StringSession('');
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  console.log('Logging in to Telegram. The code will be sent to your Telegram app.');
  await client.start({
    phoneNumber: () => prompt('Phone number (international, e.g. +85512345678): '),
    password: () => prompt('2FA password (press ENTER if you have none): '),
    phoneCode: () => prompt('Code Telegram just sent: '),
    onError: (err) => console.error('login error:', err.message),
  });

  const saved = String(client.session.save());
  fs.writeFileSync(SESSION_PATH, saved, { encoding: 'utf8', mode: 0o600 });
  console.log(`Session saved to ${SESSION_PATH}. Keep this file private — it grants full access to your account.`);
  rl.close();
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('login failed:', err);
  rl.close();
  process.exit(1);
});
