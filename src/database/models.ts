import { SalesCase } from '../parser/types';

export interface SalesCaseDocument extends SalesCase {
  _id?: string;
  created_at: Date;
  telegram_message_id?: number;
  telegram_user_id?: number;
  telegram_username?: string | undefined;
}

export interface AuditLog {
  _id?: string;
  timestamp: Date;
  action: string;
  message_id: number;
  user_id: number;
  username?: string | undefined;
  original_message: string;
  parsed_result: any;
  error?: string;
}