import { Context } from 'telegraf';
import { ReportDataService } from '../../reports/data-service';
import { GroupConfigManager } from '../../utils/group-config';
import { Logger } from '../../utils/logger';
import { formatReasonDisplay } from '../../constants/reason-codes';

export class SummaryCommand {
  private dataService: ReportDataService;
  private groupConfigManager: GroupConfigManager;

  constructor() {
    this.dataService = new ReportDataService();
    this.groupConfigManager = GroupConfigManager.getInstance();
  }

  async handleCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id || 0;
    const chatId = ctx.chat?.id;
    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';

    try {
      Logger.info(`Summary command requested by user ${userId} in chat ${chatId}: ${messageText}`);

      // Parse command arguments: /summary [YYYY-MM] [follower name]
      const args = messageText.trim().split(' ');
      let monthString: string;
      let followerFilter: string | undefined;

      if (args.length > 1) {
        if (/^\d{4}-\d{2}$/.test(args[1])) {
          // First arg is a month: /summary 2026-02 [follower]
          monthString = args[1];
          if (args.length > 2) {
            followerFilter = args.slice(2).join(' ');
          }
        } else {
          // First arg is not a date, treat as follower name: /summary Kasing
          const now = new Date();
          const year = now.getFullYear();
          const month = String(now.getMonth() + 1).padStart(2, '0');
          monthString = `${year}-${month}`;
          followerFilter = args.slice(1).join(' ');
        }
      } else {
        // Default to current month, all followers
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        monthString = `${year}-${month}`;
      }

      // Validate month format
      if (!/^\d{4}-\d{2}$/.test(monthString)) {
        await ctx.reply(
          '❌ Invalid month format.\n\nUse: `/summary YYYY-MM`\nExample: `/summary 2025-01`\n\nOr just `/summary` for current month.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Validate month is not in the future
      const [year, month] = monthString.split('-').map(Number);
      const requestedDate = new Date(year, month - 1);
      const now = new Date();
      const currentMonth = new Date(now.getFullYear(), now.getMonth());

      if (requestedDate > currentMonth) {
        await ctx.reply(
          '❌ Cannot generate summaries for future months.\n\nPlease select a month from the past or current month.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Show processing message
      const processingMsg = await ctx.reply(
        `📊 Generating summary for ${monthString}...\n\nThis may take a moment.`,
        { parse_mode: 'Markdown' }
      );

      try {
        // Determine if this is a group-specific request
        const groupId = chatId ? this.groupConfigManager.getGroupIdFromChatId(chatId) : null;
        const groupConfig = groupId ? this.groupConfigManager.getGroupConfig(groupId) : null;

        // Generate the summary
        const summaryText = await this.generateSummaryText(monthString, groupId, groupConfig?.name, followerFilter);

        // Delete processing message
        await ctx.deleteMessage(processingMsg.message_id);

        // Send the summary
        await ctx.reply(summaryText, { parse_mode: 'Markdown' });

        const logMsg = groupId
          ? `Summary sent for ${monthString} to group ${groupConfig?.name} (${groupId})`
          : `Summary sent for ${monthString} to chat ${chatId}`;
        Logger.info(logMsg);

      } catch (summaryError) {
        Logger.error('Error generating summary', summaryError as Error);

        // Delete processing message and show error
        await ctx.deleteMessage(processingMsg.message_id);

        await ctx.reply(
          '❌ Failed to generate summary.\n\nPlease try again later or contact administrator.',
          { parse_mode: 'Markdown' }
        );
      }

    } catch (error) {
      Logger.error('Error handling /summary command', error as Error);
      await ctx.reply('❌ Failed to process summary request.');
    }
  }

  private async generateSummaryText(monthString: string, groupId: string | null, groupName?: string, follower?: string): Promise<string> {
    const [year, month] = monthString.split('-').map(Number);
    const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long' });

    // Fetch data (with optional follower filter)
    const leadEvents = await this.dataService.getMonthlyLeadEvents(year, month, groupId || undefined, follower);
    const cases = await this.dataService.getMonthlyCasesSummary(year, month, groupId || undefined, follower);

    // Build summary header
    const isGroupSpecific = groupId !== null;
    const isFollowerSpecific = !!follower;
    let title: string;
    if (isFollowerSpecific) {
      title = `📊 **${follower} - Summary - ${monthName} ${year}**`;
    } else if (isGroupSpecific) {
      title = `📊 **${groupName || groupId} Sales Summary - ${monthName} ${year}**`;
    } else {
      title = `📊 **Complete Audit Summary - ${monthName} ${year}**`;
    }

    // Calculate statistics
    const totalEvents = leadEvents.length;
    const uniqueCustomers = new Set(leadEvents.map(e => e.customer.phone)).size;

    // Group by follower
    const followerStats: { [key: string]: number } = {};
    leadEvents.forEach(event => {
      const follower = event.follower || 'Unknown';
      followerStats[follower] = (followerStats[follower] || 0) + 1;
    });

    // Group by reason
    const reasonStats: { [key: string]: number } = {};
    leadEvents.forEach(event => {
      const reason = formatReasonDisplay(event.reason_code ?? null, event.status_text);
      reasonStats[reason] = (reasonStats[reason] || 0) + 1;
    });

    // Group by date for daily breakdown (show only if data exists)
    const dailyStats: { [key: string]: number } = {};
    leadEvents.forEach(event => {
      const date = event.date || 'Unknown';
      dailyStats[date] = (dailyStats[date] || 0) + 1;
    });

    // Build summary text
    let summary = `${title}\n\n`;

    // Overview section
    summary += `**📋 Overview:**\n`;
    summary += `• Total Events: ${totalEvents}\n`;
    summary += `• Unique Customers: ${uniqueCustomers}\n`;
    summary += `• Total Cases: ${cases.length}\n\n`;

    if (totalEvents === 0) {
      summary += `ℹ️ No sales data found for this period.`;
      return summary;
    }

    // Top performers section
    if (Object.keys(followerStats).length > 0) {
      summary += `**👥 Performance by Follower:**\n`;
      const sortedFollowers = Object.entries(followerStats)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5);

      sortedFollowers.forEach(([follower, count], index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '•';
        summary += `${medal} ${follower}: ${count} events\n`;
      });
      summary += '\n';
    }

    // Status breakdown section
    if (Object.keys(reasonStats).length > 0) {
      summary += `**📊 Status Breakdown:**\n`;
      const sortedReasons = Object.entries(reasonStats)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5);

      sortedReasons.forEach(([reason, count]) => {
        summary += `• ${reason}: ${count}\n`;
      });
      summary += '\n';
    }

    // Recent activity (last 7 days with data)
    if (Object.keys(dailyStats).length > 0) {
      summary += `**📅 Recent Activity:**\n`;
      const sortedDates = Object.entries(dailyStats)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 7);

      sortedDates.forEach(([date, count]) => {
        summary += `• ${date}: ${count} events\n`;
      });
      summary += '\n';
    }

    // Footer
    let scope: string;
    if (isFollowerSpecific) {
      scope = `follower ${follower}`;
    } else if (isGroupSpecific) {
      scope = `${groupName || groupId} group`;
    } else {
      scope = 'all groups';
    }
    summary += `📌 Summary generated for **${scope}** on ${new Date().toLocaleDateString()}`;

    return summary;
  }
}