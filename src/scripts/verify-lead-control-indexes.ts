import DatabaseConnection from '../database/connection';
import { IndexInspectionDatabase, REQUIRED_LEAD_CONTROL_INDEXES, verifyLeadControlIndexes } from '../lead-control/index-verification';

async function main(): Promise<void> {
  const connection = DatabaseConnection.getInstance();
  try {
    const db = await connection.connect();
    const result = await verifyLeadControlIndexes(db as unknown as IndexInspectionDatabase);
    if (!result.ok) {
      for (const missing of result.missing) {
        console.error(`Missing Lead Control index: ${missing.collection}.${missing.index}`);
      }
      process.exitCode = 1;
      return;
    }
    const count = Object.values(REQUIRED_LEAD_CONTROL_INDEXES).reduce((sum, indexes) => sum + indexes.length, 0);
    console.log(`Verified ${count} required Lead Control indexes.`);
  } finally {
    await connection.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Lead Control index verification failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
