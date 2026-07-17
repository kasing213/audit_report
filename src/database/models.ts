export interface LeadEventDocument {
  _id?: string;
  // Outreach workspace this record belongs to ('company' | 'personal'). Absent
  // on all pre-multi-org data and every sales-group ingestion record, which are
  // treated as 'company' by orgMatch(). See src/outreach/orgs.ts.
  org_id?: string | null;
  date: string;
  customer: {
    name: string | null;
    phone: string | null;
  };
  page: string | null;
  destination?: string | null;
  follower: string | null;
  status_text: string | null;
  reason_code?: string | null;
  note?: string | null;
  promise_date?: string | null;
  promise_status?: 'pending' | 'came' | 'didnt_come' | null;
  group_id?: string | null;
  temperature?: 'hot' | 'warm' | 'cold' | null;
  temperature_source?: 'rules' | 'llm' | 'manual' | null;
  meta_lead_id?: string | null;
  meta_sync_status?: 'pending' | 'synced' | 'failed' | null;
  deleted?: boolean;
  deleted_at?: Date | null;
  deleted_by?: string | null;
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

export interface ChangeLogDocument {
  _id?: string;
  timestamp: Date;
  action: 'create' | 'update' | 'delete';
  event_id: string;
  event_summary: {
    customer_name: string | null;
    customer_phone: string | null;
    date: string;
    follower: string | null;
  };
  changes?: Array<{
    field: string;
    old_value: any;
    new_value: any;
  }>;
  snapshot?: LeadEventDocument;
  actor: string;
}

export interface DailySummaryDocument {
  _id?: string;
  date: string;
  follower: string | null;
  page: string | null;
  counters: Record<string, number>;
  raw_text: string;
  source: {
    model: string;
  };
  created_at: Date;
}

export interface CustomerCase {
  phone: string | null;
  name: string | null;
  page: string | null;
  destination?: string | null;
  follower: string | null;
  first_contact_date: string;      // YYYY-MM-DD
  last_update_date: string;         // YYYY-MM-DD
  current_status: string | null;
  current_reason_code?: string | null;
  current_temperature?: 'hot' | 'warm' | 'cold' | null;
  latest_note?: string | null;
  history: Array<{
    date: string;
    status: string | null;
    reason_code?: string | null;
    note?: string | null;
    created_at: Date;
  }>;
  total_events: number;
}
