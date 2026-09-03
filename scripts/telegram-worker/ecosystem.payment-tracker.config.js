// pm2 process definition for the Payment Tracker outreach worker.
//
//   pm2 start scripts/telegram-worker/ecosystem.payment-tracker.config.js
//   pm2 stop outreach-worker-payment-tracker
//
// Deliberately a SEPARATE file from ecosystem.config.js. Adding a third app
// there would mean `pm2 start ecosystem.config.js` silently starts the payment
// worker too — including on an operator's next routine restart of the two sales
// workers, before anyone has decided the payment pipeline is ready to send.
// Keeping it separate makes starting the payment worker an explicit act.
//
// Bootstrap its session ONCE before first start, from scripts/telegram-worker:
//   npm run login:payment
//
// The server-side Payment worker state ships paused, so starting this process
// polls and sends nothing until an operator resumes it in the dashboard.
//
// Safe to commit — holds no secrets. See OUTREACH_RUNBOOK.md for operations.
module.exports = {
  apps: [
    {
      name: 'outreach-worker-payment-tracker',
      cwd: __dirname,
      // Run ts-node through its bin so we sidestep npm.cmd quirks under pm2 on
      // Windows. Matches ecosystem.config.js.
      script: './node_modules/ts-node/dist/bin.js',
      args: 'worker.ts',
      interpreter: 'node',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      exp_backoff_restart_delay: 200,
      time: true,
      env: {
        ORG_ID: 'payment_tracker',
        STRING_SESSION_PATH: './telegram-string-session-payment-tracker.txt',
        WORKER_ID: 'outreach-payment-tracker',
        // Defence in depth only — the server enforces the real cap with atomic
        // delivery reservations and is authoritative.
        DAILY_CAP: '15',
      },
    },
  ],
};
