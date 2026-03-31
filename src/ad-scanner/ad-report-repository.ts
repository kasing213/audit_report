import { Collection } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { AdReportDocument, ScannerState } from './ad-report-models';
import { Logger } from '../utils/logger';

export class AdReportRepository {
  private db = DatabaseConnection.getInstance();
  private collection: Collection<AdReportDocument>;
  private stateCollection: Collection<ScannerState>;

  constructor() {
    const database = this.db.getDb();
    this.collection = database.collection<AdReportDocument>('ad_reports');
    this.stateCollection = database.collection<ScannerState>('scanner_state');

    this.ensureIndexes().catch(err => {
      Logger.error('Ad report index creation warning', err as Error);
    });
  }

  private async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ date: 1 }, { unique: true });
    Logger.info('Ad reports indexes ensured');
  }

  async save(report: AdReportDocument): Promise<string> {
    const result = await this.collection.insertOne(report);
    return result.insertedId.toString();
  }

  async findByDate(date: string): Promise<AdReportDocument | null> {
    return await this.collection.findOne({ date });
  }

  async getDateRange(startDate: string, endDate: string): Promise<AdReportDocument[]> {
    return await this.collection
      .find({ date: { $gte: startDate, $lte: endDate } })
      .sort({ date: 1 })
      .toArray();
  }

  async getLast7Days(endDate: string): Promise<AdReportDocument[]> {
    const end = new Date(endDate);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    const startDate = start.toISOString().split('T')[0];
    return this.getDateRange(startDate, endDate);
  }

  // Scanner state management
  async getLastUpdateId(): Promise<number> {
    const state = await this.stateCollection.findOne({ _id: 'ad_scanner' as any });
    return state?.last_update_id || 0;
  }

  async setLastUpdateId(updateId: number): Promise<void> {
    await this.stateCollection.updateOne(
      { _id: 'ad_scanner' as any },
      { $set: { last_update_id: updateId, updated_at: new Date() } },
      { upsert: true }
    );
  }
}
