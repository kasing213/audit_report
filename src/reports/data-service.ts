import { SalesCaseRepository } from '../database/repository';
import { SalesCaseDocument } from '../database/models';

export class ReportDataService {
  private repository: SalesCaseRepository;

  constructor() {
    this.repository = new SalesCaseRepository();
  }

  public async getDailySalesCases(date: string): Promise<SalesCaseDocument[]> {
    try {
      return await this.repository.getSalesCasesByDate(date);
    } catch (error) {
      console.error('Error fetching daily sales cases:', error);
      return [];
    }
  }

  public async getMonthlySalesCases(year: number, month: number): Promise<SalesCaseDocument[]> {
    try {
      const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
      const endDate = `${year}-${month.toString().padStart(2, '0')}-31`;
      return await this.repository.getSalesCasesByDateRange(startDate, endDate);
    } catch (error) {
      console.error('Error fetching monthly sales cases:', error);
      return [];
    }
  }

  public async getMonthlySalesCasesByString(monthString: string): Promise<SalesCaseDocument[]> {
    try {
      const [year, month] = monthString.split('-').map(Number);
      return await this.getMonthlySalesCases(year, month);
    } catch (error) {
      console.error('Error parsing month string:', error);
      return [];
    }
  }
}