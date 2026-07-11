/**
 * One-time backfill: seed the `outreach_suppressions` ledger from existing
 * `status:'failed'` outreach proposals (one doc per phone, latest reason wins).
 * This immediately stops the re-hammering of already-failed numbers.
 *
 * Idempotent — phones already having a suppression doc are skipped, so it is
 * safe to re-run.
 *
 *   npx ts-node scripts/backfill-suppressions.ts
 */
import dotenv from 'dotenv';
import DatabaseConnection from '../src/database/connection';
import { OutreachSuppressionRepository } from '../src/outreach/outreach-suppression-repository';

dotenv.config();

async function main(): Promise<void> {
  const db = DatabaseConnection.getInstance();
  await db.connect();

  const repo = new OutreachSuppressionRepository();
  console.log('Backfilling outreach_suppressions from failed proposals…');
  const result = await repo.backfillFromFailedProposals();
  console.log(
    `Done: scanned ${result.scanned} phone(s), created ${result.created} suppression doc(s), skipped ${result.skipped} (already present).`
  );

  await db.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
