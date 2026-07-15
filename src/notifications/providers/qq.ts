import type { NCWebsocket } from 'node-napcat-ts';
import type { SendMessageSegment } from 'node-napcat-ts';
import type {
  NotificationPayload,
  NotificationProvider,
  QQChannelConfig,
  SendResult
} from '../types.js';

export class QQProvider implements NotificationProvider<QQChannelConfig> {
  readonly type = 'qq' as const;

  constructor(private readonly client: NCWebsocket) {}

  validateConfig(config: QQChannelConfig): void {
    if (!['private', 'group'].includes(config.chatType) || !/^\d+$/.test(config.chatId)) {
      throw new Error('QQ 渠道配置无效');
    }
  }

  async send(config: QQChannelConfig, payload: NotificationPayload): Promise<SendResult> {
    this.validateConfig(config);
    const message: SendMessageSegment[] = [{ type: 'text', data: { text: payload.text } }];
    for (const image of payload.images) {
      message.push({
        type: 'image',
        data: { file: `base64://${image.buffer.toString('base64')}` }
      });
    }
    if (config.chatType === 'private') {
      await this.client.send_private_msg({ user_id: Number(config.chatId), message });
    } else {
      await this.client.send_group_msg({ group_id: Number(config.chatId), message });
    }
    return {};
  }
}
