import { Context } from 'telegraf';
import { Logger } from '../../utils/logger';

export class HelpCommand {

  async handleCommand(ctx: Context, isSalesChat: boolean = false): Promise<void> {
    const userId = ctx.from?.id || 0;
    const chatId = ctx.chat?.id;

    try {
      Logger.info(`Help command requested by user ${userId} in chat ${chatId} (sales: ${isSalesChat})`);

      if (isSalesChat) {
        await ctx.reply(this.buildSalesHelpMessage(), { parse_mode: 'Markdown' });
        // Single-customer /add template (line-by-line flow)
        await ctx.reply(this.buildCopyTemplate());
        // Bulk daily follow-up report template (paste into web dashboard)
        await ctx.reply(this.buildBulkCopyTemplate());
      } else {
        await ctx.reply(this.buildManagementHelpMessage(), { parse_mode: 'Markdown' });
      }

      Logger.info(`${isSalesChat ? 'Sales' : 'Management'} help message sent to user ${userId}`);
    } catch (error) {
      Logger.error('Error handling /help command', error as Error);
      await ctx.reply('Failed to display help information.');
    }
  }

  private buildBulkCopyTemplate(): string {
    return [
      '#របាយការណ៍ថ្ងៃទី DD/M/YY',
      '<FollowerName>',
      '🚩Pae<page description>',
      '',
      'A.Follow',
      '  1.Messege=0',
      '     a.Night=0',
      '     b.PV=0',
      '  3.Fack=0',
      '  6.Liked=0',
      '  9.Phone=0',
      '',
      'Tel1=<phone>',
      '   Name=<name>',
      '   Pv=<province>',
      '   a.ថ្លៃពេក=',
      '   b.ទីតាំងមិនត្រូវ=',
      '   i.ចាំរកថ្ងៃទំនេរមកមើល=',
      '   j.ផ្សេងៗ=',
      'Tel2=',
      '   Name=',
      '   Pv=',
      'Tel3=',
      '   Name=',
      '   Pv=',
      '',
      '/🥰10 .Dating visit (សន្យាមកមើល)',
      '   1/លេខទូរស័ព្ =<phone>',
      '      a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង  <time> DD/M/YY',
      '      b.ថ្ងៃ.ខែ.ឆ្នាំទាក់ទងដំបូង',
      '         1/1-3day=',
      '         2/4-7day=',
      '   2/លេខទូរស័ព្ =',
      '      a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង='
    ].join('\n');
  }

  private buildSalesHelpMessage(): string {
    const baseUrl = (process.env.DASHBOARD_BASE_URL || '<BASE_URL>').replace(/\/$/, '');
    return [
      '📋 *មគ្គុទេសក៍បញ្ចូលទិន្នន័យការលក់*',
      '',
      '🔸 *របៀបបញ្ចូលទិន្នន័យអតិថិជន*',
      '',
      'វាយ /add រួចបំពេញម្តងមួយជំហាន៖',
      '',
      '1️⃣ 📅 *កាលបរិច្ឆេទ* (YYYY-MM-DD)',
      '2️⃣ 👤 *ឈ្មោះអតិថិជន*',
      '3️⃣ 📞 *លេខទូរស័ព្ទ*',
      '4️⃣ 📄 *ប្រភព* (Facebook, TikTok, Sun TV, ...)',
      '5️⃣ 📨 *មធ្យោបាយ* (Telegram, Messenger, Walk-in, Call, ...)',
      '6️⃣ 🔤 *លេខកូដមូលហេតុ* (A–J)',
      '7️⃣ 📝 *ចំណាំ* ឬវាយ `-` ដើម្បីរំលង',
      '8️⃣ 📅 *ថ្ងៃសន្យា* (YYYY-MM-DD ឬវាយ `-` ដើម្បីរំលង)',
      '',
      '✅ ឈ្មោះអ្នកតាមដាន (Follower) កំណត់ស្វ័យប្រវត្តិតាមក្រុម',
      '',
      '🔸 *កែ/លុបទិន្នន័យ*',
      '',
      '✏️ */edit* - កែទិន្នន័យអតិថិជន (ឈ្មោះ ទូរស័ព្ទ មូលហេតុ...)',
      '🗑️ */delete* - លុបទិន្នន័យអតិថិជន',
      '',
      '⚠️ *ចំណាំសំខាន់*',
      '',
      '• បញ្ចូលម្តងមួយអតិថិជន',
      '• ទិន្នន័យផុតកំណត់ក្នុង ៥ នាទី បើមិនបំពេញ',
      '• បើខុស សូមវាយ /edit ដើម្បីកែ ឬ /delete ដើម្បីលុប',
      '',
      '🔸 *របាយការណ៍ប្រចាំថ្ងៃ (Bulk follow-up)*',
      '',
      `🧾 *Bulk paste:* \`${baseUrl}/data-entry/bulk\``,
      '• បិទភ្ជាប់របាយការណ៍ប្រចាំថ្ងៃដើម្បីបញ្ចូលអតិថិជនច្រើននាក់ក្នុងពេលតែមួយ',
      '• ទំរង់របាយការណ៍សូមចម្លងពីសារខាងក្រោម'
    ].join('\n');
  }

  private buildCopyTemplate(): string {
    return [
      '/add',
      '→ 2026-02-11',
      '→ Sok Dara',
      '→ 093724678',
      '→ Facebook',
      '→ Messenger',
      '→ A',
      '→ —',
      '→ —'
    ].join('\n');
  }

  private buildManagementHelpMessage(): string {
    const auditChatId = process.env.AUDIT_CHAT_ID;
    const summaryChatId = process.env.SUMMARY_CHAT_ID;

    return [
      '📊 *ប្រព័ន្ធគ្រប់គ្រងការលក់ - សម្រាប់អ្នកគ្រប់គ្រង*',
      '',
      '🔸 *ពាក្យបញ្ជាសម្រាប់របាយការណ៍និងវិភាគ*',
      '',
      '📊 */summary [YYYY-MM] [follower]* - មើលសង្ខេបការលក់',
      '• ទម្រង់៖ `/summary 2025-01` ឬ `/summary` (ខែបច្ចុប្បន្ន)',
      '• តម្រង follower៖ `/summary 2025-01 Kasing` ឬ `/summary Kasing`',
      '• សំរាប់វិភាគ ROI និង CRM',
      '',
      '👥 */customers* - មើលបញ្ជីអតិថិជន',
      '• ទម្រង់៖ ឈ្មោះអ្នកតាមដាន ខែ(YYYY-MM)',
      '• កំណត់ពេល៖ ១ សំណើក្នុងរយៈពេល ២ នាទី',
      '',
      '📝 */report [YYYY-MM]* - បង្កើតរបាយការណ៍ Excel ប្រចាំខែ',
      '• ទម្រង់៖ `/report 2025-01` ឬ `/report` (ខែបច្ចុប្បន្ន)',
      '• រួមបញ្ចូល៖ Sheet នីមួយៗតាម follower (Cases + Events)',
      '• សម្រាប់វិភាគលម្អិត',
      '',
      '📲 */crm* - CRM តាមដានអតិថិជន',
      '• មើលអតិថិជនទាំងអស់ជាមួយតំណ Telegram ដែលចុចបាន',
      '• តម្រង៖ stale (មិនទាក់ទងយូរ), មូលហេតុ A-J',
      '• ចុចលេខទូរស័ព្ទ → បើកការសន្ទនា Telegram',
      '',
      '🔥 */hot*, 🌤️ */warm*, ❄️ */cold* - បញ្ជីអតិថិជនតាមកម្តៅ',
      '• បញ្ជីខែបច្ចុប្បន្ន (current month)',
      '• ពង្រីកដោយឈ្មោះ follower៖ `/hot SreySros`',
      '',
      '♻️ */reclassify <phone> [hot|warm|cold]*',
      '• `/reclassify 093724678` — បង្ហាញជាថ្មីដោយ classifier',
      '• `/reclassify 093724678 hot` — កំណត់ដោយដៃ',
      '',
      '✏️ */edit* - កែទិន្នន័យអតិថិជន',
      '• ស្វែងរកតាមលេខទូរស័ព្ទ → ជ្រើសរើសកំណត់ត្រា → កែវាល',
      '',
      '🗑️ */delete* - លុបទិន្នន័យអតិថិជន',
      '• ស្វែងរកតាមលេខទូរស័ព្ទ → ជ្រើសរើសកំណត់ត្រា → បញ្ជាក់ការលុប',
      '',
      '🔸 *ការកំណត់កន្លែង Chat*',
      '',
      '📡 *ក្រុម Audit* ' + (auditChatId ? `(${auditChatId})` : '(មិនបានកំណត់)'),
      '• ទទួលរបាយការណ៍ស្វ័យប្រវត្តិជារូបភាព JPG ប្រចាំថ្ងៃ',
      '• ទទួលរបាយការណ៍ស្វ័យប្រវត្តិ Excel ប្រចាំខែ (ថ្ងៃទី១)',
      '• ទទួលកំណត់ត្រាសកម្មភាពទាំងអស់',
      '',
      '💬 *ក្រុម Summary* ' + (summaryChatId ? `(${summaryChatId})` : '(មិនបានកំណត់)'),
      '• ពាក្យបញ្ជាគ្រប់គ្រងទាំងអស់ដំណើរការនៅទីនេះ',
      '• សុំរបាយការណ៍ដោយដៃ',
      '• កន្លែងសម្រាប់អ្នកគ្រប់គ្រង និង CRM',
      '',
      '🏢 *ក្រុម Sales* (7 ក្រុម)',
      '• វាយ `/add` ដើម្បីបញ្ចូលទិន្នន័យអតិថិជន',
      '• Follower កំណត់ស្វ័យប្រវត្តិតាមក្រុម',
      '• វាយ `/help` ក្នុងក្រុម Sales ដើម្បីមើលមគ្គុទេសក៍',
      '• SreySros, Bery, Theary, Seyi, Pheaktra, Borey, Pisey',
      '',
      '🔸 *ព័ត៌មានប្រព័ន្ធ*',
      '',
      '⏰ *របាយការណ៍ស្វ័យប្រវត្តិ៖*',
      '• របាយការណ៍ប្រចាំថ្ងៃ (JPG)៖ ម៉ោង 11:59 យប់ → ក្រុម Audit',
      '• របាយការណ៍ប្រចាំខែ (Excel)៖ ថ្ងៃទី១ ម៉ោង 12:01 ព្រឹក → ក្រុម Audit',
      '• ការរំលឹកសន្យា៖ ម៉ោង 8:00 ព្រឹក → ក្រុម Audit (Promise Reminders)',
      '',
      '🌐 *ការចូលប្រើប្រាស់ដោយដៃ៖*',
      '• ពិនិត្យសុខភាពប្រព័ន្ធ៖ `/health`',
      '• របាយការណ៍តាម API endpoints',
      '',
      '📞 *ការជួយដោះស្រាយ៖*',
      'សូមពិនិត្យកំណត់ត្រាប្រព័ន្ធ ឬ ទាក់ទងអ្នកគ្រប់គ្រងប្រព័ន្ធ',
      'គ្រប់សកម្មភាពទាំងអស់ត្រូវបានកត់ត្រាសម្រាប់ការតាមដាន',
      '',
      '---',
      '💡 *សម្រាប់អ្នកគ្រប់គ្រង៖ បញ្ជាទិន្នន័យតាមក្រុម + វិភាគ ROI*'
    ].join('\n');
  }
}
