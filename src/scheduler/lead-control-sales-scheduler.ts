import * as cron from 'node-cron';
import { LeadControlConfig } from '../lead-control/config';
import {
  PaymentSalesSourceConnection,
  PaymentSalesSourceRepository,
  SalesReadCollection,
} from '../lead-control/payment-sales-source';
import { MongoLeadControlRepository } from '../lead-control/repository';
import { SalesProjectionRepository, SalesSyncResult, SyncSalesService } from '../lead-control/sync-service';
import { Logger } from '../utils/logger';

const CAMBODIA_TIMEZONE = 'Asia/Phnom_Penh';

export interface CronTaskPort { stop(): void; }

export interface CronPort {
  schedule(
    expression: string,
    callback: () => void | Promise<void>,
    options: { scheduled: true; timezone: string },
  ): CronTaskPort;
}

export interface LeadControlSalesSourceConnection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  collection(): SalesReadCollection;
}

/**
 * Periodic, single-flight import from the collection-scoped Payment Tracker source.
 * The scheduler owns only orchestration; normalization, attribution, and persistence
 * remain in the real SyncSalesService.
 */
export class LeadControlSalesScheduler {
  private task: CronTaskPort | null = null;
  private activeRun: Promise<SalesSyncResult> | null = null;

  constructor(
    private readonly config: LeadControlConfig,
    private readonly source: LeadControlSalesSourceConnection = new PaymentSalesSourceConnection(),
    private readonly repository: SalesProjectionRepository = new MongoLeadControlRepository(),
    private readonly cronPort: CronPort = cron,
  ) {}

  start(): void {
    if (!this.config.syncEnabled) {
      Logger.info('Lead Control sales sync disabled');
      return;
    }
    if (this.task) return;

    this.task = this.cronPort.schedule(
      intervalCron(this.config.syncIntervalMinutes),
      async () => {
        try {
          await this.triggerNow();
        } catch (error) {
          Logger.error('Lead Control sales sync tick failed', error as Error);
        }
      },
      { scheduled: true, timezone: CAMBODIA_TIMEZONE },
    );
    Logger.info(
      `Lead Control sales sync scheduled every ${this.config.syncIntervalMinutes} minutes in ${CAMBODIA_TIMEZONE}`,
    );
  }

  /** Manual operational trigger with the same disabled and single-flight gates as cron. */
  async triggerNow(): Promise<SalesSyncResult | null> {
    if (!this.config.syncEnabled) return null;
    if (this.activeRun) return this.activeRun;

    const run = this.syncOnce();
    this.activeRun = run;
    try {
      return await run;
    } finally {
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  async stop(): Promise<void> {
    this.task?.stop();
    this.task = null;
    if (this.activeRun) {
      await this.activeRun.catch((error) => {
        Logger.error('Lead Control sales sync shutdown wait failed', error as Error);
      });
    }
    if (this.source.isConnected()) await this.source.disconnect();
  }

  private async syncOnce(): Promise<SalesSyncResult> {
    await this.source.connect();
    const service = new SyncSalesService(
      new PaymentSalesSourceRepository(this.source.collection()),
      this.repository,
    );
    const result = await service.sync();
    Logger.info(
      `Lead Control sales sync completed read=${result.read} saved=${result.saved} malformed=${result.malformed}`,
    );
    return result;
  }
}

function intervalCron(intervalMinutes: number): string {
  return intervalMinutes === 60 ? '0 * * * *' : `*/${intervalMinutes} * * * *`;
}
