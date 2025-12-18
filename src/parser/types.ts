export interface SalesCase {
  date: string | null;
  number_of_customers: number | null;
  customer_name: string | null;
  phone_number: string | null;
  page: string | null;
  case_followed_by: string | null;
  comment: string | null;
  raw_text: string;
  confidence: number;
}

export interface IgnoredMessage {
  ignored: true;
}

export type ParseResult = SalesCase[] | IgnoredMessage;