import { PDFParse } from 'pdf-parse';
import { ParsedAdReport, CampaignMetrics, PagePerformance } from './ad-report-models';
import { Logger } from '../utils/logger';

function parseNumber(str: string): number {
  return parseFloat(str.replace(/[$,]/g, ''));
}

function parseCampaignRows(text: string): CampaignMetrics[] {
  const campaigns: CampaignMetrics[] = [];

  // Find the campaign table section between header row and "Page Performance"
  const headerMatch = text.match(/Campaign\s+Spend\s+Clicks\s+Impr\.\s+CTR\s+CPC\s+CPM\s+Reach/i);
  const pageMatch = text.match(/Page Performance/i);

  if (!headerMatch || !pageMatch || headerMatch.index === undefined || pageMatch.index === undefined) {
    return campaigns;
  }

  const tableSection = text.substring(headerMatch.index + headerMatch[0].length, pageMatch.index).trim();
  if (!tableSection) return campaigns;

  // Extract numeric values: $6.77 96 2,288 4.20% $0.07 $2.96 1,897
  const valuePattern = /\$([0-9,.]+)\s+([0-9,]+)\s+([0-9,]+)\s+([0-9.]+)%\s+\$([0-9,.]+)\s+\$([0-9,.]+)\s+([0-9,]+)/;
  const valueMatch = tableSection.match(valuePattern);

  if (valueMatch) {
    // Everything before the first $ sign is the campaign name
    const nameEndIndex = tableSection.indexOf('$');
    const name = tableSection.substring(0, nameEndIndex).replace(/\s+/g, ' ').trim();

    campaigns.push({
      name: name || 'Unknown Campaign',
      spend: parseNumber(valueMatch[1]),
      clicks: parseNumber(valueMatch[2]),
      impressions: parseNumber(valueMatch[3]),
      ctr: parseFloat(valueMatch[4]),
      cpc: parseNumber(valueMatch[5]),
      cpm: parseNumber(valueMatch[6]),
      reach: parseNumber(valueMatch[7]),
    });
  }

  return campaigns;
}

function parsePagePerformance(text: string): PagePerformance {
  const pageNameMatch = text.match(/Page:\s*(.+?)(?:\n|Page Impressions)/s);
  const pageName = pageNameMatch ? pageNameMatch[1].trim() : 'Unknown Page';

  const metricsMatch = text.match(
    /Page Impressions:\s*([0-9,]+)\s*\|\s*Post Impressions:\s*([0-9,]+)\s*\|\s*Engaged Users:\s*([0-9,]+)/
  );

  return {
    page_name: pageName,
    page_impressions: metricsMatch ? parseNumber(metricsMatch[1]) : 0,
    post_impressions: metricsMatch ? parseNumber(metricsMatch[2]) : 0,
    engaged_users: metricsMatch ? parseNumber(metricsMatch[3]) : 0,
  };
}

export async function parseAdReportPdf(buffer: Buffer): Promise<ParsedAdReport> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  const text = result.text;
  await parser.destroy();

  Logger.info('PDF text extracted, parsing...');

  // Date
  const dateMatch = text.match(/Date:\s*(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) {
    throw new Error('Could not extract date from PDF');
  }
  const date = dateMatch[1];

  // Totals
  const totalsMatch = text.match(
    /Total Spend:\s*\$([0-9,.]+)\s*\|\s*Clicks:\s*([0-9,]+)\s*\|\s*Impressions:\s*([0-9,]+)\s*\|\s*Reach:\s*([0-9,]+)\s*\|\s*CTR:\s*([0-9.]+)%/
  );

  if (!totalsMatch) {
    throw new Error('Could not extract totals from PDF');
  }

  // Campaigns
  const campaigns = parseCampaignRows(text);

  // Page Performance
  const pagePerformance = parsePagePerformance(text);

  // Report generated timestamp
  const generatedMatch = text.match(/Report generated on\s*(.+?)(?:\n|$)/);
  const reportGeneratedAt = generatedMatch ? generatedMatch[1].trim() : '';

  return {
    date,
    total_spend: parseNumber(totalsMatch[1]),
    total_clicks: parseNumber(totalsMatch[2]),
    total_impressions: parseNumber(totalsMatch[3]),
    total_reach: parseNumber(totalsMatch[4]),
    total_ctr: parseFloat(totalsMatch[5]),
    campaigns,
    page_performance: pagePerformance,
    report_generated_at: reportGeneratedAt,
  };
}
