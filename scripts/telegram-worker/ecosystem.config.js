// pm2 process definition for the local outreach worker.
//
//   pm2 start scripts/telegram-worker/ecosystem.config.js
//   pm2 save
//
// Safe to commit — holds no secrets. Credentials stay in ./.env, which the
// worker loads itself via dotenv. See OUTREACH_RUNBOOK.md for full operations.
module.exports = {
  apps: [
    {
      name: 'outreach-worker',
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
    },
  ],
};
