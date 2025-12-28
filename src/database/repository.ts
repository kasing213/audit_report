import { Collection } from 'mongodb';
import DatabaseConnection from './connection';
import { LeadEventDocument, AuditLog } from './models';
import { ensureIndexes } from './indexes';
import { Logger } from '../utils/logger';

export class SalesCaseRepository {
  private db = DatabaseConnection.getInstance();
  private leadsEventsCollection: Collection<LeadEventDocument>;
  private auditCollection: Collection<AuditLog>;

  constructor() {
    const database = this.db.getDb();
    this.leadsEventsCollection = database.collection<LeadEventDocument>('leads_events');
    this.auditCollection = database.collection<AuditLog>('audit_logs');

    // Ensure indexes exist (non-blocking)
    ensureIndexes(this.leadsEventsCollection).catch(err => {
      Logger.error('Index creation warning', err as Error);
    });
  }

  async saveLeadEvent(leadEvent: LeadEventDocument): Promise<void> {
    await this.leadsEventsCollection.insertOne(leadEvent);
  }

  async saveLeadEvents(leadEvents: LeadEventDocument[]): Promise<void> {
    if (leadEvents.length > 0) {
      await this.leadsEventsCollection.insertMany(leadEvents);
    }
  }

  async getLeadEventsByFollowerAndMonth(follower: string, month: string): Promise<LeadEventDocument[]> {
    const startDate = `${month}-01`;
    const endDate = this.getMonthEndDate(month);

    return await this.leadsEventsCollection.find({
      follower: follower,
      date: { $gte: startDate, $lte: endDate }
    }).toArray();
  }

  private getMonthEndDate(month: string): string {
    // month format: YYYY-MM
    const [year, monthNum] = month.split('-').map(Number);
    const lastDay = new Date(year, monthNum, 0).getDate();
    return `${month}-${String(lastDay).padStart(2, '0')}`;
  }

  async findLatestEventByPhone(phone: string): Promise<LeadEventDocument | null> {
    if (!phone || phone.trim() === '') {
      return null;
    }

    const normalizedPhone = phone.trim();

    const events = await this.leadsEventsCollection
      .find({ 'customer.phone': normalizedPhone })
      .sort({ date: -1, created_at: -1 })
      .limit(1)
      .toArray();

    return events.length > 0 ? events[0] : null;
  }

  async logAudit(auditLog: AuditLog): Promise<void> {
    await this.auditCollection.insertOne(auditLog);
  }

  async getAuditLogs(limit: number = 100): Promise<AuditLog[]> {
    return await this.auditCollection
      .find({})
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  }
}
