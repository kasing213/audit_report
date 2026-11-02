import * as ExcelJS from 'exceljs';
import { ReportDataService } from './data-service';
import type { LeadEventDocument, CustomerCase } from '../database/models';
import { Logger } from '../utils/logger';
import { formatReasonDisplay } from '../constants/reason-codes';
import { cleanFollower, followerKey } from './follower-daily';

const EVENT_COLUMNS: Array<{ header: string; width: number }> = [
  { header: 'Date', width: 12 },
  { header: 'Time Created', width: 15 },
  { header: 'Customer Name', width: 20 },
  { header: 'Phone Number', width: 15 },
  { header: 'Platform/Page', width: 15 },
  { header: 'Destination', width: 15 },
  { header: 'Follower', width: 15 },
  { header: 'Reason', width: 30 },
  { header: 'Promise Date', width: 12 },
  { header: 'Promise Status', width: 14 },
  { header: 'Source ID', width: 15 },
  { header: 'Model', width: 15 }
];

/**
 * Sheet-name base for a follower: no characters Excel forbids, short enough for
 * "Events - " + base to fit 31 chars, and unique (case-insensitive, as Excel
 * compares) among bases already in `used`.
 */
export function uniqueSheetBase(name: string, used: Set<string>): string {
  const clean = name.replace(/[\\/?*[\]:]/g, '-').trim() || 'Unnamed';
  let base = clean.substring(0, 22);
  for (let n = 2; used.has(base.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    base = clean.substring(0, 22 - suffix.length) + suffix;
  }
  used.add(base.toLowerCase());
  return base;
}

export class ExcelReportGenerator {
  private _dataService?: ReportDataService;

  // Lazy: the repository needs a live DB connection at construction time.
  private get dataService(): ReportDataService {
    return this._dataService ??= new ReportDataService();
  }

  private formatTime(date: Date | null): string {
    if (!date) return 'N/A';
    return new Date(date).toLocaleTimeString();
  }

  public async generateMonthlyReport(year: number, month: number): Promise<{ buffer: Buffer; followers: string[] }> {
    try {
      const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long' });
      Logger.info(`Generating monthly Excel report for ${monthName} ${year}`);

      // Fetch all case summary and event history
      const allCases: CustomerCase[] = await this.dataService.getMonthlyCasesSummary(year, month);
      const allEvents: LeadEventDocument[] = await this.dataService.getMonthlyLeadEvents(year, month);

      const { workbook, followers } = this.buildMonthlyWorkbook(allCases, allEvents, year, month);

      const buffer = await workbook.xlsx.writeBuffer();
      Logger.info(`Monthly Excel report generated successfully for ${monthName} ${year} with ${followers.length} follower(s)`);

      return { buffer: Buffer.from(buffer), followers };

    } catch (error) {
      Logger.error('Failed to generate Excel report', error as Error);
      throw error;
    }
  }

  /** One Cases + one Events sheet per follower (trim/case-insensitive), plus Unassigned. */
  public buildMonthlyWorkbook(
    allCases: CustomerCase[],
    allEvents: LeadEventDocument[],
    year: number,
    month: number
  ): { workbook: ExcelJS.Workbook; followers: string[] } {
    const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long' });

    // Unique followers by key; first spelling seen is the display name.
    const followerNames = new Map<string, string>();
    for (const f of [...allEvents.map(e => e.follower), ...allCases.map(c => c.follower)]) {
      const key = followerKey(f);
      if (key && !followerNames.has(key)) followerNames.set(key, cleanFollower(f));
    }
    const followerKeys = Array.from(followerNames.keys())
      .sort((a, b) => followerNames.get(a)!.localeCompare(followerNames.get(b)!));
    const followers = followerKeys.map(k => followerNames.get(k)!);
    const usedSheetNames = new Set<string>();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Audit Sales System';
    workbook.created = new Date();

    // Create per-follower sheets (Cases + Events for each)
    for (const key of followerKeys) {
      const follower = followerNames.get(key)!;
      const followerCases = allCases.filter(c => followerKey(c.follower) === key);
      const followerEvents = allEvents.filter(e => followerKey(e.follower) === key);

      // Fit Excel's 31-char limit without two followers colliding
      const safeName = uniqueSheetBase(follower, usedSheetNames);

      const casesSheet = workbook.addWorksheet(`Cases - ${safeName}`);
      this.buildCasesSummarySheet(casesSheet, followerCases, monthName, year, follower);

      const eventsSheet = workbook.addWorksheet(`Events - ${safeName}`);
      this.buildEventHistorySheet(eventsSheet, followerEvents, monthName, year, follower);
    }

    // Handle events/cases with no follower assigned
    const noFollowerCases = allCases.filter(c => !followerKey(c.follower));
    const noFollowerEvents = allEvents.filter(e => !followerKey(e.follower));
    if (noFollowerCases.length > 0 || noFollowerEvents.length > 0) {
      const safeName = uniqueSheetBase('Unassigned', usedSheetNames);
      const casesSheet = workbook.addWorksheet(`Cases - ${safeName}`);
      this.buildCasesSummarySheet(casesSheet, noFollowerCases, monthName, year, 'Unassigned');

      const eventsSheet = workbook.addWorksheet(`Events - ${safeName}`);
      this.buildEventHistorySheet(eventsSheet, noFollowerEvents, monthName, year, 'Unassigned');
    }

    return { workbook, followers };
  }

  private buildCasesSummarySheet(
    worksheet: ExcelJS.Worksheet,
    cases: CustomerCase[],
    monthName: string,
    year: number,
    followerName?: string
  ): void {
    // Title (row 1)
    worksheet.mergeCells('A1:H1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = followerName
      ? `Case Summary - ${followerName} - ${monthName} ${year}`
      : `Case Summary - ${monthName} ${year}`;
    titleCell.font = { size: 16, bold: true };
    titleCell.alignment = { horizontal: 'center' };

    // Summary (row 2)
    worksheet.mergeCells('A2:H2');
    const summaryCell = worksheet.getCell('A2');
    summaryCell.value = `Total Cases: ${cases.length}`;
    summaryCell.font = { size: 12, bold: true };
    summaryCell.alignment = { horizontal: 'center' };

    // Empty row 3
    worksheet.addRow([]);

    // Headers (row 4)
    const headers = ['Phone', 'Name', 'Page', 'Follower', 'First Contact', 'Last Update', 'Current Status', 'Events'];
    const headerRow = worksheet.getRow(4);
    headers.forEach((header, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = header;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007bff' } };
      cell.font = { color: { argb: 'FFFFFF' }, bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Data rows
    cases.forEach((c, index) => {
      const row = worksheet.getRow(index + 5);
      row.getCell(1).value = c.phone || 'N/A';
      row.getCell(2).value = c.name || 'Unknown';
      row.getCell(3).value = c.page || 'N/A';
      row.getCell(4).value = c.follower || 'N/A';
      row.getCell(5).value = c.first_contact_date;
      row.getCell(6).value = c.last_update_date;
      row.getCell(7).value = formatReasonDisplay(c.current_reason_code ?? null, c.current_status);
      row.getCell(8).value = c.total_events;

      // Alternating row colors
      if ((index + 5) % 2 === 0) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
        });
      }
    });

    // Column widths
    worksheet.getColumn(1).width = 15;  // Phone
    worksheet.getColumn(2).width = 20;  // Name
    worksheet.getColumn(3).width = 15;  // Page
    worksheet.getColumn(4).width = 15;  // Follower
    worksheet.getColumn(5).width = 12;  // First Contact
    worksheet.getColumn(6).width = 12;  // Last Update
    worksheet.getColumn(7).width = 30;  // Current Status
    worksheet.getColumn(8).width = 10;  // Events
  }

  private buildEventHistorySheet(
    worksheet: ExcelJS.Worksheet,
    events: LeadEventDocument[],
    monthName: string,
    year: number,
    followerName?: string
  ): void {
    // Title (row 1)
    worksheet.mergeCells('A1:L1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = followerName
      ? `Event History - ${followerName} - ${monthName} ${year}`
      : `Event History - ${monthName} ${year}`;
    titleCell.font = { size: 16, bold: true, color: { argb: 'FF007bff' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // Summary (row 2)
    worksheet.mergeCells('A2:L2');
    const summaryCell = worksheet.getCell('A2');
    summaryCell.value = `Total Lead Events: ${events.length}`;
    summaryCell.font = { size: 12, bold: true };
    summaryCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // Empty row 3
    worksheet.addRow([]);

    // Headers (row 4). Not via worksheet.columns: that writes headers into
    // row 1 and overwrote the title above.
    const headerRow = worksheet.getRow(4);
    EVENT_COLUMNS.forEach((col, index) => {
      worksheet.getColumn(index + 1).width = col.width;
      const cell = headerRow.getCell(index + 1);
      cell.value = col.header;
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF007bff' }
      };
      cell.font = {
        color: { argb: 'FFFFFF' },
        bold: true
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    // Add data starting from row 5
    events.forEach((leadEvent, index) => {
      const row = worksheet.getRow(index + 5);
      row.getCell(1).value = leadEvent.date || '';
      row.getCell(2).value = this.formatTime(leadEvent.created_at);
      row.getCell(3).value = leadEvent.customer.name || 'N/A';
      row.getCell(4).value = leadEvent.customer.phone || 'N/A';
      row.getCell(5).value = leadEvent.page || 'N/A';
      row.getCell(6).value = leadEvent.destination || 'N/A';
      row.getCell(7).value = leadEvent.follower || 'N/A';
      row.getCell(8).value = formatReasonDisplay(leadEvent.reason_code ?? null, leadEvent.status_text);
      row.getCell(9).value = leadEvent.promise_date || 'N/A';
      row.getCell(10).value = leadEvent.promise_status || 'N/A';
      row.getCell(11).value = leadEvent.source.telegram_msg_id || 'N/A';
      row.getCell(12).value = leadEvent.source.model || 'N/A';

      if ((index + 5) % 2 === 0) {
        row.eachCell((cell) => {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF8F9FA' }
          };
        });
      }
    });
  }

  public async generateMonthlyReportByString(monthString: string): Promise<{ buffer: Buffer; followers: string[] }> {
    const [year, month] = monthString.split('-').map(Number);
    return await this.generateMonthlyReport(year, month);
  }
}
