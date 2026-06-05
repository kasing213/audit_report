// Fixed outreach message used while AI generation is disabled.
// Sent verbatim as the image caption to every selected lead.
// Override at runtime with OUTREACH_STATIC_MESSAGE (trimmed); otherwise the
// committed default below is used so no config is required to ship.

const DEFAULT_STATIC_MESSAGE = [
  'ជម្រាបសួរបង 🙏',
  'ប្អូនឈ្មោះ ធឿន ធារី ជាបុគ្គលិកផ្នែកលក់ប្រចាំគម្រោងដែលមានទីតាំងស្ថិតនៅ ផ្លូវជាតិលេខ៣ ម្តុំវត្តស្លែង ខណ្ឌដង្កោ រាជធានីភ្នំពេញ។',
  ' ប្រសិនបើបងមានចំណាប់អារម្មណ៍លើដីឡូតិ៍ ផ្ទះអាជីវកម្ម ផ្ទះរូប ឬចង់សាកសួរព័ត៌មានបន្ថែមអំពីគម្រោង ប្អូនរីករាយផ្តល់ព័ត៌មាន និងប្រឹក្សាជូនបងបាន',
  'សូមអរគុណបងដែលបានទាក់ទងមកកាន់ផេកយើងខ្ញុំ។ 🙏💙',
].join('\n');

export function getStaticOutreachMessage(): string {
  return process.env.OUTREACH_STATIC_MESSAGE?.trim() || DEFAULT_STATIC_MESSAGE;
}
