import { Logger } from '../utils/logger';

export interface HeaderFormData {
  date: string;
  name: string;
  phone: string;
  page: string;
  follower: string;
}

export interface HeaderFormResult {
  valid: boolean;
  data?: HeaderFormData;
  error?: string;
  model?: string;
}

interface HeaderFormAiResponse {
  valid?: boolean;
  data?: Partial<HeaderFormData>;
  error?: string;
}

interface ChatCompletionChoice {
  message?: {
    content?: string | null;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

export class HeaderFormParser {
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
      Logger.warn('OPENAI_API_KEY not set. Falling back to local header parsing.');
    }
  }

  public async parse(message: string): Promise<HeaderFormResult> {
    const trimmed = message.trim();
    if (!this.looksLikeHeader(trimmed)) {
      return { valid: false, error: 'Missing HDR header line.' };
    }

    if (!this.apiKey) {
      return this.parseLocally(trimmed);
    }

    const aiResult = await this.callModel(trimmed, this.model, true);
    if (aiResult?.valid && aiResult.data) {
      const validated = this.validateHeaderData(aiResult.data);
      if (validated.valid) {
        return {
          valid: true,
          data: validated.data,
          model: aiResult.model
        };
      }
    }

    const fallback = this.parseLocally(trimmed);
    if (fallback.valid) {
      return fallback;
    }

    return { valid: false, error: aiResult?.error || fallback.error || 'Invalid header format.' };
  }

  private looksLikeHeader(message: string): boolean {
    const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.length > 0 && lines[0] === 'HDR';
  }

  private parseLocally(message: string): HeaderFormResult {
    const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || lines[0] !== 'HDR') {
      return { valid: false, error: 'Header must start with HDR.' };
    }

    const allowedKeys = new Set(['DATE', 'NAME', 'PHONE', 'PAGE', 'FOLLOWER']);
    const data: Partial<HeaderFormData> = {};

    for (const line of lines.slice(1)) {
      const match = line.match(/^([A-Z]+)\s*:\s*(.+)$/);
      if (!match) {
        return { valid: false, error: 'Invalid header line format.' };
      }

      const key = match[1];
      const value = match[2].trim();

      if (!allowedKeys.has(key)) {
        return { valid: false, error: `Unknown header field: ${key}` };
      }

      if (!value) {
        return { valid: false, error: `Missing value for ${key}.` };
      }

      if (data[key.toLowerCase() as keyof HeaderFormData]) {
        return { valid: false, error: `Duplicate field: ${key}` };
      }

      (data as Record<string, string>)[key.toLowerCase()] = value;
    }

    return this.validateHeaderData(data);
  }

  private validateHeaderData(data: Partial<HeaderFormData>): HeaderFormResult {
    const requiredKeys: Array<keyof HeaderFormData> = ['date', 'name', 'phone', 'page', 'follower'];
    for (const key of requiredKeys) {
      const value = data[key];
      if (!value || value.trim() === '') {
        return { valid: false, error: `Missing ${key.toUpperCase()} field.` };
      }
    }

    const dateValue = data.date ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      return { valid: false, error: 'DATE must be YYYY-MM-DD.' };
    }

    return {
      valid: true,
      data: {
        date: data.date!.trim(),
        name: data.name!.trim(),
        phone: data.phone!.trim(),
        page: data.page!.trim(),
        follower: data.follower!.trim()
      }
    };
  }

  private buildSystemPrompt(): string {
    return [
      'You are a strict validator and extractor for a sales header form.',
      'The input must follow this exact format:',
      'HDR',
      'DATE: YYYY-MM-DD',
      'NAME: <customer name>',
      'PHONE: <phone or contact>',
      'PAGE: <source page>',
      'FOLLOWER: <staff name>',
      '',
      'Rules:',
      '- All fields are required.',
      '- The first line must be exactly "HDR".',
      '- Lines must use the label followed by a colon.',
      '- Do not infer or correct any data.',
      '- Preserve values exactly as written.',
      '- If any line is missing, extra, or malformed, return valid=false.',
      '',
      'Return JSON only. No markdown.',
      'If valid, return:',
      '{ "valid": true, "data": { "date": "...", "name": "...", "phone": "...", "page": "...", "follower": "..." } }',
      'If invalid, return:',
      '{ "valid": false, "error": "short reason" }'
    ].join('\n');
  }

  private async callModel(message: string, aiModel: string, allowFallback: boolean): Promise<HeaderFormResult | null> {
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
          return await this.callModel(message, this.defaultModel, false);
        }

        Logger.error(`OpenAI API error (${response.status}): ${errorText}`);
        return null;
      }

      const data = await response.json() as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        Logger.warn('OpenAI header validation returned empty content');
        return null;
      }

      return this.parseAiContent(content, aiModel);
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

  private parseAiContent(content: string, model: string): HeaderFormResult | null {
    const cleaned = this.extractJson(content);
    if (!cleaned) {
      Logger.warn('Could not extract JSON from OpenAI header response');
      return null;
    }

    try {
      const parsed = JSON.parse(cleaned) as HeaderFormAiResponse;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      if (parsed.valid === true && parsed.data) {
        return {
          valid: true,
          data: parsed.data as HeaderFormData,
          model
        };
      }

      if (parsed.valid === false) {
        return {
          valid: false,
          error: parsed.error || 'Invalid header format.',
          model
        };
      }

      return null;
    } catch (error) {
      Logger.error('Failed to parse JSON from OpenAI header response', error as Error);
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
}
