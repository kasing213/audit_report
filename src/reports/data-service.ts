import { SalesCaseRepository } from '../database/repository';
import { LeadEventDocument, CustomerCase } from '../database/models';

export class ReportDataService {
  private repository: SalesCaseRepository;

  constructor() {
    this.repository = new SalesCaseRepository();
  }

  public async getDailyLeadEvents(date: string): Promise<LeadEventDocument[]> {
    try {
      // Query by date field directly
      const db = this.repository['db'];
      const collection = db.getDb().collection<LeadEventDocument>('leads_events');
      return await collection.find({ date }).toArray();
    } catch (error) {
      console.error('Error fetching daily lead events:', error);
      return [];
    }
  }

  public async getMonthlyLeadEvents(year: number, month: number): Promise<LeadEventDocument[]> {
    try {
      const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
      // Calculate last day of month
      const lastDay = new Date(year, month, 0).getDate();
      const endDate = `${year}-${month.toString().padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

      const db = this.repository['db'];
      const collection = db.getDb().collection<LeadEventDocument>('leads_events');
      return await collection.find({
        date: { $gte: startDate, $lte: endDate }
      }).toArray();
    } catch (error) {
      console.error('Error fetching monthly lead events:', error);
      return [];
    }
  }

  public async getMonthlyCasesSummary(year: number, month: number): Promise<CustomerCase[]> {
    try {
      return await this.repository.getMonthlyCasesSummary(year, month);
    } catch (error) {
      console.error('Error fetching monthly cases summary:', error);
      return [];
    }
  }

  public async getMonthlyLeadEventsByString(monthString: string): Promise<LeadEventDocument[]> {
    try {
      const [year, month] = monthString.split('-').map(Number);
      return await this.getMonthlyLeadEvents(year, month);
    } catch (error) {
      console.error('Error parsing month string:', error);
      return [];
    }
  }
}
