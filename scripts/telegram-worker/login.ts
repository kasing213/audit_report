/**
 * One-time login helper.
 *
 * Run this once per Telegram account. A headed Chromium window will open at
 * web.telegram.org. Sign in with the sales phone number (SMS code, optional
 * 2FA). When your chat list is visible, come back to this terminal and press
 * ENTER. The session is saved to STORAGE_STATE (default: ./telegram-session.json).
 */

import * as dotenv from 'dotenv';
import * as readline from 'readline';
import { chromium } from 'playwright';

dotenv.config();

const STORAGE_STATE = process.env.STORAGE_STATE || './telegram-session.json';

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function main(): Promise<void> {
  console.log('Launching headed Chromium...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Opening web.telegram.org...');
  await page.goto('https://web.telegram.org/a/');

  console.log('');
  console.log('--- MANUAL STEP ---');
  console.log('Sign in with the sales Telegram account in the browser window.');
  console.log('When you see your chat list, come back here and press ENTER.');
  await waitForEnter('Press ENTER once logged in: ');

  console.log(`Saving storage state to ${STORAGE_STATE}...`);
  await context.storageState({ path: STORAGE_STATE });
  console.log('Saved. You can close the browser window now.');

  await browser.close();
  console.log('Done. Run `npm run start` to begin the worker.');
}

main().catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});
