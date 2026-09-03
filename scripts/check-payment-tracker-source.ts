/**
 * Pre-rollout inspection of the Payment Tracker source credential and schema.
 *
 * Usage: npx ts-node scripts/check-payment-tracker-source.ts
 *
 * This is the deployment gate. It answers two separate questions, and reports
 * them separately because they have different owners:
 *
 *   exit 1 — the credential or schema is wrong. Ours to fix (or to send back to
 *            the Payment Tracker administrator) before anything is enabled.
 *   exit 2 — the credential is right but the DATA is not ready: source records
 *            still have null customer_phone or null credit_applied, so no
 *            reminder can legitimately be drafted from them yet.
 *
 * Read-only throughout. Nothing here writes to ar_state, creates an index, or
 * prints a URI, phone number, customer name, home id, or ar_id.
 */
import dotenv from 'dotenv';
dotenv.config();

import { PaymentSourceConnection } from '../src/payment-tracker/payment-source-connection';
import {
  SOURCE_COLLECTION,
  SOURCE_DB,
  inspectPaymentSource,
} from '../src/payment-tracker/payment-source-inspection';
import { endOfTomorrowCambodia } from '../src/payment-tracker/payment-domain';

/** The compound index the daily candidate query is designed to use. */
const EXPECTED_INDEX_PREFIX = 'current_status_1_due_date_1';

async function main(): Promise<number> {
  if (!process.env.PAYMENT_TRACKER_DATABASE_URL) {
    console.error('PAYMENT_TRACKER_DATABASE_URL is not set.');
    console.error('Provision an Atlas user limited to find + listIndexes on');
    console.error(`${SOURCE_DB}.${SOURCE_COLLECTION}, then set it in .env. See .env.example.`);
    return 1;
  }

  const connection = new PaymentSourceConnection();
  await connection.connect();
  try {
    const report = await inspectPaymentSource(connection.inspectionPort(), endOfTomorrowCambodia(new Date()));

    console.log(`namespace           : ${report.namespace}`);
    console.log(`roles               : ${report.roles.join(', ') || '(none reported)'}`);
    console.log(`indexes             : ${report.indexNames.join(', ') || '(none)'}`);
    console.log(`ar_id unique index  : ${report.arIdUniqueIndex ? 'yes' : 'NO'}`);
    console.log(`winning plan        : ${report.winningPlan}`);
    console.log(`index used          : ${report.indexUsed ?? '(none — collection scan)'}`);
    console.log(`keys / docs examined: ${report.keysExamined ?? '?'} / ${report.docsExamined ?? '?'}`);
    console.log(`due candidates      : ${report.candidateCount}`);
    console.log(`missing phone       : ${report.missingPhoneCount}`);
    console.log(`missing credit      : ${report.missingCreditCount}`);

    const blockers: string[] = [];

    if (!report.privileges.ok) {
      blockers.push(`credential: ${report.privileges.reason}`);
    }
    if (!report.arIdUniqueIndex) {
      blockers.push('ar_id has no unique index — receivable identity is not guaranteed');
    }
    if (!report.indexUsed || !report.indexUsed.startsWith(EXPECTED_INDEX_PREFIX)) {
      blockers.push(
        `candidate query does not use ${EXPECTED_INDEX_PREFIX} (used: ${report.indexUsed ?? 'collection scan'})`
      );
    }

    if (blockers.length > 0) {
      console.error('\nBLOCKED — do not enable Payment Tracker:');
      for (const blocker of blockers) console.error(`  - ${blocker}`);
      console.error('\nIndex and schema problems belong to the Payment Tracker administrator.');
      console.error('audit-sales never repairs the source.');
      return 1;
    }

    if (report.missingPhoneCount > 0 || report.missingCreditCount > 0) {
      console.error('\nDATA NOT READY — credential and schema are correct, but:');
      if (report.missingPhoneCount > 0) {
        console.error(`  - ${report.missingPhoneCount} due receivable(s) have no customer_phone`);
      }
      if (report.missingCreditCount > 0) {
        console.error(`  - ${report.missingCreditCount} due receivable(s) have null credit_applied`);
      }
      console.error('\nThose records are ineligible by design and will never be reminded.');
      console.error('Leave PAYMENT_TRACKER_SCAN_ENABLED=false until the source populates them.');
      return 2;
    }

    console.log('\nOK — credential is collection-scoped, schema and index check out.');
    return 0;
  } finally {
    await connection.disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('inspection failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
