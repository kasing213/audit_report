import { Logger } from '../utils/logger';
import { formatReasonDisplay } from '../constants/reason-codes';
import { CustomerCase } from '../database/models';
import { BrainRepository } from '../brain/brain-repository';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

export interface DraftResult {
  message: string;
  reasoning: string;
  model: string;
}

export interface ReviewResult {
  approve: boolean;
  reason: string;
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 20000;

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured');
  return key;
}

function getModel(): string {
  const envModel = process.env.OPENAI_MODEL?.trim();
  return envModel || DEFAULT_MODEL;
}

function getTimeoutMs(): number {
  const parsed = Number(process.env.OPENAI_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function serializeCustomerForPrompt(customer: CustomerCase): string {
  const reason = customer.current_reason_code
    ? formatReasonDisplay(customer.current_reason_code)
    : null;

  const days = customer.last_update_date
    ? Math.floor((Date.now() - new Date(customer.last_update_date).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return JSON.stringify({
    name: customer.name ?? null,
    phone: customer.phone ?? null,
    page_source: customer.page ?? null,
    follower: customer.follower ?? null,
    days_since_last_contact: days,
    last_update_date: customer.last_update_date ?? null,
    first_contact_date: customer.first_contact_date ?? null,
    reason_code: reason,
    latest_note: customer.latest_note ?? null,
    current_temperature: customer.current_temperature ?? null,
    total_events: customer.total_events ?? 0,
  }, null, 2);
}

async function callOpenAI(systemPrompt: string, userContent: string, model: string): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeoutMs());

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getApiKey()}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.7,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      Logger.error(`OpenAI drafter error (${response.status}): ${errorText}`);
      return null;
    }

    const data = await response.json() as ChatCompletionResponse;
    return data.choices?.[0]?.message?.content ?? null;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      Logger.warn(`OpenAI drafter timed out after ${getTimeoutMs()}ms`);
      return null;
    }
    Logger.error('OpenAI drafter failed', error as Error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

const DRAFTER_SYSTEM_PROMPT = [
  'អ្នកគឺជាបុគ្គលិកផ្នែកលក់អចលនទ្រព្យនៅកម្ពុជា។',
  'សរសេរសារខ្លីមួយ (ក្រោម ២៨០ តួអក្សរ) ជាភាសាខ្មែរ ទៅកាន់ភ្ញៀវដែលបានបំពេញទម្រង់ Meta Lead Ads ប៉ុន្តែឈប់ឆ្លើយតប។',
  'គោលដៅ៖ បើកការសន្ទនាឡើងវិញ ដោយជាមួយនឹងបំណងល្អ ដោយគ្មានការបញ្ចុះបញ្ចូលខ្លាំង។',
  '',
  'ច្បាប់:',
  '1) បង្កើតសារតែមួយគត់ ជាខ្មែរ។',
  '2) សារត្រូវនឹងមនុស្សលក់ពិតប្រាកដ — ទូលំទូលាយ, គួរឱ្យជឿ, មិនមានការចម្លង។',
  '3) គ្មាន emoji។ គ្មានអក្សរធំទាំងអស់។',
  '4) ប្រសិនបើមាន reason_code សូមយកបន្ថែមពីបរិបទនោះ (ឧ. បើគេថាថ្លៃពេក - សូមផ្តល់យោបល់អំពីប្រភេទថ្លៃសមរម្យ)។',
  '5) ប្រើឈ្មោះភ្ញៀវប្រសិនបើមាន។ ចុះហត្ថលេខាដោយឈ្មោះ follower ប្រសិនបើមាន។',
  '6) កុំសន្យា តម្លៃ, ដី, ឬលក្ខខណ្ឌ។',
  '7) កុំប្រើពាក្យអូសទាញ (discount!!, promo, urgent)។',
  '',
  'ត្រឡប់ជា JSON តែមួយ:',
  '{ "message": "<សារភាសាខ្មែរ>", "reasoning": "<ហេតុអ្វីបានជាសារនេះល្អសម្រាប់ភ្ញៀវនេះ (ជាភាសាអង់គ្លេស ១-២ ប្រយោគ)>" }',
].join('\n');

async function loadBrainContext(): Promise<string> {
  try {
    const docs = await new BrainRepository().listActive();
    if (docs.length === 0) return '';
    const blocks = docs.map((d) => [
      `--- Example: ${d.title} ---`,
      d.raw_text,
      '--- End example ---',
    ].join('\n'));
    return [
      '',
      'TONE EXAMPLES (match this voice and register; never quote verbatim):',
      ...blocks,
      '',
    ].join('\n');
  } catch (err) {
    Logger.warn(`loadBrainContext failed: ${(err as Error).message}`);
    return '';
  }
}

export async function draftMessage(customer: CustomerCase): Promise<DraftResult | null> {
  const model = getModel();
  const brainContext = await loadBrainContext();
  const systemPrompt = brainContext
    ? DRAFTER_SYSTEM_PROMPT.replace('ច្បាប់:', `${brainContext}ច្បាប់:`)
    : DRAFTER_SYSTEM_PROMPT;
  const raw = await callOpenAI(systemPrompt, serializeCustomerForPrompt(customer), model);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { message?: unknown; reasoning?: unknown };
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '';
    if (!message) {
      Logger.warn('Drafter returned empty message');
      return null;
    }
    return { message, reasoning, model };
  } catch (error) {
    Logger.error('Failed to parse drafter JSON', error as Error);
    return null;
  }
}

const REVIEWER_SYSTEM_PROMPT = [
  'You review AI-drafted outreach messages written in Khmer for a Cambodian sales team.',
  'Approve only if ALL of these hold:',
  '- The message is in Khmer (not English, not mixed more than a phone number).',
  '- Under 320 characters.',
  '- Reads like a real person wrote it for this specific lead (references their context).',
  '- Does NOT contain: emojis, all-caps, promises about price/land/terms, urgency language ("urgent", "now", "limited"), spam markers, personal data the lead never gave us.',
  '- Does NOT impersonate the customer or reference events that did not happen.',
  '',
  'Return JSON: { "approve": true|false, "reason": "<one sentence>" }.',
  'If you reject, "reason" must explain which rule failed in English so a human can fix it.',
].join('\n');

export async function reviewMessage(draft: string, customer: CustomerCase): Promise<ReviewResult | null> {
  const model = getModel();
  const reviewerInput = JSON.stringify({
    draft_message: draft,
    customer_context: JSON.parse(serializeCustomerForPrompt(customer)),
  }, null, 2);

  const raw = await callOpenAI(REVIEWER_SYSTEM_PROMPT, reviewerInput, model);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { approve?: unknown; reason?: unknown };
    const approve = parsed.approve === true;
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    return { approve, reason: reason || (approve ? 'approved' : 'rejected') };
  } catch (error) {
    Logger.error('Failed to parse reviewer JSON', error as Error);
    return null;
  }
}
