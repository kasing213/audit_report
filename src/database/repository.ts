import { Collection } from 'mongodb';
import DatabaseConnection from './connection';
import { LeadEventDocument, AuditLog } from './models';

export class SalesCaseRepository {
  private db = DatabaseConnection.getInstance();
  private leadsEventsCollection: Collection<LeadEventDocument>;
  private auditCollection: Collection<AuditLog>;

  constructor() {
    const database = this.db.getDb();
    this.leadsEventsCollection = database.collection<LeadEventDocument>('leads_events');
    this.auditCollection = database.collection<AuditLog>('audit_logs');
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
