import { Collection } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { LeadEventDocument } from '../database/models';
import { AdReportRepository } from './ad-report-repository';
import { DailyCorrelation } from './ad-report-models';

export class AdCorrelationService {
  private adRepo: AdReportRepository;
  private leadsCollection: Collection<LeadEventDocument>;

  constructor(adRepo: AdReportRepository) {
    this.adRepo = adRepo;
    const database = DatabaseConnection.getInstance().getDb();
    this.leadsCollection = database.collection<LeadEventDocument>('leads_events');
  }

  async getDailyCorrelation(date: string): Promise<DailyCorrelation> {
    const adReport = await this.adRepo.findByDate(date);
    const leadCount = await this.leadsCollection.countDocuments({ date });

    const totalSpend = adReport?.total_spend || 0;
    const costPerLead = leadCount > 0 ? totalSpend / leadCount : null;

    // 7-day trends
    const last7Days = await this.adRepo.getLast7Days(date);
    const endDate = new Date(date);
    const startDate7d = new Date(endDate);
    startDate7d.setDate(startDate7d.getDate() - 6);
    const startDateStr = startDate7d.toISOString().split('T')[0];

    const leads7d = await this.leadsCollection.countDocuments({
      date: { $gte: startDateStr, $lte: date },
    });

    const spend7d = last7Days.reduce((sum, r) => sum + r.total_spend, 0);
    const avgCostPerLead7d = leads7d > 0 ? spend7d / leads7d : null;

    // Calculate trends (compare this week vs previous week)
    let spendTrend7d: number | null = null;
    let leadsTrend7d: number | null = null;

    const prevStart = new Date(startDate7d);
    prevStart.setDate(prevStart.getDate() - 7);
    const prevEnd = new Date(startDate7d);
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStartStr = prevStart.toISOString().split('T')[0];
    const prevEndStr = prevEnd.toISOString().split('T')[0];

    const prevReports = await this.adRepo.getDateRange(prevStartStr, prevEndStr);
    const prevLeads = await this.leadsCollection.countDocuments({
      date: { $gte: prevStartStr, $lte: prevEndStr },
    });

    const prevSpend = prevReports.reduce((sum, r) => sum + r.total_spend, 0);

    if (prevSpend > 0) {
      spendTrend7d = ((spend7d - prevSpend) / prevSpend) * 100;
    }
    if (prevLeads > 0) {
      leadsTrend7d = ((leads7d - prevLeads) / prevLeads) * 100;
    }

    return {
      date,
      total_spend: totalSpend,
      total_leads: leadCount,
      cost_per_lead: costPerLead,
      spend_trend_7d: spendTrend7d,
      leads_trend_7d: leadsTrend7d,
      avg_cost_per_lead_7d: avgCostPerLead7d,
    };
  }
}
