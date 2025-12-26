import * as ExcelJS from 'exceljs';
import { ReportDataService } from './data-service';
import type { LeadEventDocument } from '../database/models';
import { Logger } from '../utils/logger';

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
      { header: 'Status', key: 'status_text', width: 30 },
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

      const leadEvents: LeadEventDocument[] = await this.dataService.getMonthlyLeadEvents(year, month);

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Audit Sales System';
      workbook.created = new Date();

      const worksheet = workbook.addWorksheet(`${monthName} ${year} Sales`);

      // Add title
      worksheet.mergeCells('A1:I1');
      const titleCell = worksheet.getCell('A1');
      titleCell.value = `Sales Report - ${monthName} ${year}`;
      titleCell.font = { size: 16, bold: true, color: { argb: 'FF007bff' } };
      titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

      // Add summary
      worksheet.mergeCells('A2:I2');
      const summaryCell = worksheet.getCell('A2');
      summaryCell.value = `Total Lead Events: ${leadEvents.length}`;
      summaryCell.font = { size: 12, bold: true };
      summaryCell.alignment = { vertical: 'middle', horizontal: 'center' };

      // Add empty row
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
      leadEvents.forEach((leadEvent, index) => {
        const row = worksheet.getRow(index + 5);
        row.getCell(1).value = leadEvent.date || '';
        row.getCell(2).value = this.formatTime(leadEvent.created_at);
        row.getCell(3).value = leadEvent.customer.name || 'N/A';
        row.getCell(4).value = leadEvent.customer.phone || 'N/A';
        row.getCell(5).value = leadEvent.page || 'N/A';
        row.getCell(6).value = leadEvent.follower || 'N/A';
        row.getCell(7).value = leadEvent.status_text || 'N/A';
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

      const buffer = await workbook.xlsx.writeBuffer();
      Logger.info(`Monthly Excel report generated successfully for ${monthName} ${year}`);

      return Buffer.from(buffer);

    } catch (error) {
      Logger.error('Failed to generate Excel report', error as Error);
      throw error;
    }
  }

  public async generateMonthlyReportByString(monthString: string): Promise<Buffer> {
    const [year, month] = monthString.split('-').map(Number);
    return await this.generateMonthlyReport(year, month);
  }
}
