/**
 * Guards the schedule invariants that actually broke in production, checked
 * against the DEFAULT_SCHEDULE_SETTINGS fallback (the live, dashboard-edited
 * schedule lives in the DB — see OutreachScheduleSettingsRepository — and is
 * not something a static file check can see; this guards the values every
 * deploy falls back to when nothing has been configured yet):
 *
 *   1. Every server scheduler falls back to Cambodia time. A stray
 *      'Asia/Kuala_Lumpur' (UTC+8) makes a cron labelled '0 9 * * *' fire at
 *      08:00 Cambodia — which is exactly how the outreach scan drifted an
 *      hour early.
 *   2. The worker's daily self-bounce (worker.ts checkDailyBounce, formerly
 *      pm2 cron_restart) lands BEFORE the outreach scan, so each day's batch
 *      is drafted for a freshly restarted worker.
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
 * The worker's bounce clock has no timezone option — it always compares
 * against the Mac's local clock, which is UTC+7. Comparing it against a
 * node-cron expression is therefore only meaningful when that cron's
 * timezone is also UTC+7. Hence check 1 gates checks 2 and 3.
 */
const HOST_TZ = 'Asia/Phnom_Penh';

const ROOT = path.join(__dirname, '..');
const SCHEDULE_SETTINGS = path.join(ROOT, 'src', 'outreach', 'outreach-schedule-settings-repository.ts');
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
// All three now live in one object (DEFAULT_SCHEDULE_SETTINGS) instead of
// three separate cron expressions, since the live schedule is DB-driven and
// this can only check the fallback every deploy starts from.
const settingsSrc = read(SCHEDULE_SETTINGS);
const bounceTime = extract(settingsSrc, /bounce_time:\s*'([^']+)'/, 'bounce_time', SCHEDULE_SETTINGS);
const scanTime = extract(settingsSrc, /scan_time:\s*'([^']+)'/, 'scan_time', SCHEDULE_SETTINGS);
const activeStartHour = extract(settingsSrc, /active_start_hour:\s*(\d{1,2})/, 'active_start_hour', SCHEDULE_SETTINGS);

function timeStrMinutes(hhmm, what) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`${what} '${hhmm}' is not an HH:MM time; this check cannot compare it`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const bounce = timeStrMinutes(bounceTime, 'bounce_time');
const scan = timeStrMinutes(scanTime, 'scan_time');
const watchdogOpens = Number(activeStartHour) * 60;

console.log('');
console.log(`worker bounce   ${bounceTime.padEnd(16)} ${fmt(bounce)} laptop-local`);
console.log(`outreach scan   ${scanTime.padEnd(16)} ${fmt(scan)} scheduler-tz`);
console.log(`watchdog opens  ${String(activeStartHour).padEnd(16)} ${fmt(watchdogOpens)} scheduler-tz`);
console.log('');

checkThat('worker bounce precedes the outreach scan', bounce < scan, `${fmt(bounce)} < ${fmt(scan)}`);
checkThat('worker bounce precedes the watchdog window', bounce < watchdogOpens, `${fmt(bounce)} < ${fmt(watchdogOpens)}`);

console.log('');
if (failures) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
pass('all schedule invariants hold');
process.exit(0);
