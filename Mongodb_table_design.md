🔒 SYSTEM PROMPT FOR CLAUDE (FINAL)

You are building a Telegram-based CRM query system for a real-estate business.

The system ingests Telegram messages, parses them into structured MongoDB documents, and allows on-demand customer list queries via Telegram commands.

This is NOT a sales analytics system.
This is an operational CRM tool for sales follow-ups.

All data is event-based, append-only, and reports are derived dynamically.

🧠 CORE DATA MODEL (DO NOT CHANGE)

MongoDB collection: leads_events
One document = one customer interaction

{
  _id: ObjectId,

  date: "YYYY-MM-DD",

  customer: {
    name: String | null,
    phone: String | null
  },

  page: String | null,        // boosted FB page source
  follower: String | null,    // sales / agent handling case

  status_text: String | null, // free-text outcome or reason

  source: {
    telegram_msg_id: String,
    model: String
  },

  created_at: ISODate
}

Rules:

Append only

No updates except metadata

No derived fields

No additional collections

🧾 JSON EXTRACTION CONTRACT (STRICT)

When parsing Telegram messages, output ONLY this JSON shape:

{
  "date": "YYYY-MM-DD",

  "customer": {
    "name": "string | null",
    "phone": "string | null"
  },

  "page": "string | null",
  "follower": "string | null",

  "status_text": "string | null",

  "source": {
    "telegram_msg_id": "string",
    "model": "gpt-4o-mini"
  }
}

Extraction rules:

Do NOT infer

Do NOT classify

Do NOT normalize text

If unclear → null

Ignore greetings, emojis, chatter

📲 TELEGRAM COMMAND: /customers
Purpose

Return a monthly customer list filtered by follower (sales name).

This command is used by sales staff to see who they need to follow up with.

🧭 COMMAND FLOW (MANDATORY)

User sends:

/customers


Bot replies:

Which follower? (example: Srey Sros)


User replies:

Srey Sros


Bot replies:

Which month? (YYYY-MM or type "current")


User replies:

2025-01

🔍 QUERY REQUIREMENTS (CRITICAL)

Claude must generate logic that:

Filters leads_events by:

follower == input

date within selected month

Deduplicates customers by:

customer.phone

If a customer appears multiple times:

Keep the latest date

Keep the latest status_text

Sort customers by date (latest first)

Do NOT store the result

📤 CANONICAL QUERY RESULT (JSON)
{
  "follower": "Srey Sros",
  "month": "2025-01",
  "total_customers": 12,
  "customers": [
    {
      "name": "Heng Chita",
      "phone": "093724678",
      "page": "Sun TV Real Estate",
      "date": "2025-01-14",
      "status_text": "House too far from city"
    }
  ]
}

📟 TELEGRAM OUTPUT FORMAT (STRICT)

Telegram message must look like this:

📋 Customer List
👤 Follower: Srey Sros
📅 Month: January 2025
👥 Total Customers: 12

1) Heng Chita
📞 093 724 678
📄 Page: Sun TV Real Estate
📅 Date: 2025-01-14
📝 Status: House too far from city

🚫 ABSOLUTE RESTRICTIONS

Claude must NOT:

Redesign schema

Add enums or categories

Store reports

Summarize data

Group by status

Create new collections

Change field names

🧠 DESIGN PHILOSOPHY (DO NOT VIOLATE)

MongoDB stores events only

Telegram displays queries

Status is free text

Monthly lists are operational, not analytical

All aggregation is on demand

✅ FINAL CHECK

This system must support:

/customers

Monthly follower-filtered customer lists

Full customer details

CRM follow-up workflow