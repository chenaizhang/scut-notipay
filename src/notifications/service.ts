import type { NCWebsocket } from 'node-napcat-ts';
import { DingTalkProvider, FeishuProvider } from './providers/webhook.js';
import { QQProvider } from './providers/qq.js';
import type {
  NotificationChannel,
  NotificationChannelConfig,
  NotificationPayload,
  NotificationProvider
} from './types.js';

export class NotificationService {
  private readonly providers = new Map<
    string,
    {
      validateConfig: (config: NotificationChannelConfig) => void;
      send: (config: NotificationChannelConfig, payload: NotificationPayload) => Promise<unknown>;
    }
  >();

  constructor(napcat: NCWebsocket) {
    this.register(new QQProvider(napcat));
    this.register(new FeishuProvider());
    this.register(new DingTalkProvider());
  }

  private register<TConfig extends NotificationChannelConfig>(
    provider: NotificationProvider<TConfig>
  ): void {
    this.providers.set(provider.type, {
      validateConfig: (config) => provider.validateConfig(config as TConfig),
      send: (config, payload) => provider.send(config as TConfig, payload)
    });
  }

  validate(channel: Pick<NotificationChannel, 'type' | 'config'>): void {
    const provider = this.providers.get(channel.type);
    if (!provider) throw new Error(`不支持的通知渠道：${channel.type}`);
    provider.validateConfig(channel.config);
  }

  async send(channel: NotificationChannel, payload: NotificationPayload): Promise<void> {
    if (!channel.enabled) throw new Error('通知渠道已停用');
    const provider = this.providers.get(channel.type);
    if (!provider) throw new Error(`不支持的通知渠道：${channel.type}`);
    await provider.send(channel.config, payload);
  }
}
