// pm2 process definition for the local outreach workers — ONE PER ORG.
//
//   pm2 start scripts/telegram-worker/ecosystem.config.js
//   pm2 save
//
// Two sending numbers = two workers, each with its own Telegram StringSession
// and its own ORG_ID. The server scopes claims / caps / branding by ORG_ID
// (sent as the X-Org-Id header), so the two never cross. Shared config
// (API_ID/API_HASH, AGENT_TOKEN, BASE_URL) lives in ./.env; the per-app `env`
// below overrides ORG_ID + STRING_SESSION_PATH. pm2-set env wins over dotenv,
// which does not override already-set vars.
//
// Bootstrap each session ONCE before first start:
//   ORG_ID=company  STRING_SESSION_PATH=./telegram-string-session.txt          npm run login
//   ORG_ID=personal STRING_SESSION_PATH=./telegram-string-session-personal.txt npm run login
//
// Safe to commit — holds no secrets. See OUTREACH_RUNBOOK.md for operations.
const shared = {
  cwd: __dirname,
  // Run ts-node through its bin so we sidestep npm.cmd quirks under pm2 on
  // Windows. Equivalent to `ts-node worker.ts`. Path verified to exist:
  // scripts/telegram-worker/node_modules/ts-node/dist/bin.js
  script: './node_modules/ts-node/dist/bin.js',
  args: 'worker.ts',
  interpreter: 'node',
  autorestart: true, // restart on crash — pm2's core job
  cron_restart: '0 22 * * *', // nightly bounce at 10pm laptop-LOCAL time
  max_restarts: 10,
  restart_delay: 5000,
  exp_backoff_restart_delay: 200,
  time: true, // prefix logs with timestamps
};

module.exports = {
  apps: [
    {
      ...shared,
      name: 'outreach-worker-company',
      env: {
        ORG_ID: 'company',
        STRING_SESSION_PATH: './telegram-string-session.txt',
        WORKER_ID: 'outreach-company',
      },
    },
    {
      ...shared,
      name: 'outreach-worker-personal',
      env: {
        ORG_ID: 'personal',
        STRING_SESSION_PATH: './telegram-string-session-personal.txt',
        WORKER_ID: 'outreach-personal',
      },
    },
  ],
};
