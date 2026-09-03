/**
 * Dedicated cron for the Payment Tracker scan.
 *
 * Separate from OutreachScheduler on purpose. The sales scheduler drafts from
 * stale leads for Company and Personal on a shared, dashboard-editable
 * schedule; this one reads receivables on its own fixed Cambodia clock, and
 * neither should be able to trigger the other.
 *
 * Off unless PAYMENT_TRACKER_SCAN_ENABLED is exactly 'true'. While disabled,
 * startScheduler() registers no task and — importantly — opens no connection to
 * the Payment source, so deploying this code to production does nothing until
 * an operator turns it on.
 */
import * as cron from 'node-cron';
import { Logger } from '../utils/logger';
import { dailyCronAt, isValidTimeStr } from '../utils/cron-time';
import { defaultProposalCollectionPort } from '../outreach/outreach-repository';
import { OutreachWorkerStateRepository } from '../outreach/outreach-worker-state-repository';
import { PAYMENT_TRACKER_ORG } from '../outreach/orgs';
import { CAMBODIA_TZ } from '../payment-tracker/payment-domain';
import { PaymentSourceConnection } from '../payment-tracker/payment-source-connection';
import { PaymentSourceRepository } from '../payment-tracker/payment-source-repository';
import { PaymentTemplateRepository } from '../payment-tracker/payment-template-repository';
import { PaymentScanResult, PaymentTrackerScanner } from '../payment-tracker/payment-scanner';
import {
  PaymentScanHealth,
  PaymentScanStateRepository,
} from '../payment-tracker/payment-scan-state-repository';

const DEFAULT_SCAN_TIME = '10:00';

let registeredScheduler: PaymentTrackerScheduler | null = null;

/** The running scheduler, so the dashboard's "Scan now" can reach it. */
export function getRegisteredPaymentTrackerScheduler(): PaymentTrackerScheduler | null {
  return registeredScheduler;
}

export class PaymentTrackerScheduler {
  private task: cron.ScheduledTask | null = null;

  constructor(private readonly source: PaymentSourceConnection = new PaymentSourceConnection()) {
    registeredScheduler = this;
  }

  static scanEnabled(): boolean {
    return process.env.PAYMENT_TRACKER_SCAN_ENABLED === 'true';
  }

  static scanTime(): string {
    const configured = process.env.PAYMENT_TRACKER_SCAN_TIME;
    if (configured && !isValidTimeStr(configured)) {
      throw new Error('PAYMENT_TRACKER_SCAN_TIME must be HH:MM');
    }
    return configured || DEFAULT_SCAN_TIME;
  }

  startScheduler(): void {
    if (!PaymentTrackerScheduler.scanEnabled()) {
      Logger.info('Payment Tracker scanning disabled (set PAYMENT_TRACKER_SCAN_ENABLED=true to enable)');
      return;
    }

    const scanTime = PaymentTrackerScheduler.scanTime();
    this.task = cron.schedule(
      dailyCronAt(scanTime),
      () => {
        this.runScan().catch((err) => Logger.error('payment tracker scan failed', err as Error));
      },
      { scheduled: true, timezone: CAMBODIA_TZ }
    );
    Logger.info(`Payment Tracker scan scheduled daily at ${scanTime} ${CAMBODIA_TZ}`);
  }

  /** Manual "Scan now". Refuses for the same reasons the cron run would. */
  async triggerNow(): Promise<PaymentScanResult> {
    return this.runScan();
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Disconnect the source client, but only if a scan ever opened it. */
  async disconnectSource(): Promise<void> {
    if (this.source.isConnected()) await this.source.disconnect();
  }

  /**
   * One scan. Dependencies are resolved per run — wording, Auto mode, and scan
   * health are all operator-editable between runs, so a scanner built once at
   * startup would act on stale settings.
   */
  private async runScan(): Promise<PaymentScanResult> {
    const now = new Date();
    const stateRepo = new PaymentScanStateRepository();
    const health = new PaymentScanHealth(await stateRepo.get());

    try {
      await this.source.connect();
      const workerState = await new OutreachWorkerStateRepository().getStatus(PAYMENT_TRACKER_ORG);

      const scanner = new PaymentTrackerScanner({
        source: new PaymentSourceRepository(this.source.collection()),
        proposals: defaultProposalCollectionPort(),
        health,
        template: await new PaymentTemplateRepository().get(),
        workerState: { auto_approve: workerState.auto_approve === true },
      });

      return await scanner.run(now);
    } finally {
      // Health is persisted whether the scan succeeded or failed — an operator
      // needs to see a source outage as much as a clean run.
      await stateRepo.save(health, now).catch((err) =>
        Logger.error('payment tracker scan state save failed', err as Error)
      );
    }
  }
}
