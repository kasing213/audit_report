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
        // Bulk daily follow-up report template — split across two messages to
        // stay under Telegram's 4096-char per-message cap.
        await ctx.reply(this.buildBulkCopyTemplatePart1());
        await ctx.reply(this.buildBulkCopyTemplatePart2());
      } else {
        await ctx.reply(this.buildManagementHelpMessage(), { parse_mode: 'Markdown' });
      }

      Logger.info(`${isSalesChat ? 'Sales' : 'Management'} help message sent to user ${userId}`);
    } catch (error) {
      Logger.error('Error handling /help command', error as Error);
      await ctx.reply('Failed to display help information.');
    }
  }

  private buildBulkCopyTemplatePart1(): string {
    return [
      '💞Follow up',
      '#របាយការណ៍ថ្ងៃទី DD/M/YY',
      '(ធ្វើប្រចាំថ្ងៃបន្ទាប់មុនម៉ោង10ព្រឹក ទោះចំថ្ងៃសំរាកក៏ដោយ)',
      '',
      '🚩Page <page description>',
      'A.Follow (Boots Page)',
      '    1.Messege=0',
      '       a.Night(ទទួលពេលយប់)=',
      '       b.PV(ភ្ញៀវខេត្ត)=',
      '      👉បរិយាយខេត្តណា=',
      '   2.ភ្ញៀវចូលគ្រប់ផេក=',
      '   3.Fack(ក្លែងក្លាយ)=',
      '   4.ភ្ញៀវធ្លាប់ទាក់ទងក្នុងMesseger=0',
      '   5.ភ្ញៀវចាស់ធ្លាប់មើលគំរោងរួច=',
      '   6.Liked(ចុចមេដៃ)=0',
      '   7.Other(ផ្សេងៗ)=',
      '☎️9.Phone (ចំនួនលេខទូរស័ព្ទ)=',
      'Tel1=<phone>',
      '       Name=<name>',
      '            Pv=<province>',
      'Tel2=',
      '       Name=',
      '           Pv=',
      'Tel3=',
      '       Name=',
      '           Pv=',
      'Tel4=',
      '       Name=',
      '           Pv=',
      'Tel5=',
      '       Name=',
      '           Pv=',
      'Tel6=',
      '       Name=',
      '           Pv=',
      'Tel7=',
      '       Name=',
      '          Pv=',
      'Tel8=',
      '       Name=',
      '          Pv=',
      'Tel9=',
      '       Name=',
      '         Pv=',
      'Tel10=',
      '       Name=',
      '           Pv=',
      '    a.Messagerវ៉ៃលេខចូល=',
      '      1/Connected by message=',
      '      2/Connected by telegram=',
      '      3/Connected by Phone=',
      '      4/Connected by other=',
      '    b.Comment=',
      '      1/Connected by message=',
      '      2/Connected by telegram=',
      '      3/Connected by Phone=',
      '      4/Connected by other=',
      '    c.Call in=',
      '       1/Connected by message=',
      '       2/Connected by telegram=',
      '       3/Connected by Phone=',
      '       4/Connected by other=',
      '    d Group=',
      '       1/Connected by message=',
      '       2/Connected by telegram=',
      '       3/Connected by Phone=',
      '       4/Connected by other=',
      '    e.Telegram=',
      '       1/Connected by message=',
      '       2/Connected by telegram=',
      '       3/Connected by Phone=',
      '       4/Connected by other=',
      '    f Other=',
      '       1/Connected by message=',
      '       2/Connected by telegram=',
      '       3/Connected by Phone=',
      '       4/Connected by other='
    ].join('\n');
  }

  private buildBulkCopyTemplatePart2(): string {
    return [
      '  👉 g.ភ្ញៀវឆ្លើយតបដូចខាងក្រោម',
      '    Tel1=',
      '      a.ថ្លៃពេក=',
      '      b.ទីតាំងមិនត្រូវ=',
      '      c ខ្ញុំមិនមែនអ្នកសំរេច=',
      '      d គ្មានចំណាប់អារម្មណ៍=',
      '      e.ត្រូវការកម្ចីច្រើន=',
      '      f.ជំពាក់គេច្រើន=',
      '      g.ខូចCBC=',
      '      h.ដីរឺផ្ទះតូចពេក=',
      '      I.ចាំរកថ្ងៃទំនេរមកមើល=',
      '      j.ផ្សេងៗ=',
      '  Tel2=',
      '      a.ថ្លៃពេក=',
      '      b.ទីតាំងមិនត្រូវ=',
      '      c ខ្ញុំមិនមែនអ្នកសំរេច=',
      '      d គ្មានចំណាប់អារម្មណ៍=',
      '      e.ត្រូវការកម្ចីច្រើន=',
      '      f.ជំពាក់គេច្រើន=',
      '      g.ខូចCBC=',
      '      h.ដីរឺផ្ទះតូចពេក=',
      '      I.ចាំរកថ្ងៃទំនេរមកមើល=',
      '      j.ផ្សេងៗ=',
      '  Tel3=',
      '      a.ថ្លៃពេក=',
      '      b.ទីតាំងមិនត្រូវ=',
      '      j.ផ្សេងៗ=',
      '  Tel4=',
      '      a.ថ្លៃពេក=',
      '      j.ផ្សេងៗ=',
      '  Tel5=',
      '      a.ថ្លៃពេក=',
      '      j.ផ្សេងៗ=',
      '  Tel6=',
      '      a.ថ្លៃពេក=',
      '      j.ផ្សេងៗ=',
      '  Tel7=',
      '      a.ថ្លៃពេក=',
      '      j.ផ្សេងៗ=',
      '  Tel8=',
      '      a.ថ្លៃពេក=',
      '      j.ផ្សេងៗ=',
      '  Tel9=',
      '      a.ថ្លៃពេក=',
      '      j.ផ្សេងៗ=',
      '  Tel10=',
      '      a.ថ្លៃពេក=',
      '      j.ផ្សេងៗ=',
      '',
      '🥰10 .Dating visit (សន្យាមកមើល)',
      '   1/លេខទូរស័ព្ =<phone>',
      '       a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង= <time> DD/M/YY',
      '       b.ថ្ងៃ.ខែ.ឆ្នាំទាក់ទងដំបូង',
      '          1/1-3day=',
      '          2/4-7day=',
      '          3/8-15day=',
      '          4/16-31day=',
      '          5/1-3month=',
      '          6/3-6month=',
      '          7/6-12month=',
      '          8/Over12month=',
      '   2/លេខទូរស័ព្ទ=',
      '       a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង=',
      '   3/លេខទូរស័ព្ទ=',
      '       a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង='
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
      '• ទំរង់របាយការណ៍សូមចម្លងពីសារ ២ ខាងក្រោម (Part 1 + Part 2)'
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
