import { createHmac } from 'crypto';
import { normalizeCurrency } from '../../utils/money.js';
import type {
  NotificationChart,
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

const formatChartTime = (timestamp: string): string => {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return timestamp;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
};

const prepareChartPoints = (chart: NotificationChart): NotificationChart['points'] => {
  const uniquePoints = new Map<number, NotificationChart['points'][number]>();
  for (const point of chart.points) {
    const timestamp = new Date(point.timestamp).getTime();
    if (
      Number.isNaN(timestamp) ||
      !Number.isFinite(point.electric) ||
      !Number.isFinite(point.water)
    )
      continue;
    uniquePoints.set(timestamp, {
      ...point,
      electric: normalizeCurrency(point.electric),
      water: normalizeCurrency(point.water)
    });
  }
  const points = [...uniquePoints.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, point]) => point);
  const maxPoints = 48;
  if (points.length <= maxPoints) return points;
  return Array.from(
    { length: maxPoints },
    (_, index) => points[Math.floor((index * (points.length - 1)) / (maxPoints - 1))]
  );
};

const buildChartElement = (
  chart: NotificationChart,
  points: NotificationChart['points']
): Record<string, unknown> => ({
  tag: 'chart',
  chart_spec: {
    type: 'line',
    title: { visible: true, text: chart.title },
    data: {
      values: points.flatMap((point) => [
        { time: formatChartTime(point.timestamp), type: '电费', value: point.electric },
        { time: formatChartTime(point.timestamp), type: '水费', value: point.water }
      ])
    },
    xField: 'time',
    yField: 'value',
    seriesField: 'type',
    legends: { visible: true, orient: 'bottom' },
    point: { visible: points.length <= 24 },
    line: { curveType: 'monotone' },
    axes: [
      { orient: 'left', title: { visible: true, text: '余额（元）' } },
      { orient: 'bottom', label: { autoRotate: true, autoHide: true } }
    ],
    tooltip: { visible: true },
    media: []
  },
  aspect_ratio: '16:9'
});

export class FeishuProvider implements NotificationProvider<WebhookChannelConfig> {
  readonly type = 'feishu' as const;

  validateConfig(config: WebhookChannelConfig): void {
    validateWebhook(config.webhookUrl, 'open.feishu.cn');
  }

  async send(config: WebhookChannelConfig, payload: NotificationPayload): Promise<SendResult> {
    this.validateConfig(config);
    const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: payload.markdown }];
    for (const chart of payload.charts ?? []) {
      const points = prepareChartPoints(chart);
      if (points.length >= 2) {
        elements.push({ tag: 'hr' });
        elements.push(buildChartElement(chart, points));
      }
    }
    const body: Record<string, unknown> = {
      msg_type: 'interactive',
      card: {
        schema: '2.0',
        config: { summary: { content: payload.title } },
        header: {
          title: { tag: 'plain_text', content: payload.title },
          template: payload.theme ?? 'blue'
        },
        body: { elements, vertical_spacing: '12px', padding: '12px' }
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
