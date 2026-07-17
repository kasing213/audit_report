import { Collection, ObjectId } from 'mongodb';
import DatabaseConnection from './connection';
import { LeadEventDocument, AuditLog, CustomerCase, ChangeLogDocument, DailySummaryDocument } from './models';
import { ensureIndexes } from './indexes';
import {
  buildCasesByFollowerAndMonthPipeline,
  buildMonthlyCasesSummaryPipeline,
  buildAllCustomersPipeline,
  buildQuickBookCustomersPipeline,
  buildStaleCustomersPipeline,
  buildCustomersByReasonPipeline,
  buildCustomersByTemperatureAndMonthPipeline
} from './aggregations';
import { Logger } from '../utils/logger';
import { OrgId, DEFAULT_ORG, orgMatch } from '../outreach/orgs';

export class SalesCaseRepository {
  private db = DatabaseConnection.getInstance();
  private leadsEventsCollection: Collection<LeadEventDocument>;
  private auditCollection: Collection<AuditLog>;
  private changeLogsCollection: Collection<ChangeLogDocument>;
  private dailySummariesCollection: Collection<DailySummaryDocument>;

  constructor() {
    const database = this.db.getDb();
    this.leadsEventsCollection = database.collection<LeadEventDocument>('leads_events');
    this.auditCollection = database.collection<AuditLog>('audit_logs');
    this.changeLogsCollection = database.collection<ChangeLogDocument>('change_logs');
    this.dailySummariesCollection = database.collection<DailySummaryDocument>('daily_summaries');

    // Ensure indexes exist (non-blocking)
    ensureIndexes(this.leadsEventsCollection).catch(err => {
      Logger.error('Index creation warning', err as Error);
    });
  }

  async saveLeadEvent(leadEvent: LeadEventDocument): Promise<string> {
    const result = await this.leadsEventsCollection.insertOne(leadEvent);
    return result.insertedId.toString();
  }

  async saveLeadEvents(leadEvents: LeadEventDocument[]): Promise<string[]> {
    if (leadEvents.length === 0) return [];
    const result = await this.leadsEventsCollection.insertMany(leadEvents);
    return Object.values(result.insertedIds).map(id => id.toString());
  }

  async saveDailySummary(summary: DailySummaryDocument): Promise<string> {
    const result = await this.dailySummariesCollection.insertOne(summary);
    return result.insertedId.toString();
  }

  async getLeadEventsByFollowerAndMonth(follower: string, month: string): Promise<LeadEventDocument[]> {
    const startDate = `${month}-01`;
    const endDate = this.getMonthEndDate(month);

    return await this.leadsEventsCollection.find({
      follower: follower,
      date: { $gte: startDate, $lte: endDate },
      org_id: orgMatch(DEFAULT_ORG)
    }).toArray();
  }

  private getMonthEndDate(month: string): string {
    // month format: YYYY-MM
    const [year, monthNum] = month.split('-').map(Number);
    const lastDay = new Date(year, monthNum, 0).getDate();
    return `${month}-${String(lastDay).padStart(2, '0')}`;
  }

  async findLatestEventByPhone(phone: string, orgId?: OrgId): Promise<LeadEventDocument | null> {
    if (!phone || phone.trim() === '') {
      return null;
    }

    const normalizedPhone = phone.trim();
    const filter: Record<string, unknown> = { 'customer.phone': normalizedPhone };
    if (orgId) filter.org_id = orgMatch(orgId);

    const events = await this.leadsEventsCollection
      .find(filter)
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

  /**
   * Look up prior events that match any of the given phone numbers.
   * Handles both exact match and legacy slash-joined storage (e.g. an old
   * record saved as "0123/0987" matches when querying "0123").
   * Caller is expected to pass already-normalized phones.
   */
  async findEventsByPhones(phones: string[], limit: number = 20): Promise<LeadEventDocument[]> {
    const cleaned = phones.map(p => (p ?? '').trim()).filter(Boolean);
    if (cleaned.length === 0) return [];

    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const or: Array<Record<string, unknown>> = [];
    for (const p of cleaned) {
      or.push({ 'customer.phone': p });
      // Substring match for legacy slash-joined records. Anchored to digit
      // boundaries so "0123" doesn't accidentally match "01234".
      or.push({ 'customer.phone': { $regex: `(^|/)${escapeRegex(p)}(/|$)` } });
    }
    return await this.leadsEventsCollection
      .find({ $or: or, deleted: { $ne: true } })
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

  async getAllCustomers(follower?: string, orgId: OrgId = DEFAULT_ORG): Promise<CustomerCase[]> {
    const pipeline = buildAllCustomersPipeline(follower, orgId);
    return await this.leadsEventsCollection.aggregate<CustomerCase>(pipeline).toArray();
  }

  async getStaleCustomers(days: number, follower?: string, orgId: OrgId = DEFAULT_ORG): Promise<CustomerCase[]> {
    const pipeline = buildStaleCustomersPipeline(days, follower, orgId);
    return await this.leadsEventsCollection.aggregate<CustomerCase>(pipeline).toArray();
  }

  async getQuickBookCustomers(
    page: number,
    pageSize: number,
    orgId: OrgId = DEFAULT_ORG
  ): Promise<{ customers: CustomerCase[]; total: number }> {
    const pipeline = buildQuickBookCustomersPipeline(page, pageSize, orgId);
    const [result] = await this.leadsEventsCollection
      .aggregate<{ data: CustomerCase[]; meta: { total: number }[] }>(pipeline)
      .toArray();
    return { customers: result?.data ?? [], total: result?.meta?.[0]?.total ?? 0 };
  }

  async getCustomersByReason(reasonCode: string, follower?: string, orgId: OrgId = DEFAULT_ORG): Promise<CustomerCase[]> {
    const pipeline = buildCustomersByReasonPipeline(reasonCode, follower, orgId);
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
    // Report/export path — Company-only.
    const filter: any = {
      date: { $gte: startDate, $lte: endDate },
      org_id: orgMatch(DEFAULT_ORG)
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

  private async findLatestActiveEventByPhone(phone: string): Promise<LeadEventDocument | null> {
    const normalizedPhone = phone.trim();
    const events = await this.leadsEventsCollection
      .find({ 'customer.phone': normalizedPhone, deleted: { $ne: true } })
      .sort({ date: -1, created_at: -1 })
      .limit(1)
      .toArray();
    return events.length > 0 ? events[0] : null;
  }

  async updateCustomerLatest(
    phone: string,
    updates: { follower?: string | null; reason_code?: string | null; note?: string | null },
    actor: string
  ): Promise<{ success: boolean; updated_event_id?: string; error?: string }> {
    const event = await this.findLatestActiveEventByPhone(phone);
    if (!event) {
      return { success: false, error: 'Customer not found' };
    }

    const eventId = (event._id as any).toString();
    const setPayload: any = {};
    const changes: Array<{ field: string; old_value: any; new_value: any }> = [];

    if ('follower' in updates) {
      setPayload.follower = updates.follower;
      changes.push({ field: 'follower', old_value: event.follower, new_value: updates.follower });
    }
    if ('reason_code' in updates) {
      setPayload.reason_code = updates.reason_code;
      changes.push({ field: 'reason_code', old_value: event.reason_code, new_value: updates.reason_code });
    }
    if ('note' in updates) {
      setPayload.note = updates.note;
      changes.push({ field: 'note', old_value: event.note, new_value: updates.note });
    }

    await this.leadsEventsCollection.updateOne(
      { _id: new ObjectId(eventId) as any },
      { $set: setPayload }
    );

    await this.saveChangeLog({
      timestamp: new Date(),
      action: 'update',
      event_id: eventId,
      event_summary: {
        customer_name: event.customer.name,
        customer_phone: event.customer.phone,
        date: event.date,
        follower: event.follower
      },
      changes,
      actor
    });

    return { success: true, updated_event_id: eventId };
  }

  async softDeleteCustomerByPhone(
    phone: string,
    actor: string
  ): Promise<{ success: boolean; events_deleted: number; error?: string }> {
    const latestEvent = await this.findLatestActiveEventByPhone(phone);
    if (!latestEvent) {
      return { success: false, events_deleted: 0, error: 'Customer not found' };
    }

    const eventId = (latestEvent._id as any).toString();

    const result = await this.leadsEventsCollection.updateMany(
      { 'customer.phone': phone.trim(), deleted: { $ne: true } },
      { $set: { deleted: true, deleted_at: new Date(), deleted_by: actor } }
    );

    await this.saveChangeLog({
      timestamp: new Date(),
      action: 'delete',
      event_id: eventId,
      event_summary: {
        customer_name: latestEvent.customer.name,
        customer_phone: latestEvent.customer.phone,
        date: latestEvent.date,
        follower: latestEvent.follower
      },
      snapshot: latestEvent,
      actor
    });

    return { success: true, events_deleted: result.modifiedCount };
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
