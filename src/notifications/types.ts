export type NotificationChannelType = 'qq' | 'feishu';

export type QQChannelConfig = {
  chatType: 'private' | 'group';
  chatId: string;
};

export type WebhookChannelConfig = {
  webhookUrl: string;
  secret?: string;
};

export type NotificationChannelConfig = QQChannelConfig | WebhookChannelConfig;

export interface NotificationChannel {
  id: number;
  qq_id: string;
  type: NotificationChannelType;
  name: string;
  config: NotificationChannelConfig;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface StoredNotificationChannel extends Omit<NotificationChannel, 'config' | 'enabled'> {
  config_encrypted: string;
  enabled: number;
}

export interface NotificationPayload {
  title: string;
  text: string;
  markdown: string;
  images: Array<{ filename: string; buffer: Buffer }>;
  charts?: NotificationChart[];
  theme?: NotificationCardTheme;
}

export type NotificationCardTheme = 'blue' | 'red' | 'green' | 'purple';

export interface NotificationChartPoint {
  timestamp: string;
  electric: number;
  water: number;
}

export interface NotificationChart {
  title: string;
  points: NotificationChartPoint[];
}

export interface SendResult {
  providerMessageId?: string;
}

export interface NotificationProvider<TConfig extends NotificationChannelConfig> {
  readonly type: NotificationChannelType;
  validateConfig(config: TConfig): void;
  send(config: TConfig, payload: NotificationPayload): Promise<SendResult>;
}
