import { Context } from 'telegraf';
import { ExcelReportGenerator } from '../../reports/excel-report';
import { Logger } from '../../utils/logger';

export class ReportCommand {
  private excelGenerator: ExcelReportGenerator;

  constructor() {
    this.excelGenerator = new ExcelReportGenerator();
  }

  async handleCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id || 0;
    const chatId = ctx.chat?.id;
    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';

    try {
      Logger.info(`Report command requested by user ${userId} in chat ${chatId}: ${messageText}`);

      // Parse command arguments
      const args = messageText.trim().split(' ');
      let monthString: string;

      if (args.length > 1) {
        // /report YYYY-MM format
        monthString = args[1];
        if (!/^\d{4}-\d{2}$/.test(monthString)) {
          await ctx.reply(
            '❌ Invalid month format.\n\nUse: `/report YYYY-MM`\nExample: `/report 2025-01`\n\nOr just `/report` for current month.',
            { parse_mode: 'Markdown' }
          );
          return;
        }
      } else {
        // Default to current month
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        monthString = `${year}-${month}`;
      }

      // Validate month is not in the future
      const [year, month] = monthString.split('-').map(Number);
      const requestedDate = new Date(year, month - 1);
      const now = new Date();
      const currentMonth = new Date(now.getFullYear(), now.getMonth());

      if (requestedDate > currentMonth) {
        await ctx.reply(
          '❌ Cannot generate reports for future months.\n\nPlease select a month from the past or current month.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Show processing message
      const processingMsg = await ctx.reply(
        `📊 Generating monthly Excel report for ${monthString}...\n\nThis may take a few moments.`,
        { parse_mode: 'Markdown' }
      );

      try {
        // Generate the Excel report
        const { buffer: excelBuffer, followers } = await this.excelGenerator.generateMonthlyReportByString(monthString);

        if (excelBuffer.length === 0) {
          throw new Error('Generated report is empty');
        }

        const filename = `monthly-report-${monthString}.xlsx`;

        // Build dynamic sheet listing
        const sheetList = followers.length > 0
          ? followers.map(f => `• ${f}: Cases + Events`).join('\n')
          : '• No follower data found';

        // Send the Excel file
        await ctx.replyWithDocument({
          source: excelBuffer,
          filename: filename
        }, {
          caption: [
            `📊 *Monthly Report - ${monthString}*`,
            '',
            `📋 ${followers.length} Follower(s):`,
            sheetList,
            '',
            `📅 Generated: ${new Date().toLocaleString()}`,
            `👤 Requested by: ${ctx.from?.username || ctx.from?.first_name || 'Unknown'}`
          ].join('\n'),
          parse_mode: 'Markdown'
        });

        // Delete processing message
        await ctx.deleteMessage(processingMsg.message_id);

        Logger.info(`Monthly Excel report sent successfully for ${monthString} to user ${userId}`);

      } catch (reportError) {
        Logger.error('Error generating report', reportError as Error);

        // Delete processing message and show error
        await ctx.deleteMessage(processingMsg.message_id);

        await ctx.reply(
          '❌ Failed to generate monthly report.\n\nPlease try again later or contact administrator.',
          { parse_mode: 'Markdown' }
        );
      }

    } catch (error) {
      Logger.error('Error handling /report command', error as Error);
      await ctx.reply('❌ Failed to process report request.');
    }
  }
}