import { ParseResult, SalesCase } from './types';
import { Logger } from '../utils/logger';
import { getTodayDate } from '../utils/time';

interface ChatCompletionChoice {
  message?: {
    content?: string | null;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

export class OpenAITranslator {
  private apiKey: string | null;
  private model: string;
  private readonly defaultModel = 'gpt-4o-mini';
  private requestTimeoutMs: number;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY ?? null;
    const envModel = process.env.OPENAI_MODEL ? process.env.OPENAI_MODEL.trim() : '';
    this.model = envModel || this.defaultModel;
    const parsedTimeout = Number(process.env.OPENAI_TIMEOUT_MS);
    this.requestTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 20000;

    if (!this.apiKey) {
      Logger.warn('OPENAI_API_KEY not set. Falling back to rule-based parsing.');
    }
  }

  private getCurrentDate(): string {
    return getTodayDate();
  }

  private buildSystemPrompt(): string {
    return [
      'You are a TRANSLATOR for audit records.',
      'Convert raw Telegram sales messages into structured JSON for auditing and daily reporting.',
      'You are NOT allowed to invent information, correct mistakes, infer missing data, calculate totals, or merge unrelated cases.',
      'Rules (strict):',
      '1) Output JSON only. No explanations or markdown.',
      '2) Preserve the exact raw message in "raw_text".',
      '3) If data is missing or unclear, use null.',
      '4) If the message does not describe a customer/sales case, return { "ignored": true }.',
      '5) If multiple customers are mentioned, output one JSON object per customer.',
      '6) Include a confidence score between 0.0 and 1.0 based on clarity.',
      '7) Assume today’s date unless another date is explicitly stated.',
      'Input characteristics: Text only, Khmer/English may be mixed, phone numbers are the primary identifier.',
      'Return data exactly as:',
      '[',
      '  {',
      '    "date": "YYYY-MM-DD or null",',
      '    "number_of_customers": number or null,',
      '    "customer_name": "string or null",',
      '    "phone_number": "string or null",',
      '    "page": "string or null",',
      '    "case_followed_by": "string or null",',
      '    "comment": "string or null",',
      '    "raw_text": "original input text",',
      '    "confidence": number',
      '  }',
      ']',
      `Today is ${this.getCurrentDate()}.`
    ].join('\n');
  }

  public async translate(message: string): Promise<ParseResult | null> {
    if (!this.apiKey) {
      return null;
    }

    const result = await this.callModel(message, this.model, true);
    return result;
  }

  private async callModel(message: string, model: string, allowFallback: boolean): Promise<ParseResult | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: this.buildSystemPrompt() },
            { role: 'user', content: message }
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        const isInvalidModel = response.status === 400 && errorText.toLowerCase().includes('invalid model');

        if (isInvalidModel && allowFallback && model !== this.defaultModel) {
          Logger.warn(`OpenAI model "${model}" invalid. Falling back to default "${this.defaultModel}".`);
          return await this.callModel(message, this.defaultModel, false);
        }

        Logger.error(`OpenAI API error (${response.status}): ${errorText}`);
        return null;
      }

      const data = await response.json() as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        Logger.warn('OpenAI translation returned empty content');
        return null;
      }

      return this.parseAiContent(content, message);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        Logger.warn(`OpenAI request timed out after ${this.requestTimeoutMs}ms for model "${model}".`);
        return null;
      }
      Logger.error('Failed to call OpenAI API', error as Error);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseAiContent(content: string, rawText: string): ParseResult | null {
    const cleaned = this.extractJson(content);
    if (!cleaned) {
      Logger.warn('Could not extract JSON from OpenAI response');
      return null;
    }

    try {
      const parsed = JSON.parse(cleaned) as unknown;
      return this.normalizePayload(parsed, rawText);
    } catch (error) {
      Logger.error('Failed to parse JSON from OpenAI response', error as Error);
      return null;
    }
  }

  private extractJson(text: string): string | null {
    const trimmed = text.trim();

    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch && fencedMatch[1]) {
      return fencedMatch[1].trim();
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return trimmed;
    }

    const bracketMatch = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (bracketMatch && bracketMatch[1]) {
      return bracketMatch[1];
    }

    return null;
  }

  private normalizePayload(payload: unknown, rawText: string): ParseResult | null {
    if (this.isIgnored(payload)) {
      return { ignored: true };
    }

    if (!Array.isArray(payload)) {
      return null;
    }

    const normalizedCases = payload
      .map((item) => this.normalizeCase(item, rawText))
      .filter((item): item is SalesCase => item !== null);

    if (normalizedCases.length === 0) {
      return { ignored: true };
    }

    return normalizedCases;
  }

  private isIgnored(payload: unknown): payload is { ignored: true } {
    return Boolean(
      payload &&
      typeof payload === 'object' &&
      (payload as { ignored?: unknown }).ignored === true
    );
  }

  private normalizeCase(item: unknown, rawText: string): SalesCase | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const data = item as Record<string, unknown>;
    const today = this.getCurrentDate();

    return {
      date: typeof data.date === 'string' ? data.date : today,
      number_of_customers: this.toNumber(data.number_of_customers),
      customer_name: typeof data.customer_name === 'string' ? data.customer_name : null,
      phone_number: typeof data.phone_number === 'string' ? data.phone_number : null,
      page: typeof data.page === 'string' ? data.page : null,
      case_followed_by: typeof data.case_followed_by === 'string' ? data.case_followed_by : null,
      comment: typeof data.comment === 'string' ? data.comment : null,
      raw_text: rawText,
      confidence: this.toConfidence(data.confidence)
    };
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private toConfidence(value: unknown): number {
    const numeric = this.toNumber(value);
    if (numeric === null) {
      return 0.5;
    }
    return Math.max(0, Math.min(1, numeric));
  }
}
