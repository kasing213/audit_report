import { Collection } from 'mongodb';
import DatabaseConnection from './connection';
import { SalesCaseDocument, AuditLog } from './models';

export class SalesCaseRepository {
  private db = DatabaseConnection.getInstance();
  private salesCollection: Collection<SalesCaseDocument>;
  private auditCollection: Collection<AuditLog>;

  constructor() {
    const database = this.db.getDb();
    this.salesCollection = database.collection<SalesCaseDocument>('sales_cases');
    this.auditCollection = database.collection<AuditLog>('audit_logs');
  }

  async saveSalesCase(salesCase: SalesCaseDocument): Promise<void> {
    await this.salesCollection.insertOne(salesCase);
  }

  async saveSalesCases(salesCases: SalesCaseDocument[]): Promise<void> {
    if (salesCases.length > 0) {
      await this.salesCollection.insertMany(salesCases);
    }
  }

  async logAudit(auditLog: AuditLog): Promise<void> {
    await this.auditCollection.insertOne(auditLog);
  }

  async getSalesCasesByDate(date: string): Promise<SalesCaseDocument[]> {
    return await this.salesCollection.find({ date }).toArray();
  }

  async getSalesCasesByDateRange(startDate: string, endDate: string): Promise<SalesCaseDocument[]> {
    return await this.salesCollection.find({
      date: { $gte: startDate, $lte: endDate }
    }).toArray();
  }

  async getSalesCasesByCreatedAtRange(start: Date, end: Date): Promise<SalesCaseDocument[]> {
    return await this.salesCollection.find({
      created_at: { $gte: start, $lte: end }
    }).toArray();
  }

  async getAuditLogs(limit: number = 100): Promise<AuditLog[]> {
    return await this.auditCollection
      .find({})
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  }
}
