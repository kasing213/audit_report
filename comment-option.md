Step 1: Sales submits the header (identity + context)

This matches your top logic and your boss’s mental model.

Required:

Date (auto or entered)

Customer name

Phone number

Page / source (Sun TV, FB, TikTok, IG, etc.)

At this point, the system knows who and where.

Step 2: Bot immediately forces classification (this is critical)

The bot must respond with the fixed options.

Not a question like “What happened?”
A command like “Select ONE”.

Example bot response:

Select customer response (choose 1):

A️⃣ ថ្លៃពេក
B️⃣ ទីតាំងមិនត្រូវ
C️⃣ មិនមែនអ្នកសម្រេច
D️⃣ គ្មានចំណាប់អារម្មណ៍
E️⃣ ត្រូវការកម្ចីច្រើន
F️⃣ ជំពាក់គេច្រើន
G️⃣ ខូច CBC
H️⃣ ដី/ផ្ទះតូចពេក
I️⃣ ចាំថ្ងៃទំនេរមកមើល
J️⃣ ផ្សេងៗ


They tap one.
No typing. No thinking.

Step 3 (optional but good): one short note

Only after selection:

Optional note (max 1 sentence, skip if none):


This is for humans, not reports.

Why this is the exact right breakpoint

You’ve separated:

Identification (who / where / when)

Classification (why / status)

Narrative (extra context)

This mirrors how:

audits work

CRM systems work

real enterprises work

Your boss’s old report mixed all three.
You’re unmixing them without changing outcomes.

How this protects you long-term

Because now:

• Every record has one and only one reason
• Reports auto-generate
• Tel1–Tel10 mapping becomes mechanical
• No “interpretation fights” later
• No rewriting comments

If something is unclear → sales can choose J (Other) and add a note.
That’s the safety valve.

Important rule (do not break this)

Never let sales skip the reason selection.
Never let them select two.

If they resist:

“Boss wants statistics, this helps the report.”

That line always works.

Final confirmation (mentor level)

What you just described is exactly how to design the input boundary.

Once data crosses that boundary, it’s clean forever.

You’ve already won the hard part — deciding where structure starts.

From here on, everything else is plumbing.

how would i prompt it and can you collect the a b c d etc remember its in khmer so i can let claude implement

Perfect — this is the right moment to lock the prompt contract so Claude behaves predictably and never “gets creative”.

I’ll give you three things:

the canonical reason list (A–J) in Khmer (cleaned + normalized)

the system prompt (what Claude must always follow)

the interaction prompt your bot sends after the header is filled

You can hand this straight to Claude to implement. No guessing.

1️⃣ Canonical reason codes (LOCK THESE)

These must never change order or wording. Treat them like enums.

A = ថ្លៃពេក
B = ទីតាំងមិនត្រូវ
C = មិនមែនអ្នកសម្រេច
D = គ្មានចំណាប់អារម្មណ៍
E = ត្រូវការកម្ចីច្រើន
F = ជំពាក់គេច្រើន
G = ខូច CBC
H = ដីឬផ្ទះតូចពេក
I = ចាំរកថ្ងៃទំនេរមកមើល
J = ផ្សេងៗ


Internally store only the letter (A–J).
Text is for display only.

2️⃣ Claude SYSTEM PROMPT (this is critical)

Use this once when initializing Claude for the bot.

You are a structured data collection assistant for a sales audit system.

Rules you MUST follow:
- Never accept free-text opinions as the primary answer.
- Always require the user to select EXACTLY ONE reason code from A–J.
- The reason codes and meanings are fixed and must never be reworded.
- If the user provides explanation text, it must be stored only as an optional note.
- If the user response is unclear or does not match A–J, ask them to choose again.
- Never infer or guess the reason.
- Output reason_code as a single uppercase letter (A–J).
- Khmer language must be preserved exactly as provided.

Your job is classification, not conversation.


This stops Claude from being “helpful” in the wrong way.

3️⃣ Bot interaction prompt (what users actually see)

This is what your bot sends after date / name / phone / page are collected.

Prompt message to user
សូមជ្រើសរើសហេតុផលឆ្លើយតបរបស់ភ្ញៀវ (ជ្រើសរើសតែមួយ):

A️⃣ ថ្លៃពេក  
B️⃣ ទីតាំងមិនត្រូវ  
C️⃣ មិនមែនអ្នកសម្រេច  
D️⃣ គ្មានចំណាប់អារម្មណ៍  
E️⃣ ត្រូវការកម្ចីច្រើន  
F️⃣ ជំពាក់គេច្រើន  
G️⃣ ខូច CBC  
H️⃣ ដីឬផ្ទះតូចពេក  
I️⃣ ចាំរកថ្ងៃទំនេរមកមើល  
J️⃣ ផ្សេងៗ  

សូមបញ្ចូលតែអក្សរ A–J

Validation rule (IMPORTANT)

If user replies:

A → accept

B → accept

price too high → ❌ reject, ask again

A and B → ❌ reject

empty → ❌ reject

Claude should respond with:

សូមជ្រើសរើសតែមួយ (A–J) ប៉ុណ្ណោះ

4️⃣ Optional note prompt (after selection)

Only show this after valid code is selected.

បើមានចំណាំបន្ថែម សូមសរសេរជាប្រយោគខ្លីមួយ (អាចរំលងបាន):


Store this as:

note: "..."


Never mix it with reason_code.

5️⃣ What you store (this is the payload)

Example final record:

{
  "date": "2025-12-29",
  "customer_name": "Heng Chita",
  "phone": "093724678",
  "page": "Sun TV Real Estate",
  "reason_code": "B",
  "note": "ចូលចិត្តផ្ទះ ប៉ុន្តែឆ្ងាយពីសាលា"
}


From this, you can generate:

boss’s ugly report

monthly summaries

rejection statistics

audit trails