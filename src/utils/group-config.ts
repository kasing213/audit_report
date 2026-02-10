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
}