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
  reason_code?: string | null;
  note?: string | null;
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

export interface CustomerCase {
  phone: string | null;
  name: string | null;
  page: string | null;
  follower: string | null;
  first_contact_date: string;      // YYYY-MM-DD
  last_update_date: string;         // YYYY-MM-DD
  current_status: string | null;
  current_reason_code?: string | null;
  history: Array<{
    date: string;
    status: string | null;
    reason_code?: string | null;
    note?: string | null;
    created_at: Date;
  }>;
  total_events: number;
}
