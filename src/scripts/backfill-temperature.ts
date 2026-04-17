/**
 * Backfill temperature on existing leads_events documents.
 *
 * Usage:
 *   ts-node src/scripts/backfill-temperature.ts [--dry-run] [--since=YYYY-MM-DD] [--push-meta]
 *
 * Flags:
 *   --dry-run    Log intended updates; do not write.
 *   --since=     Only process events dated on/after this date (default: full history).
 *   --push-meta  After classifying, also push each synced event with a meta_lead_id
 *                to CAPI. Omit on first run to avoid blasting Meta.
 */

import dotenv from 'dotenv';
import DatabaseConnection from '../database/connection';
import { SalesCaseRepository } from '../database/repository';
import { TemperatureClassifier } from '../classifier/temperature-classifier';
import { pushTemperatureEvent } from '../integrations/meta-capi';
import { Logger } from '../utils/logger';

dotenv.config();

interface Args {
  dryRun: boolean;
  since: string;
  pushMeta: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let dryRun = false;
  let since = '1970-01-01';
  let pushMeta = false;

  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--push-meta') pushMeta = true;
    else if (arg.startsWith('--since=')) since = arg.slice('--since='.length);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error(`--since must be YYYY-MM-DD, got "${since}"`);
  }

  return { dryRun, since, pushMeta };
}

async function main(): Promise<void> {
  const { dryRun, since, pushMeta } = parseArgs();

  Logger.info(`Backfill start: dryRun=${dryRun}, since=${since}, pushMeta=${pushMeta}`);

  const db = DatabaseConnection.getInstance();
  await db.connect();

  try {
    const repository = new SalesCaseRepository();
    const classifier = new TemperatureClassifier();

    const today = new Date().toISOString().slice(0, 10);
    const events = await repository.getEventsByDateRange(since, today);
    Logger.info(`Loaded ${events.length} events for backfill consideration`);

    let classified = 0;
    let skipped = 0;
    let errors = 0;
    let metaPushed = 0;

    for (const event of events) {
      if (event.temperature) {
        skipped++;
        continue;
      }

      try {
        const { temperature, source } = await classifier.classify(
          event.status_text,
          event.reason_code
        );

        if (!temperature) {
          skipped++;
          continue;
        }

        if (dryRun) {
          Logger.info(
            `[dry-run] ${event._id} phone=${event.customer?.phone ?? '—'} → ${temperature} (${source})`
          );
        } else if (event._id) {
          await repository.updateLeadEvent(event._id, {
            temperature,
            temperature_source: source
          });

          if (pushMeta && event.meta_lead_id) {
            await pushTemperatureEvent(
              { ...event, temperature, temperature_source: source },
              repository
            );
            metaPushed++;
          }
        }
        classified++;
      } catch (error) {
        errors++;
        Logger.error(`Backfill error on event ${event._id}`, error as Error);
      }

      if (classified > 0 && classified % 50 === 0) {
        Logger.info(`Progress: classified=${classified}, skipped=${skipped}, errors=${errors}`);
      }
    }

    Logger.info(
      `Backfill done. classified=${classified}, skipped=${skipped}, errors=${errors}, metaPushed=${metaPushed}`
    );
  } finally {
    await db.disconnect();
  }
}

main().catch((error) => {
  Logger.error('Backfill failed', error as Error);
  process.exit(1);
});
