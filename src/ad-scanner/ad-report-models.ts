export interface CampaignMetrics {
  name: string;
  spend: number;
  clicks: number;
  impressions: number;
  ctr: number;
  cpc: number;
  cpm: number;
  reach: number;
}

export interface PagePerformance {
  page_name: string;
  page_impressions: number;
  post_impressions: number;
  engaged_users: number;
}

export interface AdReportDocument {
  _id?: string;
  date: string;
  total_spend: number;
  total_clicks: number;
  total_impressions: number;
  total_reach: number;
  total_ctr: number;
  campaigns: CampaignMetrics[];
  page_performance: PagePerformance;
  source: {
    telegram_msg_id: number;
    file_id: string;
    caption: string;
  };
  report_generated_at: string;
  created_at: Date;
}

export interface ParsedAdReport {
  date: string;
  total_spend: number;
  total_clicks: number;
  total_impressions: number;
  total_reach: number;
  total_ctr: number;
  campaigns: CampaignMetrics[];
  page_performance: PagePerformance;
  report_generated_at: string;
}

export interface ScannerState {
  _id: string;
  last_update_id: number;
  updated_at: Date;
}

export interface DailyCorrelation {
  date: string;
  total_spend: number;
  total_leads: number;
  cost_per_lead: number | null;
  spend_trend_7d: number | null;
  leads_trend_7d: number | null;
  avg_cost_per_lead_7d: number | null;
}
