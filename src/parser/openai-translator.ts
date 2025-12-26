import { ParseResult, LeadEvent } from './types';
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
      'You are a TRANSLATOR for CRM event records.',
      'Convert raw Telegram sales messages into structured JSON for a real-estate CRM system.',
      'You are NOT allowed to invent information, correct mistakes, infer missing data, or merge unrelated cases.',
      '',
      'CRITICAL RULES (strict):',
      '1) Output JSON only. No explanations or markdown.',
      '2) Do NOT infer or classify anything not explicitly stated.',
      '3) Do NOT normalize text (preserve as-is).',
      '4) If data is missing or unclear, use null.',
      '5) If the message does not describe a customer interaction, return { "ignored": true }.',
      '6) If multiple customers are mentioned, output one JSON object per customer.',
      '7) Ignore greetings, emojis, and chatter.',
      '8) Assume today\'s date unless another date is explicitly stated.',
      '',
      'Return data exactly as:',
      '[',
      '  {',
      '    "date": "YYYY-MM-DD",',
      '    "customer": {',
      '      "name": "string or null",',
      '      "phone": "string or null"',
      '    },',
      '    "page": "string or null",',
      '    "follower": "string or null",',
      '    "status_text": "string or null"',
      '  }',
      ']',
      '',
      `Today is ${this.getCurrentDate()}.`,
      'The telegram_msg_id and model will be added by the system.'
    ].join('\n');
  }

  public async translate(message: string, telegramMsgId: string, model: string): Promise<ParseResult | null> {
    if (!this.apiKey) {
      return null;
    }

    const result = await this.callModel(message, this.model, true, telegramMsgId, model);
    return result;
  }

  private async callModel(message: string, aiModel: string, allowFallback: boolean, telegramMsgId: string, sourceModel: string): Promise<ParseResult | null> {
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
          model: aiModel,
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

        if (isInvalidModel && allowFallback && aiModel !== this.defaultModel) {
          Logger.warn(`OpenAI model "${aiModel}" invalid. Falling back to default "${this.defaultModel}".`);
          return await this.callModel(message, this.defaultModel, false, telegramMsgId, sourceModel);
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

      return this.parseAiContent(content, telegramMsgId, sourceModel);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        Logger.warn(`OpenAI request timed out after ${this.requestTimeoutMs}ms for model "${aiModel}".`);
        return null;
      }
      Logger.error('Failed to call OpenAI API', error as Error);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseAiContent(content: string, telegramMsgId: string, model: string): ParseResult | null {
    const cleaned = this.extractJson(content);
    if (!cleaned) {
      Logger.warn('Could not extract JSON from OpenAI response');
      return null;
    }

    try {
      const parsed = JSON.parse(cleaned) as unknown;
      return this.normalizePayload(parsed, telegramMsgId, model);
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

  private normalizePayload(payload: unknown, telegramMsgId: string, model: string): ParseResult | null {
    if (this.isIgnored(payload)) {
      return { ignored: true };
    }

    if (!Array.isArray(payload)) {
      return null;
    }

    const normalizedEvents = payload
      .map((item) => this.normalizeLeadEvent(item, telegramMsgId, model))
      .filter((item): item is LeadEvent => item !== null);

    if (normalizedEvents.length === 0) {
      return { ignored: true };
    }

    return normalizedEvents;
  }

  private isIgnored(payload: unknown): payload is { ignored: true } {
    return Boolean(
      payload &&
      typeof payload === 'object' &&
      (payload as { ignored?: unknown }).ignored === true
    );
  }

  private normalizeLeadEvent(item: unknown, telegramMsgId: string, model: string): LeadEvent | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const data = item as Record<string, unknown>;
    const today = this.getCurrentDate();

    // Validate customer object
    const customer = data.customer as Record<string, unknown> | undefined;
    if (!customer || typeof customer !== 'object') {
      // If customer is missing, try to construct from flat fields (for robustness)
      return {
        date: typeof data.date === 'string' ? data.date : today,
        customer: {
          name: null,
          phone: null
        },
        page: typeof data.page === 'string' ? data.page : null,
        follower: typeof data.follower === 'string' ? data.follower : null,
        status_text: typeof data.status_text === 'string' ? data.status_text : null,
        source: {
          telegram_msg_id: telegramMsgId,
          model: model
        }
      };
    }

    return {
      date: typeof data.date === 'string' ? data.date : today,
      customer: {
        name: typeof customer.name === 'string' ? customer.name : null,
        phone: typeof customer.phone === 'string' ? customer.phone : null
      },
      page: typeof data.page === 'string' ? data.page : null,
      follower: typeof data.follower === 'string' ? data.follower : null,
      status_text: typeof data.status_text === 'string' ? data.status_text : null,
      source: {
        telegram_msg_id: telegramMsgId,
        model: model
      }
    };
  }
}
