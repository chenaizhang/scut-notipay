export type NotificationChannelType = 'qq' | 'feishu' | 'dingtalk';

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
}

export interface SendResult {
  providerMessageId?: string;
}

export interface NotificationProvider<TConfig extends NotificationChannelConfig> {
  readonly type: NotificationChannelType;
  validateConfig(config: TConfig): void;
  send(config: TConfig, payload: NotificationPayload): Promise<SendResult>;
}
