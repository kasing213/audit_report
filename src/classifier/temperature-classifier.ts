import { Temperature, TemperatureSource, REASON_CODE_TO_TEMPERATURE } from '../constants/temperature';
import { classifyByRules } from './rules';
import { OpenAIClassifier } from './openai-classifier';

export interface ClassificationResult {
  temperature: Temperature | null;
  source: TemperatureSource | null;
}

export class TemperatureClassifier {
  private openAI: OpenAIClassifier;

  constructor() {
    this.openAI = new OpenAIClassifier();
  }

  public async classify(
    statusText: string | null | undefined,
    reasonCode?: string | null
  ): Promise<ClassificationResult> {
    // Reason code is the most reliable signal — if the sales rep has already assigned
    // one, trust that over any free-text parsing.
    if (reasonCode && REASON_CODE_TO_TEMPERATURE[reasonCode]) {
      return { temperature: REASON_CODE_TO_TEMPERATURE[reasonCode], source: 'rules' };
    }

    if (!statusText || !statusText.trim()) {
      return { temperature: null, source: null };
    }

    const ruleHit = classifyByRules(statusText);
    if (ruleHit) {
      return { temperature: ruleHit, source: 'rules' };
    }

    const llmHit = await this.openAI.classify(statusText);
    if (llmHit) {
      return { temperature: llmHit, source: 'llm' };
    }

    return { temperature: null, source: null };
  }
}
