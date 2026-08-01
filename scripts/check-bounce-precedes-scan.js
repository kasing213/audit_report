/**
 * Guards the schedule invariants that actually broke in production:
 *
 *   1. Every server scheduler falls back to Cambodia time. A stray
 *      'Asia/Kuala_Lumpur' (UTC+8) makes a cron labelled '0 9 * * *' fire at
 *      08:00 Cambodia — which is exactly how the outreach scan drifted an
 *      hour early.
 *   2. The pm2 worker bounce lands BEFORE the outreach scan, so each day's
 *      batch is drafted for a freshly restarted worker.
 *   3. The bounce lands before the heartbeat watchdog's window opens, so the
 *      restart's heartbeat gap can't raise a false `worker-offline` alert.
 *
 * Static parse only — reads the source files as text. No database and no
 * compile step, unlike scripts/check-scan-topup.js.
 *
 * Usage: node scripts/check-bounce-precedes-scan.js
 */
const fs = require('fs');
const path = require('path');

/**
 * pm2's cron_restart has no timezone option — it always fires in the clock of
 * the laptop running pm2, which is UTC+7. Comparing it against a node-cron
 * expression is therefore only meaningful when that cron's timezone is also
 * UTC+7. Hence check 1 gates checks 2 and 3.
 */
const HOST_TZ = 'Asia/Phnom_Penh';

const ROOT = path.join(__dirname, '..');
const ECOSYSTEM = path.join(__dirname, 'telegram-worker', 'ecosystem.config.js');
const OUTREACH = path.join(ROOT, 'src', 'scheduler', 'outreach-scheduler.ts');
const WATCHDOG = path.join(ROOT, 'src', 'scheduler', 'heartbeat-watchdog-scheduler.ts');

/** Every file that resolves a scheduler timezone from process.env.TIMEZONE. */
const TZ_FILES = [
  OUTREACH,
  WATCHDOG,
  path.join(ROOT, 'src', 'scheduler', 'promise-scheduler.ts'),
  path.join(ROOT, 'src', 'scheduler', 'monthly-scheduler.ts'),
  path.join(ROOT, 'src', 'ad-scanner', 'ad-scanner-scheduler.ts'),
];

let failures = 0;

function pass(label, detail) {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function checkThat(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function extract(text, re, what, file) {
  const m = text.match(re);
  if (!m) throw new Error(`Could not find ${what} in ${rel(file)} — has the file been restructured?`);
  return m[1];
}

/**
 * '30 8 * * *' -> 510 minutes since midnight. Rejects anything that isn't a
 * single numeric minute and hour, so a list like '30 8,22 * * *' fails loudly
 * rather than being silently half-checked.
 */
function minutesOfDay(expr, what) {
  const [min, hour] = expr.trim().split(/\s+/);
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) {
    throw new Error(`${what} cron '${expr}' is not a single daily time; this check cannot compare it`);
  }
  return Number(hour) * 60 + Number(min);
}

function fmt(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// --- check 1: every scheduler falls back to Cambodia time -------------------
for (const file of TZ_FILES) {
  const matches = [...read(file).matchAll(/process\.env\.TIMEZONE \|\| '([^']+)'/g)].map((m) => m[1]);
  if (matches.length === 0) {
    failures++;
    console.log(`FAIL  ${rel(file)} has no process.env.TIMEZONE fallback — expected at least one`);
    continue;
  }
  const wrong = matches.filter((tz) => tz !== HOST_TZ);
  checkThat(
    `${rel(file)} timezone fallback`,
    wrong.length === 0,
    wrong.length === 0
      ? `${matches.length}x '${HOST_TZ}'`
      : `found ${JSON.stringify(wrong)}, want '${HOST_TZ}'`
  );
}

// --- checks 2 & 3: the bounce precedes the scan and the watchdog window -----
const bounceExpr = extract(read(ECOSYSTEM), /cron_restart:\s*'([^']+)'/, 'cron_restart', ECOSYSTEM);
const scanExpr = extract(read(OUTREACH), /const DEFAULT_CRON = '([^']+)'/, 'DEFAULT_CRON', OUTREACH);
const watchdogExpr = extract(read(WATCHDOG), /const DEFAULT_CRON = '([^']+)'/, 'DEFAULT_CRON', WATCHDOG);

const bounce = minutesOfDay(bounceExpr, 'pm2 cron_restart');
const scan = minutesOfDay(scanExpr, 'outreach DEFAULT_CRON');

// '*/5 9-21 * * *' -> the hour field '9-21' opens at 09:00.
const watchdogHourField = watchdogExpr.trim().split(/\s+/)[1];
if (!/^\d{1,2}-\d{1,2}$/.test(watchdogHourField)) {
  throw new Error(`watchdog cron '${watchdogExpr}' hour field '${watchdogHourField}' is not an H-H range`);
}
const watchdogOpens = Number(watchdogHourField.split('-')[0]) * 60;

console.log('');
console.log(`pm2 bounce      ${bounceExpr.padEnd(16)} ${fmt(bounce)} laptop-local`);
console.log(`outreach scan   ${scanExpr.padEnd(16)} ${fmt(scan)} scheduler-tz`);
console.log(`watchdog opens  ${watchdogExpr.padEnd(16)} ${fmt(watchdogOpens)} scheduler-tz`);
console.log('');

checkThat('pm2 bounce precedes the outreach scan', bounce < scan, `${fmt(bounce)} < ${fmt(scan)}`);
checkThat('pm2 bounce precedes the watchdog window', bounce < watchdogOpens, `${fmt(bounce)} < ${fmt(watchdogOpens)}`);

console.log('');
if (failures) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
pass('all schedule invariants hold');
process.exit(0);
