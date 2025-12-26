export interface LeadEventDocument {
  _id?: string;
  date: string;
  customer: {
    name: string | null;
    phone: string | null;
  };
  page: string | null;
  follower: string | null;
  status_text: string | null;
  source: {
    telegram_msg_id: string;
    model: string;
  };
  created_at: Date;
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
