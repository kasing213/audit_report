// Default outreach message used while AI generation is disabled.
// Sent verbatim as the image caption to every selected lead.
// Resolution order: DB value (edited from the CRM) → OUTREACH_STATIC_MESSAGE
// env override → the committed DEFAULT_STATIC_MESSAGE below. The committed
// default means no config is required to ship.
import { OutreachSettingsRepository } from './outreach-settings-repository';
import { OrgId, DEFAULT_ORG } from './orgs';
import { Logger } from '../utils/logger';

export const DEFAULT_STATIC_MESSAGE = [
  'ជម្រាបសួរបង 🙏',
  'ប្អូនឈ្មោះ ធឿន ធារី ជាបុគ្គលិកផ្នែកលក់ប្រចាំគម្រោងដែលមានទីតាំងស្ថិតនៅ ផ្លូវជាតិលេខ៣ ម្តុំវត្តស្លែង ខណ្ឌដង្កោ រាជធានីភ្នំពេញ។',
  ' ប្រសិនបើបងមានចំណាប់អារម្មណ៍លើដីឡូតិ៍ ផ្ទះអាជីវកម្ម ផ្ទះរូប ឬចង់សាកសួរព័ត៌មានបន្ថែមអំពីគម្រោង ប្អូនរីករាយផ្តល់ព័ត៌មាន និងប្រឹក្សាជូនបងបាន',
  'សូមអរគុណបងដែលបានទាក់ទងមកកាន់ផេកយើងខ្ញុំ។ 🙏💙',
].join('\n');

/**
 * Resolve the effective default outreach message.
 * DB value (if a non-empty one is saved) → OUTREACH_STATIC_MESSAGE env →
 * DEFAULT_STATIC_MESSAGE. A DB read failure logs a warning and falls back so
 * generation never breaks.
 */
export async function getStaticOutreachMessage(orgId: OrgId = DEFAULT_ORG): Promise<string> {
  try {
    const saved = await new OutreachSettingsRepository().getStaticMessage(orgId);
    if (saved && saved.trim()) return saved.trim();
  } catch (err) {
    Logger.warn(`getStaticOutreachMessage DB read failed, using fallback: ${(err as Error).message}`);
  }
  return process.env.OUTREACH_STATIC_MESSAGE?.trim() || DEFAULT_STATIC_MESSAGE;
}
