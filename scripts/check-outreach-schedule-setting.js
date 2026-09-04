/**
 * Regression check for the dashboard-editable global outreach schedule.
 *
 * Builds must run first so this script exercises the compiled production
 * modules rather than duplicating their logic.
 *
 * Usage: npm run build && node scripts/check-outreach-schedule-setting.js
 */

const {
  DEFAULT_OUTREACH_DAILY_TIME,
  normalizeDailyTime,
  dailyTimeToCron,
  cronToDailyTime,
} = require('../dist/scheduler/outreach-schedule-config');
const { OutreachScheduler } = require('../dist/scheduler/outreach-scheduler');
const fs = require('fs');
const path = require('path');
const express = require('express');
const outreachRoutes = require('../dist/api/outreach-routes').default;

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

async function main() {
  check('default daily time', DEFAULT_OUTREACH_DAILY_TIME, '13:00');
  check('accepts a valid padded time', normalizeDailyTime('16:40'), '16:40');
  check('rejects an unpadded time', normalizeDailyTime('6:40'), null);
  check('rejects hour 24', normalizeDailyTime('24:00'), null);
  check('rejects minute 60', normalizeDailyTime('13:60'), null);
  check('converts time to daily cron', dailyTimeToCron('16:40'), '40 16 * * *');
  check('converts daily cron to time', cronToDailyTime('5 7 * * *'), '07:05');
  check('rejects a non-daily cron for the time picker', cronToDailyTime('0 13 * * 1-5'), null);

  const root = path.join(__dirname, '..');
  const routeSource = fs.readFileSync(path.join(root, 'src', 'api', 'outreach-routes.ts'), 'utf8');
  const templateSource = fs.readFileSync(path.join(root, 'src', 'reports', 'templates', 'crm', 'outreach.hbs'), 'utf8');
  check('API exposes schedule settings GET', routeSource.includes("router.get('/scheduler/settings'"), true);
  check('API exposes schedule settings PUT', routeSource.includes("router.put('/scheduler/settings'"), true);
  check('Outreach page has a daily time picker', /type="time"[^>]+id="outreach-daily-time"/.test(templateSource), true);
  check('Outreach page saves through the schedule API', templateSource.includes("API + '/scheduler/settings'"), true);

  const originalAutoScan = process.env.OUTREACH_AUTO_SCAN;
  const originalCron = process.env.OUTREACH_CRON;
  const originalTimezone = process.env.TIMEZONE;
  const originalDashboardToken = process.env.DASHBOARD_TOKEN;
  const originalAgentToken = process.env.AGENT_TOKEN;

  try {
    process.env.OUTREACH_AUTO_SCAN = 'true';
    process.env.OUTREACH_CRON = '0 9 * * *';
    process.env.TIMEZONE = 'Asia/Phnom_Penh';

    const saved = [];
    const store = {
      async getDailyTime() { return '14:25'; },
      async setDailyTime(dailyTime, updatedBy) { saved.push({ dailyTime, updatedBy }); },
    };
    const tasks = [];
    const scheduleTask = (expression, _callback, options) => {
      const task = {
        expression,
        options,
        started: false,
        stopped: false,
        start() { this.started = true; },
        stop() { this.stopped = true; },
      };
      tasks.push(task);
      return task;
    };

    const scheduler = new OutreachScheduler(store, scheduleTask);
    await scheduler.startScheduler();

    check('saved setting wins over environment fallback', tasks[0]?.expression, '25 14 * * *');
    check('scheduler uses Cambodia timezone', tasks[0]?.options?.timezone, 'Asia/Phnom_Penh');
    check('scheduler task has a stable name', tasks[0]?.options?.name, 'outreach-daily-scan');
    check('cron task is constructed stopped', tasks[0]?.options?.scheduled, false);
    check('initial cron task is explicitly started', tasks[0]?.started, true);
    check('settings report saved source', scheduler.getScheduleInfo().source, 'saved');

    const updated = await scheduler.updateDailyTime('16:40', 'manager');
    check('setting is persisted with actor', saved, [{ dailyTime: '16:40', updatedBy: 'manager' }]);
    check('old cron task is stopped', tasks[0]?.stopped, true);
    check('new cron task uses selected time', tasks[1]?.expression, '40 16 * * *');
    check('replacement cron task is started', tasks[1]?.started, true);
    check('update response returns selected time', updated.daily_time, '16:40');

    process.env.OUTREACH_AUTO_SCAN = 'false';
    const disabledTasks = [];
    const disabledScheduler = new OutreachScheduler(
      { async getDailyTime() { return null; }, async setDailyTime() {} },
      (expression, _callback, options) => {
        const task = {
          expression,
          options,
          started: false,
          stopped: false,
          start() { this.started = true; },
          stop() { this.stopped = true; },
        };
        disabledTasks.push(task);
        return task;
      }
    );
    await disabledScheduler.startScheduler();
    const disabledUpdate = await disabledScheduler.updateDailyTime('15:10', 'developer');
    check('disabled scheduler does not start a task', disabledTasks.length, 0);
    check('disabled scheduler still keeps saved time', disabledUpdate.daily_time, '15:10');
    check('disabled status remains false', disabledUpdate.enabled, false);

    process.env.DASHBOARD_TOKEN = 'schedule-check-dashboard-token';
    process.env.AGENT_TOKEN = 'schedule-check-agent-token';
    const app = express();
    app.use('/crm/api/outreach', outreachRoutes);
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}/crm/api/outreach/scheduler/settings`;
      const developerHeaders = { Authorization: `Bearer ${process.env.DASHBOARD_TOKEN}` };

      let response = await fetch(baseUrl, { headers: developerHeaders });
      check('authenticated settings GET status', response.status, 200);
      check('authenticated settings GET value', (await response.json()).daily_time, '15:10');

      response = await fetch(baseUrl, {
        method: 'PUT',
        headers: { ...developerHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ daily_time: '25:00' }),
      });
      check('invalid settings PUT status', response.status, 400);

      response = await fetch(baseUrl, {
        method: 'PUT',
        headers: { ...developerHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ daily_time: '17:45' }),
      });
      const updatedBody = await response.json();
      check('valid settings PUT status', response.status, 200);
      check('valid settings PUT applies value', updatedBody.daily_time, '17:45');

      response = await fetch(baseUrl, {
        headers: { Authorization: `Bearer ${process.env.AGENT_TOKEN}` },
      });
      check('MTProto agent cannot edit or read dashboard setting', response.status, 403);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  } finally {
    if (originalAutoScan === undefined) delete process.env.OUTREACH_AUTO_SCAN;
    else process.env.OUTREACH_AUTO_SCAN = originalAutoScan;
    if (originalCron === undefined) delete process.env.OUTREACH_CRON;
    else process.env.OUTREACH_CRON = originalCron;
    if (originalTimezone === undefined) delete process.env.TIMEZONE;
    else process.env.TIMEZONE = originalTimezone;
    if (originalDashboardToken === undefined) delete process.env.DASHBOARD_TOKEN;
    else process.env.DASHBOARD_TOKEN = originalDashboardToken;
    if (originalAgentToken === undefined) delete process.env.AGENT_TOKEN;
    else process.env.AGENT_TOKEN = originalAgentToken;
  }

  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nPASS  all outreach schedule setting checks');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
