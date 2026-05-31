import { SalesCaseRepository } from '../database/repository';
import { LeadEventDocument, CustomerCase } from '../database/models';
import { getZonedDayRangeUtc } from '../utils/time';

export class ReportDataService {
  private repository: SalesCaseRepository;

  constructor() {
    this.repository = new SalesCaseRepository();
  }

  public async getDailyLeadEvents(date: string, groupId?: string): Promise<LeadEventDocument[]> {
    try {
      // Query by date field directly
      const db = this.repository['db'];
      const collection = db.getDb().collection<LeadEventDocument>('leads_events');

      const query: any = { date };
      if (groupId) {
        query.group_id = groupId;
      }

      return await collection.find(query).toArray();
    } catch (error) {
      console.error('Error fetching daily lead events:', error);
      return [];
    }
  }

  /**
   * Lead events by the day they were *entered* (created_at), windowed to the
   * full calendar day `entryDate` in `timezone`. This is what the daily group
   * report uses: staff log a day's cases over the following days, so "yesterday's
   * report" means "everything logged yesterday" — never empty at send time.
   */
  public async getLeadEventsByEntryDay(entryDate: string, groupId?: string, timezone?: string): Promise<LeadEventDocument[]> {
    try {
      const range = getZonedDayRangeUtc(entryDate, timezone);
      if (!range) return [];

      const db = this.repository['db'];
      const collection = db.getDb().collection<LeadEventDocument>('leads_events');

      const query: any = {
        created_at: { $gte: range.start, $lt: range.end },
        deleted: { $ne: true }
      };
      if (groupId) {
        query.group_id = groupId;
      }

      return await collection.find(query).sort({ created_at: 1 }).toArray();
    } catch (error) {
      console.error('Error fetching lead events by entry day:', error);
      return [];
    }
  }

  public async getMonthlyLeadEvents(year: number, month: number, groupId?: string, follower?: string): Promise<LeadEventDocument[]> {
    try {
      const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
      // Calculate last day of month
      const lastDay = new Date(year, month, 0).getDate();
      const endDate = `${year}-${month.toString().padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

      const db = this.repository['db'];
      const collection = db.getDb().collection<LeadEventDocument>('leads_events');

      const query: any = {
        date: { $gte: startDate, $lte: endDate }
      };
      if (groupId) {
        query.group_id = groupId;
      }
      if (follower) {
        query.follower = follower;
      }

      return await collection.find(query).toArray();
    } catch (error) {
      console.error('Error fetching monthly lead events:', error);
      return [];
    }
  }

  public async getMonthlyCasesSummary(year: number, month: number, groupId?: string, follower?: string): Promise<CustomerCase[]> {
    try {
      return await this.repository.getMonthlyCasesSummary(year, month, groupId, follower);
    } catch (error) {
      console.error('Error fetching monthly cases summary:', error);
      return [];
    }
  }

  public async getMonthlyLeadEventsByString(monthString: string, groupId?: string): Promise<LeadEventDocument[]> {
    try {
      const [year, month] = monthString.split('-').map(Number);
      return await this.getMonthlyLeadEvents(year, month, groupId);
    } catch (error) {
      console.error('Error parsing month string:', error);
      return [];
    }
  }
}
