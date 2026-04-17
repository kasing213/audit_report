import { Context } from 'telegraf';
import { SalesCaseRepository } from '../../database/repository';
import { TemperatureClassifier } from '../../classifier/temperature-classifier';
import { pushTemperatureEvent } from '../../integrations/meta-capi';
import {
  parseTemperature,
  TEMPERATURE_EMOJIS,
  TEMPERATURE_LABELS
} from '../../constants/temperature';
import { Logger } from '../../utils/logger';

export class ReclassifyCommand {
  private repository: SalesCaseRepository;
  private classifier: TemperatureClassifier;

  constructor(repository: SalesCaseRepository) {
    this.repository = repository;
    this.classifier = new TemperatureClassifier();
  }

  async handleCommand(ctx: Context): Promise<void> {
    const messageText = (ctx.message && 'text' in ctx.message) ? ctx.message.text : '';
    const parts = messageText.trim().split(/\s+/);

    if (parts.length < 2) {
      await ctx.reply(
        'Usage:\n' +
          '• /reclassify <phone> — re-run the classifier\n' +
          '• /reclassify <phone> hot|warm|cold — manual override'
      );
      return;
    }

    const phone = parts[1];
    const overrideArg = parts[2];

    try {
      const event = await this.repository.findLatestEventByPhone(phone);
      if (!event || !event._id) {
        await ctx.reply(`❌ No customer found for phone ${phone}.`);
        return;
      }

      let newTemp: ReturnType<typeof parseTemperature> = null;
      let source: 'rules' | 'llm' | 'manual' = 'manual';

      if (overrideArg) {
        newTemp = parseTemperature(overrideArg);
        if (!newTemp) {
          await ctx.reply('❌ Temperature must be one of: hot, warm, cold.');
          return;
        }
        source = 'manual';
      } else {
        const result = await this.classifier.classify(event.status_text, event.reason_code);
        if (!result.temperature) {
          await ctx.reply('⚠️ Classifier could not determine a temperature for this status.');
          return;
        }
        newTemp = result.temperature;
        source = result.source ?? 'rules';
      }

      await this.repository.updateLeadEvent(event._id, {
        temperature: newTemp,
        temperature_source: source,
        meta_sync_status: event.meta_lead_id ? 'pending' : null
      });

      const emoji = TEMPERATURE_EMOJIS[newTemp];
      const label = TEMPERATURE_LABELS[newTemp];
      await ctx.reply(
        `${emoji} ${phone} → <b>${label}</b> (${source})`,
        { parse_mode: 'HTML' }
      );

      if (event.meta_lead_id) {
        void pushTemperatureEvent(
          { ...event, temperature: newTemp, temperature_source: source },
          this.repository
        );
      }
    } catch (error) {
      Logger.error('Error in /reclassify', error as Error);
      await ctx.reply('❌ Failed to reclassify.');
    }
  }
}
