import { Context } from 'telegraf';
import { Logger } from '../../utils/logger';

export class HelpCommand {

  async handleCommand(ctx: Context, isSalesChat: boolean = false): Promise<void> {
    const userId = ctx.from?.id || 0;
    const chatId = ctx.chat?.id;

    try {
      Logger.info(`Help command requested by user ${userId} in chat ${chatId} (sales: ${isSalesChat})`);

      const helpText = isSalesChat
        ? this.buildSalesHelpMessage()
        : this.buildManagementHelpMessage();
      await ctx.reply(helpText, { parse_mode: 'Markdown' });

      Logger.info(`${isSalesChat ? 'Sales' : 'Management'} help message sent to user ${userId}`);
    } catch (error) {
      Logger.error('Error handling /help command', error as Error);
      await ctx.reply('Failed to display help information.');
    }
  }

  private buildSalesHelpMessage(): string {
    return [
      '📋 *មគ្គុទេសក៍បញ្ចូលទិន្នន័យការលក់*',
      '',
      '🔸 *របៀបបញ្ចូលទិន្នន័យអតិថិជន*',
      '',
      'សូមផ្ញើសារតាមទម្រង់ HDR ដូចខាងក្រោម៖',
      '',
      '```',
      'HDR',
      'DATE: 2025-01-16',
      'NAME: ឈ្មោះអតិថិជន',
      'PHONE: 012345678',
      'PAGE: Facebook',
      'FOLLOWER: ឈ្មោះអ្នកតាមដាន',
      '```',
      '',
      '🔸 *ការពន្យល់វាល*',
      '',
      '• *DATE* - កាលបរិច្ឆេទ (YYYY-MM-DD)',
      '• *NAME* - ឈ្មោះអតិថិជន',
      '• *PHONE* - លេខទូរស័ព្ទអតិថិជន',
      '• *PAGE* - ប្រភព (Facebook, TikTok, ...)',
      '• *FOLLOWER* - ឈ្មោះអ្នកទទួលខុសត្រូវ',
      '',
      '🔸 *ជំហានបន្ទាប់ពីបញ្ចូល HDR*',
      '',
      '1️⃣ ជ្រើសរើស *លេខកូដមូលហេតុ* (A–J) ពីក្ដារចុច',
      '2️⃣ បន្ថែម *ចំណាំ* ឬវាយ `-` ដើម្បីរំលង',
      '3️⃣ ទិន្នន័យត្រូវបានរក្សាទុកដោយស្វ័យប្រវត្តិ ✅',
      '',
      '⚠️ *ចំណាំសំខាន់*',
      '',
      '• សូមបំពេញគ្រប់វាលឲ្យបានត្រឹមត្រូវ',
      '• បើខកខានបំពេញ ប្រព័ន្ធនឹងប្រាប់កំហុស',
      '• ទិន្នន័យផុតកំណត់ក្នុង ៥ នាទី បើមិនបំពេញ',
      '',
      '---',
      '💡 *បញ្ចូលទិន្នន័យម្តងមួយអតិថិជន ដើម្បីភាពត្រឹមត្រូវ*'
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
      '📊 */summary [YYYY-MM]* - មើលសង្ខេបការលក់',
      '• ទម្រង់៖ `/summary 2025-01` ឬ `/summary` (ខែបច្ចុប្បន្ន)',
      '• ចែកតាមក្រុម៖ ការលក់ពីក្រុមនីមួយៗ',
      '• សំរាប់វិភាគ ROI និង CRM',
      '',
      '👥 */customers* - មើលបញ្ជីអតិថិជន',
      '• ទម្រង់៖ ឈ្មោះអ្នកតាមដាន ខែ(YYYY-MM)',
      '• កំណត់ពេល៖ ១ សំណើក្នុងរយៈពេល ២ នាទី',
      '',
      '📝 */report [YYYY-MM]* - បង្កើតរបាយការណ៍ Excel ប្រចាំខែ',
      '• ទម្រង់៖ `/report 2025-01` ឬ `/report` (ខែបច្ចុប្បន្ន)',
      '• រួមបញ្ចូល៖ ទិន្នន័យអតិថិជន + ប្រវត្តិព្រឹត្តិការណ៍ពេញលេញ',
      '• សម្រាប់វិភាគលម្អិត',
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
      '• សម្រាប់បញ្ចូលទិន្នន័យ HDR',
      '• វាយ `/help` ក្នុងក្រុម Sales ដើម្បីមើលមគ្គុទេសក៍',
      '• SreySros, Bery, Theary, Seyi, Pheaktra, Borey, Pisey',
      '',
      '🔸 *ព័ត៌មានប្រព័ន្ធ*',
      '',
      '⏰ *របាយការណ៍ស្វ័យប្រវត្តិ៖*',
      '• របាយការណ៍ប្រចាំថ្ងៃ (JPG)៖ ម៉ោង 11:59 យប់ → ក្រុម Audit',
      '• របាយការណ៍ប្រចាំខែ (Excel)៖ ថ្ងៃទី១ ម៉ោង 12:01 ព្រឹក → ក្រុម Audit',
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
