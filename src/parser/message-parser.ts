import { LeadEvent, ParseResult } from './types';
import { OpenAITranslator } from './openai-translator';
import { getTodayDate } from '../utils/time';

export class MessageParser {
  private translator: OpenAITranslator;

  constructor() {
    this.translator = new OpenAITranslator();
  }

  public async parseMessage(message: string, telegramMsgId: string, model: string): Promise<ParseResult> {
    const trimmedMessage = message.trim();

    if (!trimmedMessage || this.isVagueMessage(trimmedMessage)) {
      return { ignored: true };
    }

    const aiResult = await this.translator.translate(message, telegramMsgId, model);
    if (aiResult) {
      return aiResult;
    }

    const leadEvents = this.extractLeadEvents(trimmedMessage, telegramMsgId, model);

    if (leadEvents.length === 0) {
      return { ignored: true };
    }

    return leadEvents;
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

  private extractLeadEvents(message: string, telegramMsgId: string, model: string): LeadEvent[] {
    const events: LeadEvent[] = [];

    const phoneMatches = message.match(/\b\d{8,}\b/g);
    const nameMatches = message.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g);
    const platformMatch = message.match(/(facebook|tiktok|instagram|whatsapp|page|fb)/i);
    const followerMatch = message.match(/followed by\s+(\w+)|(\w+)\s+following/i);

    const customerName = nameMatches ? nameMatches[0] : null;
    const phoneNumber = phoneMatches ? phoneMatches[0] : null;
    const page = platformMatch ? platformMatch[1] : null;
    const follower = followerMatch ? (followerMatch[1] || followerMatch[2]) : null;

    // Extract status_text (anything that looks like a comment/status)
    const statusMatch = message.match(/(interested|not interested|callback|follow up|appointment|meeting|too far|too expensive|will think|no answer)/i);
    const status_text = statusMatch ? statusMatch[0] : null;

    // Only create event if we have at least customer name or phone
    if (customerName || phoneNumber) {
      events.push({
        date: getTodayDate(),
        customer: {
          name: customerName,
          phone: phoneNumber
        },
        page,
        follower,
        status_text,
        source: {
          telegram_msg_id: telegramMsgId,
          model: model
        }
      });
    }

    return events;
  }
}
