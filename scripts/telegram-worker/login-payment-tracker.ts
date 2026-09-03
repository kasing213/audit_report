/**
 * One-time interactive login for the Payment Tracker Telegram account.
 *
 * Separate from `npm run login` on purpose. That script writes wherever
 * STRING_SESSION_PATH points, which is exactly the flexibility you do not want
 * when adding a third account: a mistyped env var there would overwrite the
 * Company session and take its worker offline. This command has no path
 * argument at all — it writes one filename, in the worker directory, and only
 * if that file does not already exist.
 *
 * Run from scripts/telegram-worker: npm run login:payment
 */
import * as dotenv from 'dotenv';
import * as readline from 'readline';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import {
  PAYMENT_SESSION_FILENAME,
  resolvePaymentSessionTarget,
  writeSessionExclusive,
} from './payment-session-guard';

dotenv.config();

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';

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
  // Validate the destination before asking anyone for a login code.
  const target = resolvePaymentSessionTarget(process.cwd(), `./${PAYMENT_SESSION_FILENAME}`);

  const session = new StringSession('');
  const client = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5 });

  console.log('Logging in the PAYMENT TRACKER Telegram account. The code goes to that account.');
  await client.start({
    phoneNumber: () => prompt('Payment Tracker phone number (international, e.g. +85512345678): '),
    password: () => prompt('2FA password (press ENTER if you have none): '),
    phoneCode: () => prompt('Code Telegram just sent: '),
    onError: (err) => console.error('login error:', err.message),
  });

  // Written only after Telegram hands back a session, so a cancelled login
  // leaves no file behind to block the next attempt.
  writeSessionExclusive(target, String(client.session.save()));
  console.log(`Session saved to ${target}. Keep this file private — it grants full access to that account.`);
  rl.close();
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('payment login failed:', err instanceof Error ? err.message : err);
  rl.close();
  process.exit(1);
});
