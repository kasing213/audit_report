import { AdReportDocument, DailyCorrelation } from './ad-report-models';

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function formatTrend(value: number | null): string {
  if (value === null) return 'N/A';
  const arrow = value >= 0 ? '\u2191' : '\u2193';
  return `${arrow}${Math.abs(value).toFixed(1)}%`;
}

export function formatDailySummary(
  report: AdReportDocument,
  correlation?: DailyCorrelation
): string {
  const lines: string[] = [];

  lines.push(`\ud83d\udcca Facebook Ads Report \u2014 ${report.date}`);
  lines.push('');

  // Ad Performance
  lines.push('\ud83d\udcb0 Ad Performance');
  lines.push(`Spend: ${formatCurrency(report.total_spend)} | Clicks: ${formatNumber(report.total_clicks)} | CTR: ${report.total_ctr.toFixed(2)}%`);

  if (report.campaigns.length > 0) {
    const c = report.campaigns[0];
    lines.push(`CPC: ${formatCurrency(c.cpc)} | CPM: ${formatCurrency(c.cpm)} | Reach: ${formatNumber(c.reach)}`);
    lines.push(`Campaign: ${c.name}`);
  }

  lines.push('');

  // Page Performance
  const p = report.page_performance;
  lines.push(`\ud83d\udcf1 Page: ${p.page_name} (Organic)`);
  lines.push(`Page Impr: ${formatNumber(p.page_impressions)} | Post Impr: ${formatNumber(p.post_impressions)} | Engaged: ${formatNumber(p.engaged_users)}`);

  // Correlation with sales
  if (correlation) {
    lines.push('');
    lines.push('\ud83d\udd17 Sales Correlation');
    lines.push(`Leads today: ${correlation.total_leads} | Cost per lead: ${correlation.cost_per_lead !== null ? formatCurrency(correlation.cost_per_lead) : 'N/A'}`);

    if (correlation.avg_cost_per_lead_7d !== null) {
      lines.push(`7-day avg: ${formatCurrency(correlation.avg_cost_per_lead_7d)}/lead`);
    }

    if (correlation.spend_trend_7d !== null || correlation.leads_trend_7d !== null) {
      const spendTrend = formatTrend(correlation.spend_trend_7d);
      const leadsTrend = formatTrend(correlation.leads_trend_7d);
      lines.push(`7-day trend: Spend ${spendTrend} | Leads ${leadsTrend}`);
    }
  }

  return lines.join('\n');
}
