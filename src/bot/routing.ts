import { GroupConfigManager } from '../utils/group-config';

/** What a chat is set up as. null = not configured for this bot. */
export type ChatRole = 'sales' | 'closing' | 'summary' | 'audit' | null;

export type PasteKind = 'bulk' | 'closeSell';

export function chatRole(chatId: number | string, gm: GroupConfigManager = GroupConfigManager.getInstance()): ChatRole {
  if (gm.isClosingGroupChat(chatId)) return 'closing';
  if (gm.isSalesGroupChat(chatId)) return 'sales';
  if (gm.isManagementSummaryChat(chatId)) return 'summary';
  if (gm.isAuditChat(chatId)) return 'audit';
  return null;
}

/**
 * Close-sell reports belong in the closing group and Bulk reports in the sales
 * group. Until a closing group is configured, the sales group takes both, as it
 * always has. The summary and audit chats take either.
 */
export function routePaste(kind: PasteKind, role: ChatRole, closingConfigured: boolean): 'accept' | 'wrongGroup' | 'ignore' {
  if (role === 'summary' || role === 'audit') return 'accept';
  if (role === 'closing') return kind === 'closeSell' ? 'accept' : 'wrongGroup';
  if (role === 'sales') {
    if (kind === 'bulk' || !closingConfigured) return 'accept';
    return 'wrongGroup';
  }
  return 'ignore';
}

export const WRONG_GROUP_REPLY: Record<PasteKind, string> = {
  closeSell: '💯 របាយការណ៍ Close sell សូមបិទភ្ជាប់ក្នុងក្រុម Closing។ ក្រុមនេះទទួលតែ Bulk ប៉ុណ្ណោះ។ មិនទាន់រក្សាទុកទេ។',
  bulk: '📋 របាយការណ៍ Bulk សូមបិទភ្ជាប់ក្នុងក្រុមលក់។ ក្រុមនេះទទួលតែ Close sell ប៉ុណ្ណោះ។ មិនទាន់រក្សាទុកទេ។',
};

const ROLE_LABEL: Record<Exclude<ChatRole, null>, string> = {
  sales: 'Sales group (Bulk daily report)',
  closing: 'Closing group (Close sell report)',
  summary: 'Summary group',
  audit: 'Audit group',
};

/** The /start reply: the chat's ID and what it is set up as. */
export function describeChat(chat: { id: number; title?: string; type: string }, role: ChatRole): string {
  const lines = [`🆔 Chat ID: ${chat.id}`];
  if (chat.title) lines.push(`👥 ${chat.title}`);
  if (role) {
    lines.push(`✅ ${ROLE_LABEL[role]}`);
  } else if (chat.type === 'private') {
    lines.push('This is a private chat.');
  } else {
    lines.push('⚙️ Not set up yet. To make this the closing group, set on Railway:');
    lines.push(`CLOSING_GROUP_CHAT_ID=${chat.id}`);
  }
  return lines.join('\n');
}
