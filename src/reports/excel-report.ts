import * as ExcelJS from 'exceljs';
import { ReportDataService } from './data-service';
import type { LeadEventDocument, CustomerCase } from '../database/models';
import { Logger } from '../utils/logger';
import { formatReasonDisplay } from '../constants/reason-codes';

export class ExcelReportGenerator {
  private dataService: ReportDataService;

  constructor() {
    this.dataService = new ReportDataService();
  }


  private formatTime(date: Date | null): string {
    if (!date) return 'N/A';
    return new Date(date).toLocaleTimeString();
  }

  private setupWorksheetColumns(worksheet: ExcelJS.Worksheet): void {
    worksheet.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Time Created', key: 'time_created', width: 15 },
      { header: 'Customer Name', key: 'customer_name', width: 20 },
      { header: 'Phone Number', key: 'phone_number', width: 15 },
      { header: 'Platform/Page', key: 'page', width: 15 },
      { header: 'Follower', key: 'follower', width: 15 },
      { header: 'Reason', key: 'status_text', width: 30 },
      { header: 'Source ID', key: 'telegram_msg_id', width: 15 },
      { header: 'Model', key: 'model', width: 15 }
    ];

    // Style the header row
    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell) => {
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
  }


  public async generateMonthlyReport(year: number, month: number): Promise<Buffer> {
    try {
      const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long' });
      Logger.info(`Generating monthly Excel report for ${monthName} ${year}`);

      // Fetch both case summary and event history
      const cases: CustomerCase[] = await this.dataService.getMonthlyCasesSummary(year, month);
      const events: LeadEventDocument[] = await this.dataService.getMonthlyLeadEvents(year, month);

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Audit Sales System';
      workbook.created = new Date();

      // Sheet 1: Case Summary
      const casesSheet = workbook.addWorksheet('Cases Summary');
      this.buildCasesSummarySheet(casesSheet, cases, monthName, year);

      // Sheet 2: Event History (Audit Trail)
      const eventsSheet = workbook.addWorksheet('Event History');
      this.buildEventHistorySheet(eventsSheet, events, monthName, year);

      const buffer = await workbook.xlsx.writeBuffer();
      Logger.info(`Monthly Excel report generated successfully for ${monthName} ${year}`);

      return Buffer.from(buffer);

    } catch (error) {
      Logger.error('Failed to generate Excel report', error as Error);
      throw error;
    }
  }

  private buildCasesSummarySheet(
    worksheet: ExcelJS.Worksheet,
    cases: CustomerCase[],
    monthName: string,
    year: number
  ): void {
    // Title (row 1)
    worksheet.mergeCells('A1:H1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = `Case Summary - ${monthName} ${year}`;
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
    year: number
  ): void {
    // Title (row 1)
    worksheet.mergeCells('A1:I1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = `Event History - ${monthName} ${year}`;
    titleCell.font = { size: 16, bold: true, color: { argb: 'FF007bff' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // Summary (row 2)
    worksheet.mergeCells('A2:I2');
    const summaryCell = worksheet.getCell('A2');
    summaryCell.value = `Total Lead Events: ${events.length}`;
    summaryCell.font = { size: 12, bold: true };
    summaryCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // Empty row 3
    worksheet.addRow([]);

    // Setup columns starting from row 4
    this.setupWorksheetColumns(worksheet);

    // Move headers to row 4
    const headerRow = worksheet.getRow(4);
    worksheet.columns.forEach((col, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = col.header as string;
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
      row.getCell(6).value = leadEvent.follower || 'N/A';
      row.getCell(7).value = formatReasonDisplay(leadEvent.reason_code ?? null, leadEvent.status_text);
      row.getCell(8).value = leadEvent.source.telegram_msg_id || 'N/A';
      row.getCell(9).value = leadEvent.source.model || 'N/A';

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

  public async generateMonthlyReportByString(monthString: string): Promise<Buffer> {
    const [year, month] = monthString.split('-').map(Number);
    return await this.generateMonthlyReport(year, month);
  }
}
