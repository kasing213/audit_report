export interface IgnoredMessage {
  ignored: true;
}

export interface LeadEvent {
  date: string;  // YYYY-MM-DD
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
  is_update?: boolean;  // Optional, indicates if this is an update to existing customer
}

export type ParseResult = LeadEvent[] | IgnoredMessage;
