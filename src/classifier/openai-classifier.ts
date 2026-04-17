import { Logger } from '../utils/logger';
import { Temperature, isTemperature } from '../constants/temperature';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

export class OpenAIClassifier {
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
  }

  public async classify(statusText: string): Promise<Temperature | null> {
    if (!this.apiKey || !statusText) return null;

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
          model: this.model,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content: [
                'Classify a sales lead status into one of: hot, warm, cold.',
                'hot = customer shows strong buy intent (deposit, site visit, signed, ready to buy).',
                'warm = customer is still considering, asking questions, or promising to come back.',
                'cold = customer declined, not interested, no reply, or cannot afford.',
                'Return JSON only: {"temperature":"hot|warm|cold"}. No prose.'
              ].join('\n')
            },
            { role: 'user', content: statusText }
          ]
        })
      });

      if (!response.ok) {
        Logger.warn(`OpenAI classifier non-2xx: ${response.status}`);
        return null;
      }

      const data = await response.json() as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      const match = content.match(/"temperature"\s*:\s*"(hot|warm|cold)"/i);
      const value = match?.[1]?.toLowerCase();
      return value && isTemperature(value) ? value : null;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        Logger.warn(`OpenAI classifier timed out after ${this.requestTimeoutMs}ms`);
      } else {
        Logger.warn(`OpenAI classifier failed: ${(error as Error).message}`);
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
