import { SalesCase, ParseResult } from './types';
import { OpenAITranslator } from './openai-translator';
import { getTodayDate } from '../utils/time';

export class MessageParser {
  private translator: OpenAITranslator;

  constructor() {
    this.translator = new OpenAITranslator();
  }

  public async parseMessage(message: string): Promise<ParseResult> {
    const trimmedMessage = message.trim();

    if (!trimmedMessage || this.isVagueMessage(trimmedMessage)) {
      return { ignored: true };
    }

    const aiResult = await this.translator.translate(message);
    if (aiResult) {
      return this.applyRawText(aiResult, message);
    }

    const salesCases = this.extractSalesCases(trimmedMessage, message);

    if (salesCases.length === 0) {
      return { ignored: true };
    }

    return salesCases;
  }

  private isVagueMessage(message: string): boolean {
    const vaguePhrases = [
      'busy day',
      'lots of chats',
      'many customers',
      'good day',
      'slow day',
      'no customers',
      'quiet today'
    ];

    const lowerMessage = message.toLowerCase();
    return vaguePhrases.some(phrase => lowerMessage.includes(phrase)) &&
           !this.hasSpecificData(message);
  }

  private hasSpecificData(message: string): boolean {
    const phonePattern = /\d{8,}/;
    const namePattern = /[A-Z][a-z]+/;
    const platformPattern = /(facebook|tiktok|instagram|whatsapp|page)/i;

    return phonePattern.test(message) ||
           namePattern.test(message) ||
           platformPattern.test(message);
  }

  private applyRawText(result: ParseResult, rawText: string): ParseResult {
    if ('ignored' in result) {
      return result;
    }

    return result.map((salesCase) => ({
      ...salesCase,
      raw_text: rawText
    }));
  }

  private extractSalesCases(message: string, rawText: string): SalesCase[] {
    const cases: SalesCase[] = [];
    let confidence = 0.5;

    const customerCountMatch = message.match(/(\d+)\s*customers?/i);
    const number_of_customers = customerCountMatch ? parseInt(customerCountMatch[1]) : null;

    if (number_of_customers) confidence += 0.2;

    const phoneMatches = message.match(/\b\d{8,}\b/g);
    const nameMatches = message.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g);
    const platformMatch = message.match(/(facebook|tiktok|instagram|whatsapp|page|fb)/i);
    const followedByMatch = message.match(/followed by\s+(\w+)/i);

    const customerName = nameMatches ? nameMatches[0] : null;
    const phoneNumber = phoneMatches ? phoneMatches[0] : null;
    const page = platformMatch ? platformMatch[1] : null;
    const caseFollowedBy = followedByMatch ? followedByMatch[1] : null;

    if (customerName) confidence += 0.2;
    if (phoneNumber) confidence += 0.2;
    if (page) confidence += 0.1;
    if (caseFollowedBy) confidence += 0.1;

    const commentMatch = message.match(/(interested|enquiry|follow up|callback|appointment|meeting)/i);
    const comment = commentMatch ? commentMatch[0] : null;
    if (comment) confidence += 0.1;

    confidence = Math.min(confidence, 1.0);

    if (customerName || phoneNumber || number_of_customers) {
      cases.push({
        date: getTodayDate(),
        number_of_customers,
        customer_name: customerName,
        phone_number: phoneNumber,
        page,
        case_followed_by: caseFollowedBy,
        comment,
        raw_text: rawText,
        confidence
      });
    }

    return cases;
  }
}
