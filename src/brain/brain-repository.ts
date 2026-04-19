import { Collection, ObjectId } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';

export interface BrainDocument {
  _id?: ObjectId;
  title: string;
  filename: string;
  uploaded_at: Date;
  uploaded_by: string;
  active: boolean;
  raw_text: string;
  char_count: number;
  notes: string | null;
}

const COLLECTION = 'brain_documents';

let indexesReady = false;

export class BrainRepository {
  private col: Collection<BrainDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<BrainDocument>(COLLECTION);
    if (!indexesReady) {
      indexesReady = true;
      this.col
        .createIndexes([
          { key: { active: 1 }, name: 'active_idx' },
          { key: { uploaded_at: -1 }, name: 'uploaded_at_desc' },
        ])
        .catch((err) => Logger.error('brain_documents index creation failed', err as Error));
    }
  }

  async insert(doc: BrainDocument): Promise<string> {
    const result = await this.col.insertOne(doc);
    return result.insertedId.toString();
  }

  async listAll(): Promise<BrainDocument[]> {
    return this.col.find({}).sort({ uploaded_at: -1 }).toArray();
  }

  async listActive(): Promise<BrainDocument[]> {
    return this.col.find({ active: true }).sort({ uploaded_at: -1 }).toArray();
  }

  async getById(id: string): Promise<BrainDocument | null> {
    try {
      return await this.col.findOne({ _id: new ObjectId(id) });
    } catch {
      return null;
    }
  }

  async update(
    id: string,
    updates: Partial<Pick<BrainDocument, 'active' | 'title' | 'notes'>>
  ): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id) },
        { $set: updates }
      );
      return result.matchedCount > 0;
    } catch {
      return false;
    }
  }

  async remove(id: string): Promise<boolean> {
    try {
      const result = await this.col.deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    } catch {
      return false;
    }
  }

  async totalActiveChars(): Promise<number> {
    const docs = await this.listActive();
    return docs.reduce((sum, d) => sum + (d.char_count || 0), 0);
  }
}
