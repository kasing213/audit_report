import { Collection, ObjectId } from 'mongodb';
import DatabaseConnection from './connection';
import { LeadEventDocument, AuditLog, CustomerCase, ChangeLogDocument } from './models';
import { ensureIndexes } from './indexes';
import {
  buildCasesByFollowerAndMonthPipeline,
  buildMonthlyCasesSummaryPipeline,
  buildAllCustomersPipeline,
  buildStaleCustomersPipeline,
  buildCustomersByReasonPipeline,
  buildCustomersByTemperatureAndMonthPipeline
} from './aggregations';
import { Logger } from '../utils/logger';

export class SalesCaseRepository {
  private db = DatabaseConnection.getInstance();
  private leadsEventsCollection: Collection<LeadEventDocument>;
  private auditCollection: Collection<AuditLog>;
  private changeLogsCollection: Collection<ChangeLogDocument>;

  constructor() {
    const database = this.db.getDb();
    this.leadsEventsCollection = database.collection<LeadEventDocument>('leads_events');
    this.auditCollection = database.collection<AuditLog>('audit_logs');
    this.changeLogsCollection = database.collection<ChangeLogDocument>('change_logs');

    // Ensure indexes exist (non-blocking)
    ensureIndexes(this.leadsEventsCollection).catch(err => {
      Logger.error('Index creation warning', err as Error);
    });
  }

  async saveLeadEvent(leadEvent: LeadEventDocument): Promise<string> {
    const result = await this.leadsEventsCollection.insertOne(leadEvent);
    return result.insertedId.toString();
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

  async getCasesByFollowerAndMonth(follower: string, month: string): Promise<CustomerCase[]> {
    const pipeline = buildCasesByFollowerAndMonthPipeline(follower, month);
    return await this.leadsEventsCollection.aggregate<CustomerCase>(pipeline).toArray();
  }

  async getMonthlyCasesSummary(year: number, month: number, groupId?: string, follower?: string): Promise<CustomerCase[]> {
    const pipeline = buildMonthlyCasesSummaryPipeline(year, month, groupId, follower);
    return await this.leadsEventsCollection.aggregate<CustomerCase>(pipeline).toArray();
  }

  async findEventsByPhone(phone: string, limit: number = 10): Promise<LeadEventDocument[]> {
    if (!phone || phone.trim() === '') {
      return [];
    }

    const normalizedPhone = phone.trim();

    return await this.leadsEventsCollection
      .find({ 'customer.phone': normalizedPhone })
      .sort({ date: -1, created_at: -1 })
      .limit(limit)
      .toArray();
  }

  async updateLeadEvent(eventId: string, updates: Partial<LeadEventDocument>): Promise<boolean> {
    const result = await this.leadsEventsCollection.updateOne(
      { _id: new ObjectId(eventId) as any },
      { $set: updates }
    );
    return result.modifiedCount > 0;
  }

  async deleteLeadEvent(eventId: string): Promise<boolean> {
    const result = await this.leadsEventsCollection.deleteOne(
      { _id: new ObjectId(eventId) as any }
    );
    return result.deletedCount > 0;
  }

  async findEventById(eventId: string): Promise<LeadEventDocument | null> {
    try {
      return await this.leadsEventsCollection.findOne({ _id: new ObjectId(eventId) as any });
    } catch {
      return null;
    }
  }

  async findEventsByPromiseDate(date: string): Promise<LeadEventDocument[]> {
    return await this.leadsEventsCollection.find({
      promise_date: date,
      promise_status: 'pending'
    }).toArray();
  }

  async updatePromiseStatus(eventId: string, status: 'came' | 'didnt_come'): Promise<boolean> {
    const result = await this.leadsEventsCollection.updateOne(
      { _id: new ObjectId(eventId) as any },
      { $set: { promise_status: status } }
    );
    return result.modifiedCount > 0;
  }

  async reschedulePromise(eventId: string, newDate: string): Promise<boolean> {
    const result = await this.leadsEventsCollection.updateOne(
      { _id: new ObjectId(eventId) as any },
      { $set: { promise_date: newDate, promise_status: 'pending' as const } }
    );
    return result.modifiedCount > 0;
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

  async getAllCustomers(follower?: string): Promise<CustomerCase[]> {
    const pipeline = buildAllCustomersPipeline(follower);
    return await this.leadsEventsCollection.aggregate<CustomerCase>(pipeline).toArray();
  }

  async getStaleCustomers(days: number, follower?: string): Promise<CustomerCase[]> {
    const pipeline = buildStaleCustomersPipeline(days, follower);
    return await this.leadsEventsCollection.aggregate<CustomerCase>(pipeline).toArray();
  }

  async getCustomersByReason(reasonCode: string, follower?: string): Promise<CustomerCase[]> {
    const pipeline = buildCustomersByReasonPipeline(reasonCode, follower);
    return await this.leadsEventsCollection.aggregate<CustomerCase>(pipeline).toArray();
  }

  async getCustomersByTemperatureAndMonth(
    temperature: 'hot' | 'warm' | 'cold',
    month: string,
    follower?: string
  ): Promise<CustomerCase[]> {
    const pipeline = buildCustomersByTemperatureAndMonthPipeline(temperature, month, follower);
    return await this.leadsEventsCollection.aggregate<CustomerCase>(pipeline).toArray();
  }

  async getEventsByDateRange(
    startDate: string,
    endDate: string,
    follower?: string,
    phone?: string
  ): Promise<LeadEventDocument[]> {
    const filter: any = {
      date: { $gte: startDate, $lte: endDate }
    };
    if (follower) {
      filter.follower = follower;
    }
    if (phone) {
      const escapedPhone = phone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter['customer.phone'] = { $regex: escapedPhone, $options: 'i' };
    }
    return await this.leadsEventsCollection
      .find(filter)
      .sort({ date: -1, created_at: -1 })
      .toArray();
  }

  async saveChangeLog(log: ChangeLogDocument): Promise<void> {
    await this.changeLogsCollection.insertOne(log);
  }

  async getChangeLogs(date: string, limit: number = 100): Promise<ChangeLogDocument[]> {
    const startOfDay = new Date(date + 'T00:00:00.000Z');
    const endOfDay = new Date(date + 'T23:59:59.999Z');
    return await this.changeLogsCollection
      .find({ timestamp: { $gte: startOfDay, $lte: endOfDay } })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  }
}
