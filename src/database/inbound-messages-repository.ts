import { Collection, ObjectId } from 'mongodb';
import DatabaseConnection from './connection';
import { Logger } from '../utils/logger';

export interface InboundMessageDocument {
  _id?: ObjectId;
  phone: string;
  telegram_message_id: number;
  text: string;
  received_at: Date;
  customer_id: ObjectId | null;
  customer_name: string | null;
  follower: string | null;
  notified_chat_id: string | null;
  notified_at: Date | null;
  created_at: Date;
}

export interface UpsertResult {
  inserted: boolean;
  doc: InboundMessageDocument;
}

export class InboundMessagesRepository {
  private collection: Collection<InboundMessageDocument>;

  constructor() {
    this.collection = DatabaseConnection.getInstance()
      .getDb()
      .collection<InboundMessageDocument>('inbound_messages');
    this.ensureIndexes().catch(err => {
      Logger.error('inbound_messages index creation warning', err as Error);
    });
  }

  private async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { phone: 1, telegram_message_id: 1 },
      { unique: true, name: 'phone_msgid_unique' }
    );
    await this.collection.createIndex(
      { notified_at: 1 },
      { sparse: true, name: 'notified_at_sparse' }
    );
  }

  async upsertInboundMessage(input: Omit<InboundMessageDocument, '_id' | 'created_at' | 'notified_chat_id' | 'notified_at'>): Promise<UpsertResult> {
    const filter = { phone: input.phone, telegram_message_id: input.telegram_message_id };
    const now = new Date();
    const result = await this.collection.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          phone: input.phone,
          telegram_message_id: input.telegram_message_id,
          text: input.text,
          received_at: input.received_at,
          customer_id: input.customer_id,
          customer_name: input.customer_name,
          follower: input.follower,
          notified_chat_id: null,
          notified_at: null,
          created_at: now,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    if (!result) {
      throw new Error('inbound_messages upsert returned no document');
    }
    const inserted = result.created_at?.getTime() === now.getTime();
    return { inserted, doc: result };
  }

  async markNotified(id: ObjectId, chatId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
      { $set: { notified_chat_id: chatId, notified_at: new Date() } }
    );
  }
}
