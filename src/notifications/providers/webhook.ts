import { createHmac } from 'crypto';
import type {
  NotificationPayload,
  NotificationProvider,
  SendResult,
  WebhookChannelConfig
} from '../types.js';

const postJson = async (url: string, body: unknown): Promise<Record<string, unknown>> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Keep the HTTP status as the useful error when the upstream returns non-JSON.
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  return result;
};

const validateWebhook = (url: string, hostname: string): void => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== hostname) {
    throw new Error(`Webhook 必须是 ${hostname} 的 HTTPS 地址`);
  }
};

export class FeishuProvider implements NotificationProvider<WebhookChannelConfig> {
  readonly type = 'feishu' as const;

  validateConfig(config: WebhookChannelConfig): void {
    validateWebhook(config.webhookUrl, 'open.feishu.cn');
  }

  async send(config: WebhookChannelConfig, payload: NotificationPayload): Promise<SendResult> {
    this.validateConfig(config);
    const body: Record<string, unknown> = {
      msg_type: 'interactive',
      card: {
        header: { title: { tag: 'plain_text', content: payload.title }, template: 'blue' },
        elements: [{ tag: 'markdown', content: payload.markdown }]
      }
    };
    if (config.secret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const stringToSign = `${timestamp}\n${config.secret}`;
      body.timestamp = timestamp;
      body.sign = createHmac('sha256', stringToSign).update('').digest('base64');
    }
    const result = await postJson(config.webhookUrl, body);
    if (result.code !== undefined && result.code !== 0) {
      throw new Error(`飞书返回错误 ${String(result.code)}: ${String(result.msg ?? '')}`);
    }
    return {};
  }
}

export class DingTalkProvider implements NotificationProvider<WebhookChannelConfig> {
  readonly type = 'dingtalk' as const;

  validateConfig(config: WebhookChannelConfig): void {
    validateWebhook(config.webhookUrl, 'oapi.dingtalk.com');
  }

  async send(config: WebhookChannelConfig, payload: NotificationPayload): Promise<SendResult> {
    this.validateConfig(config);
    const url = new URL(config.webhookUrl);
    if (config.secret) {
      const timestamp = Date.now().toString();
      const sign = createHmac('sha256', config.secret)
        .update(`${timestamp}\n${config.secret}`)
        .digest('base64');
      url.searchParams.set('timestamp', timestamp);
      url.searchParams.set('sign', sign);
    }
    const result = await postJson(url.toString(), {
      msgtype: 'markdown',
      markdown: { title: payload.title, text: `### ${payload.title}\n\n${payload.markdown}` }
    });
    if (result.errcode !== undefined && result.errcode !== 0) {
      throw new Error(`钉钉返回错误 ${String(result.errcode)}: ${String(result.errmsg ?? '')}`);
    }
    return {};
  }
}
