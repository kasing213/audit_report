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
}

export type ParseResult = LeadEvent[] | IgnoredMessage;
