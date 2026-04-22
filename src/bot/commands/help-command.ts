import { Context } from 'telegraf';
import { Logger } from '../../utils/logger';
import { GroupConfigManager } from '../../utils/group-config';
import { getTodayDate } from '../../utils/time';

export class HelpCommand {

  async handleCommand(ctx: Context, isSalesChat: boolean = false): Promise<void> {
    const userId = ctx.from?.id || 0;
    const chatId = ctx.chat?.id;

    try {
      Logger.info(`Help command requested by user ${userId} in chat ${chatId} (sales: ${isSalesChat})`);

      if (isSalesChat) {
        const follower = this.getFollowerForChat(chatId) || 'YourName';
        const dateIso = getTodayDate();
        const dateShort = this.isoToDdMmYy(dateIso);
        await ctx.reply(this.buildSalesHelpMessage(), { parse_mode: 'Markdown' });
        // Bulk template comes FIRST (primary workflow: end-of-day full report).
        await ctx.reply(this.buildBulkCopyTemplate(follower, dateShort));
        // /add template SECOND (alternative: quick single-customer entry).
        await ctx.reply(this.buildCopyTemplate(dateIso, follower));
      } else {
        await ctx.reply(this.buildManagementHelpMessage(), { parse_mode: 'Markdown' });
      }

      Logger.info(`${isSalesChat ? 'Sales' : 'Management'} help message sent to user ${userId}`);
    } catch (error) {
      Logger.error('Error handling /help command', error as Error);
      await ctx.reply('Failed to display help information.');
    }
  }

  private getFollowerForChat(chatId: number | undefined): string | null {
    if (chatId == null) return null;
    const gm = GroupConfigManager.getInstance();
    const groupId = gm.getGroupIdFromChatId(chatId);
    if (!groupId) return null;
    return gm.getGroupConfig(groupId)?.name ?? null;
  }

  private isoToDdMmYy(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${parseInt(d, 10)}/${parseInt(m, 10)}/${y.slice(-2)}`;
  }

  private buildBulkCopyTemplate(follower: string, date: string): string {
    // Empty skeleton for Tel2..Tel10 — phone/name/Pv only. Reps add `a.ថ្លៃពេក=1`
    // (or any other a–j line) under a slot when that lead has a rejection reason.
    const blankSlot = (n: number) => [
      `Tel${n}=`,
      '   Name=',
      '   Pv=',
      ''
    ];
    const blanks: string[] = [];
    for (let n = 2; n <= 10; n++) blanks.push(...blankSlot(n));

    return [
      '📋 សារទី ១ — ទំរង់ Bulk (របាយការណ៍ប្រចាំថ្ងៃ)',
      'កែឬលុបឧទាហរណ៍ រួចចម្លងទាំងអស់ទៅកាន់ទំព័រ Bulk',
      '',
      '💞Follow up',
      `#របាយការណ៍ថ្ងៃទី${date}`,
      follower,
      '🚩Page ឈ្មោះផេករបស់អ្នក',
      '',
      'A.Follow (Boots Page)',
      '   1.Messege=0',
      '      a.Night=',
      '      b.PV=',
      '   3.Fack=0',
      '   6.Liked=0',
      '   9.Phone=',
      '',
      'B.ប្រភពទំនាក់ទំនង (Connected by)',
      '   a.Messenger=0',
      '   b.Comment=0',
      '   c.Call in=0',
      '   d.Group=0',
      '   e.Telegram=0',
      '   f.Other=0',
      '',
      '# ── ឧទាហរណ៍ Tel1 (កែជាទិន្នន័យរបស់អ្នក ឬលុបដើម្បីទុកបន្ទាត់ទទេ) ──',
      'Tel1=012345678',
      '   Name=Sok Dara',
      '   Pv=PP',
      '   a.ថ្លៃពេក=1',
      '   b.ទីតាំងមិនត្រូវ=',
      '   c ខ្ញុំមិនមែនអ្នកសំរេច=',
      '   d គ្មានចំណាប់អារម្មណ៍=',
      '   e.ត្រូវការកម្ចីច្រើន=',
      '   f.ជំពាក់គេច្រើន=',
      '   g.ខូចCBC=',
      '   h.ដីរឺផ្ទះតូចពេក=',
      '   I.ចាំរកថ្ងៃទំនេរមកមើល=',
      '   j.ផ្សេងៗ=',
      '',
      ...blanks,
      '🥰10 .Dating visit (សន្យាមកមើល)',
      '# ── ឧទាហរណ៍: Tel1 សន្យាមកមើលម៉ោង 2pm ──',
      '   1/លេខទូរស័ព្ =012345678',
      `      a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង= 2pm ${date}`,
      '      1/1-3day=1',
      '   2/លេខទូរស័ព្ទ=',
      '      a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង=',
      '   3/លេខទូរស័ព្ទ=',
      '      a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង='
    ].join('\n');
  }

  private buildSalesHelpMessage(): string {
    const baseUrl = (process.env.DASHBOARD_BASE_URL || '<BASE_URL>').replace(/\/$/, '');
    return [
      '📋 *មគ្គុទេសក៍បញ្ចូលទិន្នន័យការលក់*',
      '',
      'បន្ទាប់ពីសារនេះ Bot នឹងផ្ញើទំរង់ ២ មកឲ្យ៖',
      '  • *សារទី ១* — ទំរង់ Bulk (របាយការណ៍ប្រចាំថ្ងៃ)',
      '  • *សារទី ២* — ទំរង់ /add (បញ្ចូលអតិថិជនម្តងមួយ)',
      '',
      '━━━━━━━━━━━━━━━━━━━━━',
      '🔸 *១. Bulk — របាយការណ៍ប្រចាំថ្ងៃ (មួយថ្ងៃ/មួយដង)*',
      '',
      `🧾 *Bulk paste:* \`${baseUrl}/data-entry/bulk\``,
      '',
      '1️⃣ ចម្លង *សារទី ១* ខាងក្រោម',
      '2️⃣ កែទិន្នន័យ Tel1..Tel10 ជំនួសឧទាហរណ៍ (លេខ ឈ្មោះ ខេត្ត មូលហេតុ a–j)',
      '3️⃣ បើក link ខាងលើ → បិទភ្ជាប់ → ចុច *Parse Preview* → បញ្ជាក់ *Confirm Import*',
      '',
      '💡 មូលហេតុ a–j៖ ដាក់ `=1` នៅបន្ទាត់ដែលត្រូវ (ឧ. `a.ថ្លៃពេក=1`)',
      '💡 Connected by៖ ដាក់ចំនួនក្នុងបន្ទាត់ a–f (ឧ. `a.Messenger=3`)',
      '⚠️ បន្ទាត់ដែលចាប់ផ្តើមដោយ `#` ជាឧទាហរណ៍ — លុបចេញ ឬទុកក៏បានដែរ',
      '✅ ឈ្មោះ follower និងកាលបរិច្ឆេទបំពេញស្វ័យប្រវត្តិ',
      '',
      '━━━━━━━━━━━━━━━━━━━━━',
      '🔸 *២. /add — បញ្ចូលអតិថិជនម្តងមួយ (សំរាប់ករណីបន្ទាន់)*',
      '',
      'វាយ /add ក្នុងក្រុមនេះ ហើយ Bot សួរម្តងមួយជំហាន៖',
      '📅 កាលបរិច្ឆេទ → 👤 ឈ្មោះ → 📞 ទូរស័ព្ទ → 📄 ប្រភព → 📨 មធ្យោបាយ',
      '→ 🔤 មូលហេតុ A–J → 📝 ចំណាំ → 📅 ថ្ងៃសន្យា',
      '',
      'ឬ ចម្លង *សារទី ២* ខាងក្រោម រួចកែទិន្នន័យ រួចផ្ញើជាសារតែមួយ។',
      '',
      '━━━━━━━━━━━━━━━━━━━━━',
      '🔸 *កែ/លុប*',
      '',
      '✏️ */edit* — កែទិន្នន័យអតិថិជន (ស្វែងរកតាមលេខទូរស័ព្ទ)',
      '🗑️ */delete* — លុបទិន្នន័យអតិថិជន',
      '',
      '⚠️ *ចំណាំ*៖ ទិន្នន័យ /add ផុតកំណត់ក្នុង ៥ នាទី បើមិនបំពេញ — Bulk មិនផុតកំណត់។'
    ].join('\n');
  }

  private buildCopyTemplate(dateIso: string, _follower: string): string {
    return [
      '📋 សារទី ២ — ទំរង់ /add (អតិថិជនតែម្នាក់)',
      'ចម្លង កែទិន្នន័យ រួចផ្ញើជាសារក្នុងក្រុមនេះ',
      '',
      '/add',
      `→ ${dateIso}`,
      '→ Sok Dara',
      '→ 012345678',
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
    const followers = GroupConfigManager.getInstance().getAllFollowerNames();
    const sampleFollower = followers[0] || 'SreySros';
    const salesGroupCount = followers.length;
    const salesGroupsLine = followers.length ? followers.join(', ') : '(none configured)';

    return [
      '📊 *ប្រព័ន្ធគ្រប់គ្រងការលក់ - សម្រាប់អ្នកគ្រប់គ្រង*',
      '',
      '🔸 *ពាក្យបញ្ជាសម្រាប់របាយការណ៍និងវិភាគ*',
      '',
      '📊 */summary [YYYY-MM] [follower]* - មើលសង្ខេបការលក់',
      '• ទម្រង់៖ `/summary 2025-01` ឬ `/summary` (ខែបច្ចុប្បន្ន)',
      `• តម្រង follower៖ \`/summary 2025-01 ${sampleFollower}\` ឬ \`/summary ${sampleFollower}\``,
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
      `• ពង្រីកដោយឈ្មោះ follower៖ \`/hot ${sampleFollower}\``,
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
      `🏢 *ក្រុម Sales* (${salesGroupCount} ក្រុម)`,
      '• វាយ `/add` ឬបិទភ្ជាប់ទំរង់ Bulk ដើម្បីបញ្ចូលទិន្នន័យអតិថិជន',
      '• Follower កំណត់ស្វ័យប្រវត្តិតាមក្រុម',
      '• វាយ `/help` ក្នុងក្រុម Sales ដើម្បីមើលមគ្គុទេសក៍',
      `• ${salesGroupsLine}`,
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
      `• Bulk follow-up paste: \`${(process.env.DASHBOARD_BASE_URL || '<BASE_URL>').replace(/\/$/, '')}/data-entry/bulk\``,
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
