/**
 * ===== Telegram Group Architecture =====
 *
 * The bot operates across three types of Telegram groups:
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ SALES GROUPS (up to 8)                                         │
 * │                                                                 │
 * │ Env vars: SALES_GROUP_N_CHAT_ID + SALES_GROUP_N_NAME           │
 * │ (N = 1..8)                                                     │
 * │                                                                 │
 * │ Purpose: Sales staff enter customer data here                   │
 * │ Follower: Auto-set from SALES_GROUP_N_NAME                     │
 * │                                                                 │
 * │ Allowed commands:                                               │
 * │   /add    - Enter new customer data (interactive or arrow fmt)  │
 * │   /edit   - Edit existing customer records                      │
 * │   /delete - Delete customer records                             │
 * │   /help   - Show sales guide + copy template                   │
 * │                                                                 │
 * │ Active groups:                                                  │
 * │   1: SreySros  2: Bery     3: Theary  4: Seyi                  │
 * │   5: Pheaktra  6: Borey   7: Pisey                             │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ SUMMARY GROUP (1)                                               │
 * │                                                                 │
 * │ Env var: SUMMARY_CHAT_ID                                        │
 * │                                                                 │
 * │ Purpose: Management / CRM analysis                              │
 * │                                                                 │
 * │ Allowed commands:                                               │
 * │   /summary   - Monthly sales overview + follower performance    │
 * │   /customers - Customer list by follower + month                │
 * │   /report    - Generate Excel report                            │
 * │   /edit      - Edit records                                     │
 * │   /delete    - Delete records                                   │
 * │   /help      - Show management guide                            │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ AUDIT GROUP (1)                                                 │
 * │                                                                 │
 * │ Env var: AUDIT_CHAT_ID                                          │
 * │                                                                 │
 * │ Purpose: Automated reports + audit trail                        │
 * │                                                                 │
 * │ Receives automatically:                                         │
 * │   - Daily JPG report at 11:59 PM (per group + consolidated)    │
 * │   - Monthly Excel report on 1st of month at 12:01 AM           │
 * │   - Promise reminders at 8:00 AM daily                         │
 * │                                                                 │
 * │ Same commands as Summary group                                  │
 * └─────────────────────────────────────────────────────────────────┘
 */

export interface GroupConfig {
  groupId: string;
  chatId: string;
  name: string;
}

export class GroupConfigManager {
  private static instance: GroupConfigManager;
  private groupConfigs: Map<string, GroupConfig> = new Map();
  private chatIdToGroupId: Map<string, string> = new Map();

  private constructor() {
    this.loadConfigs();
  }

  public static getInstance(): GroupConfigManager {
    if (!GroupConfigManager.instance) {
      GroupConfigManager.instance = new GroupConfigManager();
    }
    return GroupConfigManager.instance;
  }

  private loadConfigs(): void {
    const groups = [
      {
        groupId: 'group_1',
        chatId: process.env.SALES_GROUP_1_CHAT_ID || '',
        name: process.env.SALES_GROUP_1_NAME || 'Group1'
      },
      {
        groupId: 'group_2',
        chatId: process.env.SALES_GROUP_2_CHAT_ID || '',
        name: process.env.SALES_GROUP_2_NAME || 'Group2'
      },
      {
        groupId: 'group_3',
        chatId: process.env.SALES_GROUP_3_CHAT_ID || '',
        name: process.env.SALES_GROUP_3_NAME || 'Group3'
      },
      {
        groupId: 'group_4',
        chatId: process.env.SALES_GROUP_4_CHAT_ID || '',
        name: process.env.SALES_GROUP_4_NAME || 'Group4'
      },
      {
        groupId: 'group_5',
        chatId: process.env.SALES_GROUP_5_CHAT_ID || '',
        name: process.env.SALES_GROUP_5_NAME || 'Group5'
      },
      {
        groupId: 'group_6',
        chatId: process.env.SALES_GROUP_6_CHAT_ID || '',
        name: process.env.SALES_GROUP_6_NAME || 'Group6'
      },
      {
        groupId: 'group_7',
        chatId: process.env.SALES_GROUP_7_CHAT_ID || '',
        name: process.env.SALES_GROUP_7_NAME || 'Group7'
      },
      {
        groupId: 'group_8',
        chatId: process.env.SALES_GROUP_8_CHAT_ID || '',
        name: process.env.SALES_GROUP_8_NAME || 'Group8'
      }
    ];

    for (const group of groups) {
      if (group.chatId) {
        this.groupConfigs.set(group.groupId, group);
        this.chatIdToGroupId.set(group.chatId, group.groupId);
      }
    }
  }

  public getGroupIdFromChatId(chatId: string | number): string | null {
    const chatIdStr = String(chatId);
    return this.chatIdToGroupId.get(chatIdStr) || null;
  }

  public getGroupConfig(groupId: string): GroupConfig | null {
    return this.groupConfigs.get(groupId) || null;
  }

  public getAllActiveGroups(): GroupConfig[] {
    return Array.from(this.groupConfigs.values());
  }

  public isSalesGroupChat(chatId: string | number): boolean {
    const chatIdStr = String(chatId);
    return this.chatIdToGroupId.has(chatIdStr);
  }

  public isSalesDataEntryChat(chatId: string | number): boolean {
    return this.isSalesGroupChat(chatId);
  }

  public isManagementSummaryChat(chatId: string | number): boolean {
    const chatIdStr = String(chatId);
    const summaryChatId = process.env.SUMMARY_CHAT_ID;
    return summaryChatId ? chatIdStr === summaryChatId : false;
  }

  public isAuditChat(chatId: string | number): boolean {
    const chatIdStr = String(chatId);
    const auditChatId = process.env.AUDIT_CHAT_ID;
    return auditChatId ? chatIdStr === auditChatId : false;
  }

  public isCommandAllowedInChat(chatId: string | number): boolean {
    return this.isManagementSummaryChat(chatId) || this.isAuditChat(chatId);
  }

  public getAllFollowerNames(): string[] {
    return Array.from(this.groupConfigs.values()).map(g => g.name);
  }
}