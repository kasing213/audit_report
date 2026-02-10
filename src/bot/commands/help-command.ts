import { Context } from 'telegraf';
import { Logger } from '../../utils/logger';

export class HelpCommand {
  async handleCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id || 0;
    const chatId = ctx.chat?.id;

    try {
      Logger.info(`Help command requested by user ${userId} in chat ${chatId}`);

      const helpText = this.buildHelpMessage();
      await ctx.reply(helpText, { parse_mode: 'Markdown' });

      Logger.info(`Help message sent to user ${userId}`);
    } catch (error) {
      Logger.error('Error handling /help command', error as Error);
      await ctx.reply('Failed to display help information.');
    }
  }

  private buildHelpMessage(): string {
    const auditChatId = process.env.AUDIT_CHAT_ID;
    const summaryChatId = process.env.SUMMARY_CHAT_ID;

    return [
      '📋 *Audit Sales System - Help Documentation*',
      '',
      '🔸 *DATA ENTRY COMMANDS*',
      '',
      '📝 *Sales Entry (HDR Format)*',
      'Send a strict header format to record customer data:',
      '```',
      'HDR',
      'DATE: 2025-01-16',
      'NAME: Customer Name',
      'PHONE: 093724678',
      'PAGE: Facebook/TikTok/etc',
      'FOLLOWER: Staff Name',
      '```',
      '• Bot will ask for reason code (A-J)',
      '• Optional note (type `-` to skip)',
      '• All fields are required',
      '',
      '🔸 *QUERY COMMANDS*',
      '',
      '👥 */customers* - Get customer list',
      '• Available only in summary channel',
      '• Bot asks: follower name, then month (YYYY-MM)',
      '• Rate limit: 1 request per 2 minutes',
      '',
      '📊 */report [YYYY-MM]* - Generate monthly Excel report',
      '• Format: `/report 2025-01` or `/report` (current month)',
      '• Contains customer cases + full event history',
      '• Sent directly to requesting chat',
      '',
      '🔸 *CHAT CONFIGURATION*',
      '',
      '📡 *Audit Chat* ' + (auditChatId ? `(${auditChatId})` : '(Not configured)'),
      '• Receives automated daily JPG reports',
      '• Automated monthly Excel reports (1st of month)',
      '• Full system audit logs',
      '',
      '💬 *Summary Chat* ' + (summaryChatId ? `(${summaryChatId})` : '(Not configured)'),
      '• /customers command works here only',
      '• Manual report requests',
      '• User interaction hub',
      '',
      '🔸 *DATA FORMAT RULES*',
      '',
      '✅ *Valid HDR Example:*',
      '```',
      'HDR',
      'DATE: 2025-01-16',
      'NAME: Heng Chita',
      'PHONE: 093724678',
      'PAGE: Sun TV',
      'FOLLOWER: Srey Sros',
      '```',
      '',
      '❌ *Common Mistakes:*',
      '• Missing "HDR" header line',
      '• Wrong date format (use YYYY-MM-DD)',
      '• Missing required fields',
      '• Extra or duplicate fields',
      '',
      '🔸 *REASON CODES*',
      '',
      'After sending HDR, choose ONE reason:',
      'A - ទំនាក់ទំនង (contacted)',
      'B - ចាប់អារម្មណ៍ (interested)',
      'C - ពិចារណា (considering)',
      'D - ធ្វើការណាត់ជួប (appointment)',
      'E - បានទៅមើល (visited)',
      'F - ចរចារ (negotiating)',
      'G - ព្រមព្រៀង (agreed)',
      'H - កុង្ត្រា (contract)',
      'I - បដិសេធ (rejected)',
      'J - បាត់បង់ (lost)',
      '',
      '🔸 *SYSTEM INFO*',
      '',
      '⏰ *Automated Reports:*',
      '• Daily JPG: 11:59 PM → Audit chat',
      '• Monthly Excel: 1st day 12:01 AM → Audit chat',
      '',
      '🌐 *Manual Access:*',
      '• API Health: `/health`',
      '• Web reports available via API endpoints',
      '',
      '📞 *Support:*',
      'Check system logs or contact administrator',
      'All interactions are logged for audit purposes',
      '',
      '---',
      '💡 *Quick Start: Send HDR format → Choose A-J → Add note*'
    ].join('\n');
  }
}