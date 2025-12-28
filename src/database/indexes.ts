import { Collection, Document } from 'mongodb';
import { Logger } from '../utils/logger';

export async function ensureIndexes<T extends Document>(collection: Collection<T>): Promise<void> {
  try {
    // Index for phone lookup (update detection)
    await collection.createIndex(
      { 'customer.phone': 1 },
      {
        name: 'phone_lookup_idx',
        sparse: true  // Only index documents with phone
      }
    );

    // Compound index for phone + date (optimizes findLatestEventByPhone)
    await collection.createIndex(
      { 'customer.phone': 1, date: -1, created_at: -1 },
      {
        name: 'phone_date_idx',
        sparse: true
      }
    );

    Logger.info('Database indexes created successfully');
  } catch (error) {
    Logger.error('Failed to create indexes', error as Error);
    // Don't throw - system can work without indexes (just slower)
  }
}
