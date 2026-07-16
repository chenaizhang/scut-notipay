import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { NCWebsocket } from 'node-napcat-ts';
import type { AllHandlers, SendMessageSegment } from 'node-napcat-ts';
import config from '../config.json' with { type: 'json' };
import { obtainToken as login } from './utils/session.js';
import { getBills } from './utils/billing.js';
import { db, scheduler, type Campus } from './utils/database.js';
import type { NotificationThresholds } from './utils/scheduler.js';
import { generateBillingCharts, generateBillingSummary } from './utils/presentation.js';
import { APP_NAME, CAMPUSES, DATA_COLLECTION_BATCH_SIZE, GITHUB_LINK } from './utils/constants.js';
import { NotificationService } from './notifications/service.js';
import type { WebhookChannelConfig } from './notifications/types.js';

let commitHash: string;
try {
  commitHash = execSync('git rev-parse HEAD').toString().trim().slice(0, 7);
} catch (e) {
  console.error('Failed to get git commit hash:', e);
  commitHash = 'unknown';
}

/**
 * Parse a relative time string and return the duration in hours
 * Supports formats like:
 * - "7h" (7 hours)
 * - "3d" (3 days)
 * - "2w" (2 weeks)
 */
const parseRelativeTime = (param: string): number => {
  const cleanParam = param.replace(/[^0-9a-zA-Z]/g, '');
  const unitMatch = cleanParam.match(/^(\d+)([hdw])$/i);

  if (unitMatch) {
    const value = parseInt(unitMatch[1], 10);
    const unit = unitMatch[2].toLowerCase();

    if (unit === 'h') {
      return value;
    } else if (unit === 'd') {
      return value * 24;
    } else if (unit === 'w') {
      return value * 24 * 7;
    }
  }

  throw new Error('Invalid relative time format');
};

/**
 * Calculate the next fetch time based on last login or creation time and interval
 */
const calculateNextFetchTime = (
  lastLogin: string | undefined,
  createdAt: string,
  intervalHours: number
): Date => {
  let baseTime: Date;
  if (lastLogin) {
    // If fetched before, use last fetch time rounded to nearest hour
    baseTime = new Date(lastLogin);
    if (baseTime.getMinutes() >= 30) {
      baseTime.setHours(baseTime.getHours() + 1);
    }
    baseTime.setMinutes(0, 0, 0);
  } else {
    // If never fetched, use creation time rounded to nearest hour
    baseTime = new Date(createdAt);
    if (baseTime.getMinutes() >= 30) {
      baseTime.setHours(baseTime.getHours() + 1);
    }
    baseTime.setMinutes(0, 0, 0);
  }

  return new Date(baseTime.getTime() + intervalHours * 60 * 60 * 1000);
};

type AlignedFetchSlot = { nominalTime: Date; targetTime: Date };

const getAlignedFetchSlot = (
  now: Date,
  baseTime: Date,
  intervalHours: number,
  jitterMinutes: number,
  key: string
): AlignedFetchSlot | null => {
  if (
    intervalHours < 1 ||
    intervalHours > 24 ||
    24 % intervalHours !== 0 ||
    !Number.isInteger(jitterMinutes) ||
    jitterMinutes < 1
  )
    return null;

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const slotsPerDay = 24 / intervalHours;
  let latest: AlignedFetchSlot | null = null;

  for (let slot = -1; slot <= slotsPerDay; slot += 1) {
    const nominalTime = new Date(dayStart.getTime() + slot * intervalHours * 60 * 60 * 1000);
    const digest = createHash('sha256').update(`${key}:${nominalTime.toISOString()}`).digest();
    const choice = digest.readUInt32BE(0) % (jitterMinutes * 2);
    const offsetMinutes =
      choice < jitterMinutes ? choice - jitterMinutes : choice - jitterMinutes + 1;
    const targetTime = new Date(nominalTime.getTime() + offsetMinutes * 60 * 1000);

    if (targetTime <= now && targetTime > baseTime && (!latest || targetTime > latest.targetTime)) {
      latest = { nominalTime, targetTime };
    }
  }

  return latest;
};

/**
 * Parse a time parameter from user input (using local time UTC+8)
 * Supports formats like:
 * - "7h" (7 hours ago)
 * - "3d" (3 days ago)
 * - "2w" (2 weeks ago)
 * - "1030" (Oct 30 00:00)
 * - "10302330" (Oct 30 23:30)
 * - "10-30|23:30" (with delimiters)
 */
const parseTimeParameter = (param: string): Date => {
  // Get current time in local timezone (UTC+8)
  const now = new Date();

  // Try to parse as relative time first
  try {
    const hours = parseRelativeTime(param);
    const result = new Date(now);
    result.setHours(result.getHours() - hours);
    return result;
  } catch {
    // Not a relative time format, continue to other formats
  }

  // Check for delimiters (-, /, :, |, space) to parse as date/time
  const hasDelimiters = /[-/::\s|]/.test(param);

  if (hasDelimiters) {
    // Split by delimiters and extract numbers
    const parts = param.split(/[-/::\s|]+/).filter((p) => p.trim());

    if (parts.length < 2) {
      throw new Error('日期格式不正确，需要至少包含月份和日期');
    }

    // Parse as: month day [hour] [minute]
    const month = parseInt(parts[0], 10);
    const day = parseInt(parts[1], 10);
    const hour = parts.length > 2 ? parseInt(parts[2], 10) : 0;
    const minute = parts.length > 3 ? parseInt(parts[3], 10) : 0;

    if (isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error('日期格式不正确');
    }

    if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error('时间格式不正确');
    }

    // Create date in local timezone
    const result = new Date(now.getFullYear(), month - 1, day, hour, minute, 0, 0);

    // If the parsed date is in the future, assume it's from last year
    if (result > now) {
      result.setFullYear(result.getFullYear() - 1);
    }

    return result;
  }

  // Parse as continuous digits (e.g., "1030" or "10302330")
  const cleanParam = param.replace(/[^0-9a-zA-Z]/g, '');
  const digitsOnly = cleanParam;

  if (digitsOnly.length < 4) {
    // Less than 4 digits, treat as hours with default unit
    const hours = parseInt(digitsOnly, 10);
    if (isNaN(hours)) {
      throw new Error('时间参数格式不正确');
    }
    const result = new Date(now);
    result.setHours(result.getHours() - hours);
    return result;
  }

  // 4 or more digits: parse as MMDD or MMDDHHMM
  const month = parseInt(digitsOnly.substring(0, 2), 10);
  const day = parseInt(digitsOnly.substring(2, 4), 10);

  let hour = 0;
  let minute = 0;

  if (digitsOnly.length >= 6) {
    hour = parseInt(digitsOnly.substring(4, 6), 10);
  }
  if (digitsOnly.length >= 8) {
    minute = parseInt(digitsOnly.substring(6, 8), 10);
  }

  if (isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error('日期格式不正确');
  }

  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('时间格式不正确');
  }

  // Create date in local timezone
  const result = new Date(now.getFullYear(), month - 1, day, hour, minute, 0, 0);

  // If the parsed date is in the future, assume it's from last year
  if (result > now) {
    result.setFullYear(result.getFullYear() - 1);
  }

  return result;
};

/**
 * Store an access token for a user
 */
const storeToken = (
  qqId: string,
  accessToken: string,
  TGC: string,
  loc_session: string,
  expiresIn: number
) => {
  db.updateTokens(qqId, accessToken, TGC, loc_session, expiresIn);
  console.log(`[Token] Stored token for QQ ${qqId}, expires in ${expiresIn}s`);
};

/**
 * Get a valid access token for a user
 * Uses cached token if available and valid, otherwise obtains a new one
 */
const getValidToken = async (qqId: string): Promise<[string, string, string]> => {
  // Try to get stored token
  const storedToken = db.getTokens(qqId);
  if (storedToken) {
    return storedToken;
  }

  // No valid stored token, need to login
  const credentials = db.getCredentials(qqId);
  if (!credentials) {
    throw new Error('No credentials found for user');
  }

  const result = await login(credentials.cardId, credentials.password);
  if (result === null) {
    throw new Error('Login failed');
  }

  // Store the new token
  storeToken(qqId, result.access_token, result.TGC, result.locSession, result.expires_in);

  return [result.access_token, result.TGC, result.locSession];
};

/**
 * Get the user's campus
 */
const getCampus = (qqId: string): Campus => {
  const result = db.getCampus(qqId);

  if (!result) {
    throw new Error('No campus found for user');
  }

  return result;
};

/**
 * Get bills with automatic token refresh on failure
 */
const getBillsWithTokenRefresh = async (qqId: string) => {
  try {
    // First attempt with cached token
    const [token, TGC, locSession] = await getValidToken(qqId);
    return await getBills(token, TGC, locSession, getCampus(qqId));
  } catch {
    // If getBills failed, the token might be invalid despite not being expired
    // Clear the token and try once more with a fresh login
    db.clearAccessToken(qqId);

    const credentials = db.getCredentials(qqId);
    if (!credentials) {
      throw new Error('No credentials found for user');
    }

    const result = await login(credentials.cardId, credentials.password);
    if (result === null) {
      throw new Error('Login failed');
    }
    storeToken(qqId, result.access_token, result.TGC, result.locSession, result.expires_in);

    // Retry with fresh token
    return await getBills(result.access_token, result.TGC, result.locSession, getCampus(qqId));
  }
};

const napcat = new NCWebsocket(
  {
    baseUrl: config.napcatWs,
    accessToken: config.napcatToken,
    throwPromise: true,
    reconnection: {
      enable: true,
      attempts: 10,
      delay: 5000
    }
  },
  false
);

type RuntimeMode = 'standalone' | 'service';

const resolveRuntimeMode = (mode: string): RuntimeMode => {
  if (mode === 'standalone' || mode === 'service') return mode;
  if (mode === 'qq') {
    console.warn('[Config] mode "qq" 已更名为 "service"，请更新 config.json。');
    return 'service';
  }
  throw new Error('mode 必须是 standalone 或 service');
};

const runtimeMode = resolveRuntimeMode(config.mode);
const isStandalone = runtimeMode === 'standalone';
const notificationService = new NotificationService(napcat, runtimeMode);

type StandaloneNotificationKind = 'daily' | 'lowBalance' | 'weeklyReport' | 'monthlyReport';

const getEnabledStandaloneNotifications = (): StandaloneNotificationKind[] => {
  const notification = config.standalone?.notification as
    | { enabledNotifications?: unknown }
    | undefined;
  const enabled = notification?.enabledNotifications;
  if (enabled === undefined) return ['daily', 'lowBalance'];
  if (
    !Array.isArray(enabled) ||
    enabled.some(
      (value) =>
        value !== 'daily' &&
        value !== 'lowBalance' &&
        value !== 'weeklyReport' &&
        value !== 'monthlyReport'
    )
  ) {
    throw new Error('standalone.notification.enabledNotifications 包含不支持的通知类型');
  }
  return [...new Set(enabled)] as StandaloneNotificationKind[];
};

type ReportScheduleConfig = {
  weekly: { dayOfWeek: number; hour: number; minute: number };
  monthly: { dayOfMonth: number; hour: number; minute: number };
};

const getStandaloneReportSchedule = (): ReportScheduleConfig => {
  const configured = (
    config.standalone?.notification as unknown as { reports?: Partial<ReportScheduleConfig> }
  )?.reports;
  const schedule: ReportScheduleConfig = {
    weekly: { dayOfWeek: 1, hour: 8, minute: 5, ...configured?.weekly },
    monthly: { dayOfMonth: 1, hour: 8, minute: 10, ...configured?.monthly }
  };
  const validTime = (value: { hour: number; minute: number }) =>
    Number.isInteger(value.hour) &&
    value.hour >= 0 &&
    value.hour <= 23 &&
    Number.isInteger(value.minute) &&
    value.minute >= 0 &&
    value.minute <= 59;
  if (
    !validTime(schedule.weekly) ||
    !Number.isInteger(schedule.weekly.dayOfWeek) ||
    schedule.weekly.dayOfWeek < 0 ||
    schedule.weekly.dayOfWeek > 6
  )
    throw new Error('standalone.notification.reports.weekly 配置无效');
  if (
    !validTime(schedule.monthly) ||
    !Number.isInteger(schedule.monthly.dayOfMonth) ||
    schedule.monthly.dayOfMonth < 1 ||
    schedule.monthly.dayOfMonth > 28
  )
    throw new Error('standalone.notification.reports.monthly 配置无效');
  return schedule;
};

const configureStandaloneMode = () => {
  const standalone = config.standalone;
  if (!standalone) throw new Error('standalone 模式缺少 standalone 配置');
  if (!['GZIC', 'DXC'].includes(standalone.campus)) {
    throw new Error('standalone.campus 必须是 GZIC 或 DXC');
  }
  if (!standalone.cardId || standalone.cardId === 'your_card_id') {
    throw new Error('请配置 standalone.cardId');
  }
  if (!standalone.password || standalone.password === 'your_card_password') {
    throw new Error('请配置 standalone.password');
  }

  const ownerId = `standalone:${standalone.id || 'default'}`;
  db.addStudent(
    ownerId,
    standalone.cardId,
    standalone.campus as Campus,
    standalone.password,
    standalone.name,
    undefined,
    standalone.fetchInterval || '1d'
  );

  const notification = standalone.notification;
  if (!notification) {
    console.log('[Standalone] 未配置通知，仅定时采集数据。');
    return;
  }
  getEnabledStandaloneNotifications();
  getStandaloneReportSchedule();
  const channelConfig = notification.channel;
  if (!channelConfig || channelConfig.type !== 'feishu') {
    throw new Error('standalone.notification.channel.type 仅支持 feishu');
  }
  const channelType = 'feishu' as const;
  const webhookConfig: WebhookChannelConfig = {
    webhookUrl: channelConfig.webhookUrl,
    ...(channelConfig.secret ? { secret: channelConfig.secret } : {})
  };
  notificationService.validate({ type: channelType, config: webhookConfig });
  const channel = scheduler.upsertChannel(
    ownerId,
    channelType,
    channelConfig.name || '默认通知',
    webhookConfig
  );
  const thresholds = (notification as { thresholds?: NotificationThresholds }).thresholds;
  const rule = scheduler.setNotification(
    'private',
    ownerId,
    ownerId,
    notification.hour,
    notification.threshold ?? undefined,
    notification.lines || 'ewa',
    thresholds
  );
  scheduler.setNotificationChannels(rule.id!, ownerId, [channel.id]);
  console.log(`[Standalone] 配置已加载，通知时间为每天 ${notification.hour}:00。`);
};

// Small generic signallable promise: call `signal()` to resolve the promise.
const createSignallable = <T>() => {
  // start with a noop resolver to avoid definite-assignment / non-null assertions
  let resolver: (value: T) => void = () => undefined as unknown as void;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    signal(value: T) {
      resolver(value);
    }
  } as { promise: Promise<T>; signal: (value: T) => void };
};

const socketClose = createSignallable<void>();

napcat.on('socket.open', () => {
  console.log('[NapCat] Connected.');
  startHourlyTimer();
});

napcat.on('socket.close', () => {
  console.log('[NapCat] Disconnected.');
  try {
    socketClose.signal(undefined);
  } catch {
    // ignore if already resolved
  }
});

const parseMessage = (context: AllHandlers['message']) => {
  const message = context.message.find((m) => m.type === 'text');
  if (!message) return { command: null, args: null };
  const text = message.data.text.trim();
  const segments = text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return { command: null, args: null };
  const command = segments[0].toLowerCase();
  if (!config.commandNames.includes(command)) return { command: null, args: null };
  return { command, args: segments.slice(1) };
};

// Combined timer for data collection and notifications
let hourlyTimeout: NodeJS.Timeout | null = null;
let hourlyInterval: NodeJS.Timeout | null = null;
const lastFetchAttemptBySlot = new Map<string, number>();

/**
 * Type for collected student billing data
 */
type CollectedData = {
  qqId: string;
  name: string | null | undefined;
  electric: number;
  water: number;
  ac: number;
  room: string;
  success: boolean;
  error?: Error;
};

type FeishuTextColor = 'red' | 'green' | 'grey' | 'orange' | 'blue' | 'purple';

const escapeMarkdown = (value: string): string => value.replace(/([\\`*_[\]<>#])/g, '\\$1');

const richAmount = (value: number, color: FeishuTextColor): string =>
  `<font color='${color}'>**${value.toFixed(2)} 元**</font>`;

const richChange = (value: number): string => {
  const color: FeishuTextColor = value < 0 ? 'red' : value > 0 ? 'green' : 'grey';
  const formatted = `${value > 0 ? '+' : ''}${value.toFixed(2)} 元`;
  return `<font color='${color}'>**${formatted}**</font>`;
};

const richRoom = (room: string): string => `🏠 **宿舍**\u3000\`${escapeMarkdown(room)}\``;

/**
 * Collect billing data for a single student
 */
const collectStudentData = async (student: {
  qq_id: string;
  name?: string | null;
  student_number?: string;
}): Promise<CollectedData> => {
  try {
    // Get credentials
    const credentials = db.getCredentials(student.qq_id);
    if (!credentials) {
      console.log(`[Scheduler] No credentials for QQ ${student.qq_id}, skipping`);
      return {
        qqId: student.qq_id,
        name: student.name,
        electric: 0,
        water: 0,
        ac: 0,
        room: '',
        success: false,
        error: new Error('No credentials found')
      };
    }

    // Get bills with automatic token management
    const { electric, ac, water, room } = await getBillsWithTokenRefresh(student.qq_id);

    // Record billing history
    db.addBillingHistory(student.qq_id, electric, water, ac, room);
    console.log(`[Scheduler] Collected data for ${student.name || student.qq_id} (${room})`);
    db.updateLastLogin(student.qq_id);

    return {
      qqId: student.qq_id,
      name: student.name,
      electric,
      water,
      ac,
      room,
      success: true
    };
  } catch (error) {
    console.error(`[Scheduler] Failed to collect data for QQ ${student.qq_id}:`, error);
    return {
      qqId: student.qq_id,
      name: student.name,
      electric: 0,
      water: 0,
      ac: 0,
      room: '',
      success: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
};

/**
 * Process students in parallel batches
 */
const collectData = async (
  students: { qq_id: string; name?: string | null; student_number?: string }[],
  batchSize: number
): Promise<CollectedData[]> => {
  const results: CollectedData[] = [];

  for (let i = 0; i < students.length; i += batchSize) {
    const batch = students.slice(i, i + batchSize);
    console.log(
      `[Scheduler] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(students.length / batchSize)} (${batch.length} students)`
    );

    const batchResults = await Promise.all(batch.map((student) => collectStudentData(student)));
    results.push(...batchResults);

    // Small delay between batches to avoid overwhelming the server
    if (i + batchSize < students.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return results;
};

/**
 * Send notifications for a student based on collected data
 */
const sendNotificationForStudent = async (
  collectedData: CollectedData,
  currentHour: number,
  mode: 'daily' | 'threshold'
): Promise<void> => {
  if (!collectedData.success) {
    console.log(
      `[Scheduler] Skipping notifications for ${collectedData.name || collectedData.qqId} due to data collection failure`
    );
    return;
  }

  const { qqId, name, electric, water, ac, room } = collectedData;
  const standaloneOwnerId = `standalone:${config.standalone?.id || 'default'}`;
  if (isStandalone && qqId === standaloneOwnerId) {
    const kind: StandaloneNotificationKind = mode === 'daily' ? 'daily' : 'lowBalance';
    if (!getEnabledStandaloneNotifications().includes(kind)) return;
  }
  const notifications =
    mode === 'daily'
      ? scheduler.getNotificationsAtHourForUser(qqId, currentHour)
      : scheduler.getNotificationsForUser(qqId);

  for (const notification of notifications) {
    try {
      const configuredLines = notification.lines || 'ewa';
      const lines =
        isStandalone && qqId === standaloneOwnerId
          ? configuredLines.replace(/a/gi, '')
          : configuredLines;
      let thresholdState: { electric: boolean; water: boolean; ac: boolean } | null = null;
      let thresholdCondition = '';

      if (mode === 'daily') {
        if (notification.last_sent) {
          const lastSent = new Date(notification.last_sent);
          const now = new Date();
          if (
            lastSent.getFullYear() === now.getFullYear() &&
            lastSent.getMonth() === now.getMonth() &&
            lastSent.getDate() === now.getDate()
          )
            continue;
        }
      } else {
        const fallback = notification.threshold;
        const electricThreshold = notification.electric_threshold ?? fallback;
        const waterThreshold = notification.water_threshold ?? fallback;
        const acThreshold = notification.ac_threshold ?? fallback;
        const hasThreshold =
          (lines.toLowerCase().includes('e') && electricThreshold != null) ||
          (lines.toLowerCase().includes('w') && waterThreshold != null) ||
          (lines.toLowerCase().includes('a') && acThreshold != null);
        if (!hasThreshold) continue;

        thresholdState = {
          electric:
            lines.toLowerCase().includes('e') &&
            electricThreshold !== null &&
            electricThreshold !== undefined &&
            electric >= -10 &&
            electric <= electricThreshold,
          water:
            lines.toLowerCase().includes('w') &&
            waterThreshold !== null &&
            waterThreshold !== undefined &&
            water >= -10 &&
            water <= waterThreshold,
          ac:
            lines.toLowerCase().includes('a') &&
            acThreshold !== null &&
            acThreshold !== undefined &&
            ac >= -10 &&
            ac <= acThreshold
        };
        const conditions: string[] = [];
        if (thresholdState.electric) conditions.push(`电费 ≤ ${electricThreshold} 元`);
        if (thresholdState.water) conditions.push(`水费 ≤ ${waterThreshold} 元`);
        if (thresholdState.ac) conditions.push(`空调费 ≤ ${acThreshold} 元`);
        if (conditions.length > 0) thresholdCondition = `（${conditions.join('、')}）`;
        const newlyBelow =
          (thresholdState.electric && notification.electric_alerted !== 1) ||
          (thresholdState.water && notification.water_alerted !== 1) ||
          (thresholdState.ac && notification.ac_alerted !== 1);
        if (!newlyBelow) {
          scheduler.updateThresholdAlertState(notification.id!, thresholdState);
          continue;
        }
      }

      console.log(`[Scheduler] Sending ${mode} notification to ${name || qqId} (${room})`);

      // Get 24h change
      const change24h = db.getBilling24HourChange(qqId);

      // Get history for chart
      const history = db.getBillingHistory(qqId, 7);

      const changes = change24h || { electric: 0, water: 0, ac: 0 };
      const formatChange = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
      let messageText = `宿舍: ${room}\n\n`;
      if (mode === 'daily') {
        messageText += '当前余额:\n';
        messageText += `⚡ 电费：${electric.toFixed(2)} 元\n`;
        messageText += `💧 水费：${water.toFixed(2)} 元\n\n`;
        messageText += '最近 24 小时:\n';
        messageText += `⚡ 电费：${formatChange(changes.electric)} 元\n`;
        messageText += `💧 水费：${formatChange(changes.water)} 元\n`;
      } else {
        messageText += `⚠️ 余额已达到提醒阈值${thresholdCondition}\n\n`;
        messageText += '当前余额：\n';
        messageText += `⚡ 电费：${electric.toFixed(2)} 元\n`;
        messageText += `💧 水费：${water.toFixed(2)} 元\n\n`;
        messageText += '最近 24 小时：\n';
        messageText += `⚡ 电费：${formatChange(changes.electric)} 元\n`;
        messageText += `💧 水费：${formatChange(changes.water)} 元\n`;
      }

      const thresholdDescription = thresholdCondition || '（已配置阈值）';
      const messageMarkdown =
        mode === 'daily'
          ? [
              richRoom(room),
              '<hr>',
              '### 当前余额',
              `⚡ **电费**\u3000${richAmount(electric, 'orange')}`,
              `💧 **水费**\u3000${richAmount(water, 'blue')}`,
              '<hr>',
              '### 最近 24 小时',
              `⚡ **电费变化**\u3000${richChange(changes.electric)}`,
              `💧 **水费变化**\u3000${richChange(changes.water)}`
            ].join('\n\n')
          : [
              richRoom(room),
              `> <font color='red'>**⚠️ 余额已达到提醒阈值**</font><br>> ${thresholdDescription}`,
              '<hr>',
              '### 当前余额',
              `⚡ **电费**\u3000${richAmount(electric, thresholdState?.electric ? 'red' : 'orange')}`,
              `💧 **水费**\u3000${richAmount(water, thresholdState?.water ? 'red' : 'blue')}`,
              '<hr>',
              '### 最近 24 小时',
              `⚡ **电费变化**\u3000${richChange(changes.electric)}`,
              `💧 **水费变化**\u3000${richChange(changes.water)}`
            ].join('\n\n');

      const chartImages: Array<{ filename: string; buffer: Buffer }> = [];

      // Service mode keeps QQ PNG charts. Standalone Feishu daily and alerts are text-only.
      if (!isStandalone && history.length >= 2) {
        const chartData = history.reverse().map((h) => ({
          timestamp: h.recorded_at,
          electric: h.electric,
          water: h.water,
          ac: h.ac
        }));

        const charts = await generateBillingCharts(
          chartData,
          room,
          mode === 'daily' ? 'ew' : lines
        );
        for (const [index, chart] of charts.entries()) {
          chartImages.push({ filename: `billing-${index + 1}.png`, buffer: chart.buffer });
        }
      }

      const channels = scheduler
        .getChannelsForNotification(notification.id!, qqId)
        .filter((channel) => channel.type === (isStandalone ? 'feishu' : 'qq'));
      const payload = {
        title: `${mode === 'daily' ? '宿舍余额日报' : '宿舍余额不足提醒'} · ${room}`,
        text: messageText,
        markdown: messageMarkdown,
        images: chartImages,
        theme: mode === 'daily' ? ('blue' as const) : ('red' as const)
      };
      let sent = false;
      for (const channel of channels) {
        try {
          await notificationService.send(channel, payload);
          sent = true;
          console.log(
            `[Scheduler] Sent notification through ${channel.type} channel ${channel.id}`
          );
        } catch (error) {
          console.error(`[Scheduler] Failed channel ${channel.id} (${channel.type}):`, error);
        }
      }
      if (sent && mode === 'daily') scheduler.updateLastSent(notification.id!);
      if (sent && mode === 'threshold' && thresholdState) {
        scheduler.updateThresholdAlertState(notification.id!, thresholdState);
      }
    } catch (error) {
      console.error(
        `[Scheduler] Failed to send notification for QQ ${qqId} to ${notification.chat_type} ${notification.chat_id}:`,
        error
      );
    }
  }
};

type ReportType = 'weekly' | 'monthly';

const formatDate = (value: Date): string =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

const makeSparkline = (values: number[]): string => {
  const valid = values.filter((value) => Number.isFinite(value) && value >= -10);
  if (valid.length === 0) return '无数据';
  const sampled =
    valid.length <= 24
      ? valid
      : Array.from(
          { length: 24 },
          (_, index) => valid[Math.floor((index * (valid.length - 1)) / 23)]
        );
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const blocks = '▁▂▃▄▅▆▇█';
  if (max === min) return sampled.map(() => blocks[3]).join('');
  return sampled
    .map((value) => blocks[Math.round(((value - min) / (max - min)) * (blocks.length - 1))])
    .join('');
};

const calculatePeriodUsage = (values: number[]): number => {
  const valid = values.filter((value) => Number.isFinite(value) && value >= -10);
  let usage = 0;
  for (let index = 1; index < valid.length; index += 1) {
    usage += Math.max(valid[index - 1] - valid[index], 0);
  }
  return usage;
};

const sendReport = async (
  qqId: string,
  type: ReportType,
  start: Date,
  end: Date
): Promise<void> => {
  const periodKey = `${formatDate(start)}_${formatDate(end)}`;
  if (scheduler.hasReportDelivery(qqId, type, periodKey)) return;

  const records = db.getBillingHistoryForReport(qqId, start, end);
  const periodRecords = records.filter((record) => new Date(record.recorded_at) >= start);
  if (periodRecords.length === 0) {
    console.log(`[Report] No ${type} data for ${qqId} in ${periodKey}`);
    return;
  }

  const electricValues = records.map((record) => record.electric);
  const waterValues = records.map((record) => record.water);
  const electricUsage = calculatePeriodUsage(electricValues);
  const waterUsage = calculatePeriodUsage(waterValues);
  const latest = records.at(-1)!;
  const first = records[0];
  const endDisplay = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const reportName = type === 'weekly' ? '宿舍余额周报' : '宿舍余额月报';
  const periodName = type === 'weekly' ? '本周使用' : '本月使用';
  const chartData = records.map((record) => ({
    timestamp: record.recorded_at,
    electric: record.electric,
    water: record.water,
    ac: record.ac
  }));
  const chartPoints = chartData
    .map(({ timestamp, electric, water }) => ({ timestamp, electric, water }))
    .filter(
      ({ timestamp, electric, water }) =>
        !Number.isNaN(new Date(timestamp).getTime()) &&
        Number.isFinite(electric) &&
        Number.isFinite(water)
    );
  const uniqueChartTimestamps = new Set(
    chartPoints.map(({ timestamp }) => new Date(timestamp).getTime())
  );
  const hasEnoughChartData = uniqueChartTimestamps.size >= 2;
  const electricSparkline = makeSparkline(electricValues);
  const waterSparkline = makeSparkline(waterValues);
  let message = `宿舍: ${latest.room || ''}\n\n`;
  message += `📅 ${formatDate(start)} 至 ${formatDate(endDisplay)}\n\n`;
  message += `⚡ ${periodName}电费：${electricUsage.toFixed(2)} 元\n`;
  message += `💧 ${periodName}水费：${waterUsage.toFixed(2)} 元\n\n`;
  message += `⚡ 电费余额：${first.electric.toFixed(2)} → ${latest.electric.toFixed(2)} 元\n`;
  if (!hasEnoughChartData) message += `   ${electricSparkline}\n`;
  message += `💧 水费余额：${first.water.toFixed(2)} → ${latest.water.toFixed(2)} 元\n`;
  if (!hasEnoughChartData) message += `   ${waterSparkline}\n`;
  if (!hasEnoughChartData) {
    message += '\n📈 趋势图：历史数据不足，至少需要 2 个有效采样点。\n';
    console.warn(
      `[Report] Skipping ${type} chart for ${qqId}: only ${uniqueChartTimestamps.size} valid sample(s)`
    );
  }
  const periodLabel = type === 'weekly' ? '本周' : '本月';
  const reportMarkdown = [
    richRoom(latest.room || ''),
    `📅 **统计周期**\u3000\`${formatDate(start)}\` → \`${formatDate(endDisplay)}\``,
    '<hr>',
    `### ${periodLabel}用量`,
    `⚡ **电费**\u3000${richAmount(electricUsage, 'orange')}`,
    `💧 **水费**\u3000${richAmount(waterUsage, 'blue')}`,
    '<hr>',
    '### 余额变化',
    `⚡ **电费**\u3000\`${first.electric.toFixed(2)}\` → ${richAmount(latest.electric, 'orange')}`,
    ...(!hasEnoughChartData ? [`<font color='grey'>趋势\u3000${electricSparkline}</font>`] : []),
    `💧 **水费**\u3000\`${first.water.toFixed(2)}\` → ${richAmount(latest.water, 'blue')}`,
    ...(!hasEnoughChartData ? [`<font color='grey'>趋势\u3000${waterSparkline}</font>`] : []),
    ...(hasEnoughChartData
      ? []
      : ["<font color='grey'>📈 历史数据不足，至少需要 2 个有效采样点才能绘制折线图。</font>"])
  ].join('\n\n');
  const rules = scheduler.getNotificationsForUser(qqId);
  const channels = [
    ...new Map(
      rules
        .flatMap((rule) => scheduler.getChannelsForNotification(rule.id!, qqId))
        .map((channel) => [channel.id, channel] as const)
    ).values()
  ].filter((channel) => channel.type === 'feishu');
  let sent = false;
  for (const channel of channels) {
    try {
      await notificationService.send(channel, {
        title: `${reportName} · ${latest.room || ''}`,
        text: message,
        markdown: reportMarkdown,
        images: [],
        charts: hasEnoughChartData
          ? [
              {
                title: `${latest.room || ''} 电费与水费余额趋势`,
                points: chartPoints
              }
            ]
          : [],
        theme: type === 'weekly' ? 'green' : 'purple'
      });
      sent = true;
    } catch (error) {
      console.error(`[Report] Failed ${type} report through channel ${channel.id}:`, error);
    }
  }
  if (sent) {
    scheduler.recordReportDelivery(qqId, type, periodKey);
    console.log(`[Report] Sent ${type} report for ${qqId}: ${periodKey}`);
  }
};

const sendDueReports = async (now: Date): Promise<void> => {
  if (!isStandalone) return;
  const enabled = getEnabledStandaloneNotifications();
  const schedule = getStandaloneReportSchedule();
  const ownerId = `standalone:${config.standalone?.id || 'default'}`;

  if (
    enabled.includes('weeklyReport') &&
    now.getDay() === schedule.weekly.dayOfWeek &&
    now.getHours() === schedule.weekly.hour &&
    now.getMinutes() === schedule.weekly.minute
  ) {
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 7);
    await sendReport(ownerId, 'weekly', start, end);
  }

  if (
    enabled.includes('monthlyReport') &&
    now.getDate() === schedule.monthly.dayOfMonth &&
    now.getHours() === schedule.monthly.hour &&
    now.getMinutes() === schedule.monthly.minute
  ) {
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    await sendReport(ownerId, 'monthly', start, end);
  }
};

const runHourlyTasks = async () => {
  try {
    const now = new Date();
    const currentHour = now.getHours();

    // Get all students with their notification settings
    const allStudents = db.getAllStudents();

    if (allStudents.length === 0) {
      return;
    }

    await sendDueReports(now);

    const studentsToFetch: typeof allStudents = [];
    const standalone = config.standalone as typeof config.standalone & {
      fetchJitterMinutes?: number;
    };
    const standaloneOwnerId = `standalone:${standalone?.id || 'default'}`;

    // Daily notifications use the latest stored record and never trigger a website query.
    if (now.getMinutes() === 0) {
      for (const student of allStudents) {
        const latest = db.getLatestBilling(student.qq_id);
        if (!latest) continue;
        await sendNotificationForStudent(
          {
            qqId: student.qq_id,
            name: student.name,
            electric: latest.electric,
            water: latest.water,
            ac: latest.ac,
            room: latest.room || '',
            success: true
          },
          currentHour,
          'daily'
        );
      }
    }

    for (const student of allStudents) {
      let shouldFetch = false;
      const intervalHours = parseRelativeTime(student.fetch_interval || '1d');
      const isJitteredStandalone =
        isStandalone &&
        student.qq_id === standaloneOwnerId &&
        Number.isInteger(standalone.fetchJitterMinutes) &&
        (standalone.fetchJitterMinutes || 0) > 0;

      if (isJitteredStandalone) {
        const baseTime = new Date(student.last_login || student.created_at);
        const slot = getAlignedFetchSlot(
          now,
          baseTime,
          intervalHours,
          standalone.fetchJitterMinutes!,
          student.qq_id
        );
        if (slot && lastFetchAttemptBySlot.get(student.qq_id) !== slot.targetTime.getTime()) {
          shouldFetch = true;
          lastFetchAttemptBySlot.set(student.qq_id, slot.targetTime.getTime());
          console.log(
            `[Scheduler] Fetching for ${student.qq_id} in ${slot.nominalTime.getHours()}:00 slot ` +
              `(scheduled ${slot.targetTime.toLocaleString()})`
          );
        }
      } else if (now.getMinutes() === 0) {
        // Non-jittered accounts keep the original hourly scheduling behavior.
        const nextFetchTime = calculateNextFetchTime(
          student.last_login,
          student.created_at,
          intervalHours
        );

        if (now.getTime() >= nextFetchTime.getTime() - 5 * 60 * 1000) {
          shouldFetch = true;
          console.log(
            `[Scheduler] Fetching for ${student.qq_id} due to interval (Next: ${nextFetchTime.toLocaleString()}, Interval: ${student.fetch_interval})`
          );
        }
      }

      if (shouldFetch) {
        studentsToFetch.push(student);
      }
    }

    if (studentsToFetch.length === 0) {
      return;
    }

    // Phase 1: Collect data in parallel batches
    console.log(
      `[Scheduler] Phase 1: Collecting data for ${studentsToFetch.length} students (batch size: ${DATA_COLLECTION_BATCH_SIZE})...`
    );
    const collectedData = await collectData(studentsToFetch, DATA_COLLECTION_BATCH_SIZE);
    const successCount = collectedData.filter((d) => d.success).length;
    const failureCount = collectedData.length - successCount;
    console.log(
      `[Scheduler] Data collection complete: ${successCount} succeeded, ${failureCount} failed`
    );

    // Phase 2: Send notifications serially
    console.log('[Scheduler] Phase 2: Checking low-balance thresholds...');
    for (const data of collectedData) {
      await sendNotificationForStudent(data, currentHour, 'threshold');
    }

    console.log('[Scheduler] Scheduled tasks completed');
  } catch (error) {
    console.error('[Scheduler] Error during scheduled tasks:', error);
  }
};

const startHourlyTimer = () => {
  // Clear any existing timers to prevent duplicates on reconnection
  stopHourlyTimer();

  // Calculate delay until the next minute boundary.
  const now = new Date();
  const seconds = now.getSeconds();
  const milliseconds = now.getMilliseconds();
  const delayUntilNextMinute = (60 - seconds) * 1000 - milliseconds;

  console.log('[Scheduler] Minute scheduler enabled');

  hourlyTimeout = setTimeout(() => {
    void runHourlyTasks();

    hourlyInterval = setInterval(() => void runHourlyTasks(), 60 * 1000);
    hourlyTimeout = null;
  }, delayUntilNextMinute);
};

const stopHourlyTimer = () => {
  if (hourlyTimeout) {
    clearTimeout(hourlyTimeout);
    hourlyTimeout = null;
    console.log('[Scheduler] Pending timer cleared');
  }
  if (hourlyInterval) {
    clearInterval(hourlyInterval);
    hourlyInterval = null;
    console.log('[Scheduler] Timer stopped');
  }
};

// Shared command handlers
const handleNotifyCommand = async (
  command: string,
  params: string[],
  qqId: string,
  chatType: 'private' | 'group',
  chatId: string,
  sendFn: (message: string) => Promise<void>
) => {
  if (params.length < 1 || params.length > 4) {
    await sendFn(
      `查询定时通知：${command} notify list\n` +
        `设置定时通知：${command} notify <小时 (0-23)> [阈值] [通知项目] [channels=渠道ID,...]`
    );
    return;
  }

  if (params[0].toLowerCase() === 'list') {
    const notifications = scheduler.getNotificationsForUser(qqId);
    if (notifications.length === 0) {
      await sendFn('您还未设置定时通知。');
      return;
    }

    notifications.sort((a, b) => a.hour - b.hour);

    let message = '目前设置的定时通知：';
    for (const notification of notifications) {
      message += `\n- ${notification.hour.toString().padStart(2, '0')}:00 ${
        notification.chat_type === 'private'
          ? '私聊'
          : await napcat
              .get_group_info({
                group_id: parseInt(notification.chat_id)
              })
              .then((info) => info.group_name)
      }`;
      if (notification.threshold !== null && notification.threshold !== undefined) {
        message += ` [${notification.threshold} 元]`;
      }
      if (notification.lines && notification.lines !== 'ewa') {
        message += ` [${notification.lines.toUpperCase()}]`;
      }
      const channelNames = notification.id
        ? scheduler
            .getChannelsForNotification(notification.id, qqId)
            .filter((channel) => channel.type === 'qq')
            .map((channel) => channel.name)
        : [];
      message += ` → ${channelNames.join('、') || '未选择渠道'}`;
    }
    await sendFn(message);
    return;
  }

  const hour = parseInt(params[0]);
  if (isNaN(hour) || hour < 0 || hour > 23) {
    await sendFn('小时必须是 0 到 23 之间的数字。');
    return;
  }

  let threshold: number | undefined;
  let lines = 'ewa';
  let channelIds: number[] | undefined;

  for (let i = 1; i < params.length; i++) {
    const param = params[i];
    if (param.toLowerCase().startsWith('channels=')) {
      channelIds = param
        .slice('channels='.length)
        .split(',')
        .map((id) => Number(id));
      if (channelIds.length === 0 || channelIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        await sendFn('渠道格式错误。示例：channels=1,2');
        return;
      }
    } else if (/^[ewaEWA]+$/.test(param)) {
      lines = param;
    } else {
      const val = parseFloat(param);
      if (!isNaN(val) && val >= 0) {
        threshold = val;
      } else {
        await sendFn('参数格式错误。阈值必须是非负数字，通知项目由 e/w/a 组成。');
        return;
      }
    }
  }

  // Check if user has credentials
  const credentials = db.getCredentials(qqId);
  if (!credentials) {
    await sendFn(
      `您还未绑定账号。请私聊发送：${command} bind <卡号> <卡片密码> <校区 (GZIC 或 DXC)> [更新间隔]`
    );
    return;
  }

  const selectedChannels = channelIds ?? [scheduler.ensureQQChannel(qqId, chatType, chatId).id];
  if (selectedChannels.some((id) => scheduler.getChannel(id, qqId)?.type !== 'qq')) {
    await sendFn('提供服务模式仅支持 QQ 通知渠道，请先执行 channel list。');
    return;
  }

  // Set notification
  const notification = scheduler.setNotification(chatType, chatId, qqId, hour, threshold, lines);
  scheduler.setNotificationChannels(notification.id!, qqId, selectedChannels);

  let message = `已设置每日 ${hour} 时在此${chatType === 'private' ? '私聊' : '群聊'}`;
  if (threshold !== undefined) {
    message += `当任一余额（${lines.toUpperCase()}）低于 ${threshold} 元时`;
  }
  const channelNames = selectedChannels
    .map((id) => scheduler.getChannel(id, qqId)?.name)
    .filter(Boolean)
    .join('、');
  message += `通过 ${channelNames} 发送账单报告。`;

  await sendFn(message);
  console.log(
    `[Notify] Set notification for ${chatType} ${chatId}, QQ ${qqId}, hour ${hour}, threshold ${threshold ?? 'none'}, lines ${lines}`
  );
};

const handleChannelCommand = async (
  params: string[],
  qqId: string,
  sendFn: (message: string) => Promise<void>
) => {
  const action = params[0]?.toLowerCase();
  if (!action || action === 'list') {
    const channels = scheduler.getChannelsForUser(qqId).filter((channel) => channel.type === 'qq');
    if (channels.length === 0) {
      await sendFn('暂无通知渠道。设置一次 QQ 通知后会自动创建 QQ 渠道。');
      return;
    }
    await sendFn(
      '通知渠道：\n' +
        channels
          .map(
            (channel) =>
              `- ${channel.id}: ${channel.name} [${channel.type}]${channel.enabled ? '' : '（停用）'}`
          )
          .join('\n')
    );
    return;
  }

  if (action === 'add') {
    await sendFn('提供服务模式仅支持 QQ 通知渠道；设置通知时会自动创建对应渠道。');
    return;
  }

  const id = Number(params[1]);
  if (!Number.isInteger(id) || id <= 0) {
    await sendFn('用法：channel test <QQ渠道ID>');
    return;
  }
  if (action === 'test') {
    const channel = scheduler.getChannel(id, qqId);
    if (!channel || channel.type !== 'qq') {
      await sendFn('QQ 渠道不存在。');
      return;
    }
    try {
      await notificationService.send(channel, {
        title: 'SCUT Notipay 渠道测试',
        text: '通知渠道配置成功。',
        markdown: '通知渠道配置成功。',
        images: []
      });
      await sendFn('测试消息发送成功。');
    } catch (error) {
      await sendFn(`测试失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  await sendFn('用法：channel list | test <QQ渠道ID>');
};

const handleUnnotifyCommand = async (
  qqId: string,
  chatType: 'private' | 'group',
  chatId: string,
  sendFn: (message: string) => Promise<void>
) => {
  const deleted = scheduler.deleteNotification(chatType, chatId, qqId);
  if (deleted) {
    await sendFn('已取消定时通知。');
  } else {
    await sendFn('您还未设置定时通知。');
  }
};

const handleIntervalCommand = async (
  command: string,
  params: string[],
  qqId: string,
  sendFn: (message: string) => Promise<void>
) => {
  // Check if user has credentials
  const credentials = db.getCredentials(qqId);
  if (!credentials) {
    await sendFn(
      `您还未绑定账号。请私聊发送：${command} bind <卡号> <卡片密码> <校区 (GZIC 或 DXC)> [更新间隔]`
    );
    return;
  }

  if (params.length === 0) {
    // Get
    const student = db.getStudent(qqId);
    if (student) {
      let message = `当前自动更新间隔：${student.fetch_interval || '1d'}`;
      try {
        const hours = parseRelativeTime(student.fetch_interval || '1d');
        let nextFetch = calculateNextFetchTime(student.last_login, student.created_at, hours);
        const now = new Date();

        // If the calculated next fetch time is in the past, the scheduler will pick it up at the next hour
        if (nextFetch < now) {
          nextFetch = new Date(now);
          if (nextFetch.getMinutes() > 0 || nextFetch.getSeconds() > 0) {
            nextFetch.setHours(nextFetch.getHours() + 1);
          }
          nextFetch.setMinutes(0, 0, 0);
        }

        const timeStr = `${nextFetch.getMonth() + 1}月${nextFetch.getDate()}日 ${nextFetch.getHours()}:00`;
        message += `\n下次自动更新将在 ${timeStr} 进行。`;
      } catch {
        // Ignore error
      }
      await sendFn(message);
    }
    return;
  }

  if (params.length === 1) {
    // Set
    const intervalStr = params[0];
    try {
      const hours = parseRelativeTime(intervalStr);
      if (hours < 1) {
        await sendFn('间隔时间不能小于 1 小时。');
        return;
      }

      db.updateFetchInterval(qqId, intervalStr);

      let message = `已设置自动更新间隔为：${intervalStr}（${hours} 小时）。`;

      // Calculate next fetch time
      const student = db.getStudent(qqId);
      if (student) {
        let nextFetch = calculateNextFetchTime(student.last_login, student.created_at, hours);
        const now = new Date();

        // If the calculated next fetch time is in the past, the scheduler will pick it up at the next hour
        if (nextFetch < now) {
          nextFetch = new Date(now);
          if (nextFetch.getMinutes() > 0 || nextFetch.getSeconds() > 0) {
            nextFetch.setHours(nextFetch.getHours() + 1);
          }
          nextFetch.setMinutes(0, 0, 0);
        }

        const timeStr = `${nextFetch.getMonth() + 1}月${nextFetch.getDate()}日 ${nextFetch.getHours()}:00`;
        message += `\n下次自动更新将在 ${timeStr} 进行。`;
      }

      await sendFn(message);
    } catch {
      await sendFn('时间格式不正确。示例：1d, 12h');
    }
    return;
  }

  await sendFn(`用法：${command} interval [时间间隔]`);
};

const handleHelp = async (
  command: string,
  sendFn: (message: string | SendMessageSegment[]) => Promise<void>
) => {
  const message =
    `[${APP_NAME}] 可用命令：\n\n` +
    '1. 绑定账号（仅限私聊）：\n' +
    `${command} bind <卡号> <卡片密码> <校区 (GZIC 或 DXC)> [更新间隔]\n` +
    `   例：${command} bind 123456 123456 GZIC 1d\n` +
    '   更新间隔默认为 1d（1 天），支持 h（小时）、d（天）、w（周）。\n\n' +
    '2. 解绑账号：\n' +
    `${command} unbind\n\n` +
    '3. 查询当前账单：\n' +
    `${command} query [起始时间] [结束时间] [显示项目]\n` +
    '   或\n' +
    `${command} bills [起始时间] [结束时间] [显示项目]\n` +
    '   时间格式支持：\n' +
    '   - 相对时间：7h（7 小时前），3d（3 天前），2w（2 周前）\n' +
    '   - 绝对时间：1030（10 月 30 日 0:00），10302330（10 月 30 日 23:30）\n' +
    '   - 带分隔符：10-30|23:30，10/30|23:30，10/30/23:30\n' +
    '   显示项目（可选）：\n' +
    '   - e：电费，w：水费，a：空调费\n' +
    '   - 组合使用：ew（电费+水费），ewa（全部；默认）\n' +
    `   例：${command} query 7d（显示最近 7 天；默认）\n` +
    `   例：${command} query 1025 1030 e（显示 10 月 25 日至 30 日的电费）\n\n` +
    '4. 查询定时通知：\n' +
    `${command} notify list\n\n` +
    '5. 设置定时通知：\n' +
    `${command} notify <小时 (0-23)> [阈值] [通知项目]\n` +
    `   例：${command} notify 20 10\n` +
    '   每天晚上 8 点当任一余额低于 10 元时发送账单报告。\n' +
    `   例：${command} notify 20 10 e\n` +
    '   每天晚上 8 点当电费低于 10 元时发送账单报告（仅包含电费图表）。\n\n' +
    '6. 取消定时通知：\n' +
    `${command} unnotify\n\n` +
    '7. 查看或测试 QQ 通知渠道：\n' +
    `${command} channel list\n` +
    `${command} channel test <QQ渠道ID>\n\n` +
    '8. 设置更新间隔：\n' +
    `${command} interval [时间间隔]\n` +
    `   例：${command} interval 12h\n\n` +
    '尖括号 <> 表示必填参数，中括号 [] 表示可选参数。\n' +
    '如有其他疑问，请联系管理员。\n' +
    `当前 commit：${commitHash}\n` +
    `GitHub 仓库：${GITHUB_LINK}`;
  await sendFn([{ type: 'node', data: { content: [{ type: 'text', data: { text: message } }] } }]);
};

napcat.on('message', async (context: AllHandlers['message']) => {
  const isPrivateChat = context.message_type === 'private';
  const send = async (message: string | SendMessageSegment[]) => {
    await (isPrivateChat
      ? napcat.send_private_msg({
          user_id: context.sender.user_id,
          message:
            typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message
        })
      : napcat.send_group_msg({
          group_id: context.group_id,
          message:
            typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message
        }));
  };

  try {
    const { command, args } = parseMessage(context);
    if (!command) return;
    if (!args || args.length === 0) {
      await handleHelp(command, send);
      return;
    }
    const [rawSubcommand, ...params] = args;
    const subcommand = rawSubcommand.toLowerCase();
    const qqId = context.sender.user_id.toString();
    const chatId = (isPrivateChat ? context.sender.user_id : context.group_id).toString();

    if (subcommand === 'bind' && isPrivateChat) {
      if (params.length < 3 || params.length > 4) {
        await send(
          `用法：${command} ${subcommand} <卡号> <卡片密码> <校区(GZIC 或 DXC)> [更新间隔]`
        );
        return;
      }
      const [cardId, password, campus, intervalParam] = params;
      if (CAMPUSES.includes(campus.toUpperCase() as Campus) === false) {
        await send('校区必须是 GZIC 或 DXC。');
        return;
      }

      let fetchInterval = '1d';
      if (intervalParam) {
        try {
          const hours = parseRelativeTime(intervalParam);
          if (hours < 1) {
            await send('更新间隔不能小于 1 小时。');
            return;
          }
          fetchInterval = intervalParam;
        } catch {
          await send('更新间隔格式不正确。示例：1d, 12h');
          return;
        }
      }

      console.log(`[Bind] QQ: ${qqId}, Card ID: ${cardId}`);
      const result = await login(cardId, password);
      if (result === null) {
        await send('登录失败，请检查卡号和密码是否正确。');
        return;
      }
      db.addStudent(
        qqId,
        cardId,
        campus.toUpperCase() as Campus,
        password,
        result.name,
        result.sno,
        fetchInterval
      );
      // Store the access token from login
      db.updateTokens(qqId, result.access_token, result.TGC, result.locSession, result.expires_in);
      console.log(`[DB] Stored credentials and token for ${result.name} (${result.sno})`);

      let message = `成功绑定到 ${result.name}（学号：${result.sno}）。`;

      // Calculate first fetch time
      try {
        const hours = parseRelativeTime(fetchInterval);
        const firstFetch = new Date(Date.now() + hours * 60 * 60 * 1000);
        // Round to next hour to match scheduler behavior
        if (firstFetch.getMinutes() > 0 || firstFetch.getSeconds() > 0) {
          firstFetch.setHours(firstFetch.getHours() + 1);
          firstFetch.setMinutes(0, 0, 0);
        }

        const timeStr = `${firstFetch.getMonth() + 1}月${firstFetch.getDate()}日 ${firstFetch.getHours()}:00`;
        message += `\n首次自动更新将在 ${timeStr} 进行（间隔：${fetchInterval}）。`;
      } catch {
        // Ignore error in message generation
      }

      await send(message);
    } else if (subcommand === 'unbind') {
      // Clear token before deleting (though CASCADE will handle this)
      db.clearAccessToken(qqId);
      const deleted = db.deleteStudent(qqId);
      if (deleted) {
        await send('已解除绑定。');
      } else {
        await send('您还未绑定账号。');
      }
    } else if (subcommand === 'query' || subcommand === 'bills') {
      const credentials = db.getCredentials(qqId);
      if (!credentials) {
        await send(
          `您还未绑定账号。请私聊发送：${command} bind <卡号> <卡片密码> <校区(GZIC 或 DXC)> [更新间隔]`
        );
        return;
      }

      // Parse parameters
      let startTime: Date | null = null;
      let endTime: Date | null = null;
      let lines = 'ewa'; // Default to showing all

      const timeParams: string[] = [];
      for (const param of params) {
        // Check if param is a line filter (only contains e, w, a, case-insensitive)
        if (/^[ewaEWA]+$/.test(param)) {
          lines = param;
        } else {
          timeParams.push(param);
        }
      }

      try {
        if (timeParams.length >= 1) {
          startTime = parseTimeParameter(timeParams[0]);
        }
        if (timeParams.length >= 2) {
          endTime = parseTimeParameter(timeParams[1]);
        }

        // Validation
        if (startTime && endTime && startTime >= endTime) {
          await send('错误：起始时间必须早于结束时间。');
          return;
        }
      } catch (error) {
        await send(`时间参数格式错误：${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      // Get bills with automatic token management
      const { electric, ac, water, room } = await getBillsWithTokenRefresh(qqId);
      db.updateLastLogin(qqId);

      // Get 24h change
      const change24h = db.getBilling24HourChange(qqId);

      // Get history for chart with custom time range
      let history;
      if (startTime || endTime) {
        history = db.getBillingHistoryByTimeRange(qqId, startTime, endTime);
      } else {
        // Default: last 7 days
        history = db.getBillingHistory(qqId, 7);
      }

      // Generate summary
      let messageText = `🏠 ${room}\n\n`;
      messageText += generateBillingSummary({ electric, water, ac }, change24h || undefined);

      // Build message segments
      const messageSegments: SendMessageSegment[] = [{ type: 'text', data: { text: messageText } }];

      // Add chart images if we have enough data
      if (history.length >= 2) {
        const chartData = history
          .reverse()
          .map(
            (h: {
              id: number;
              qq_id: string;
              electric: number;
              water: number;
              ac: number;
              room: string | null;
              recorded_at: string;
            }) => ({
              timestamp: h.recorded_at,
              electric: h.electric,
              water: h.water,
              ac: h.ac
            })
          );

        const charts = await generateBillingCharts(chartData, room, lines);
        for (const chart of charts) {
          const base64Image = `base64://${chart.buffer.toString('base64')}`;
          messageSegments.push({ type: 'image', data: { file: base64Image } });
        }
      } else {
        messageSegments[0].data.text += '\n💡 需要至少 2 条历史记录才能显示趋势图';
      }

      await send(messageSegments);
    } else if (subcommand === 'notify') {
      await handleNotifyCommand(command, params, qqId, context.message_type, chatId, send);
    } else if (subcommand === 'unnotify') {
      await handleUnnotifyCommand(qqId, context.message_type, chatId, send);
    } else if (subcommand === 'channel') {
      await handleChannelCommand(params, qqId, send);
    } else if (subcommand === 'interval') {
      await handleIntervalCommand(command, params, qqId, send);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await send('操作失败，请稍后重试。').catch();
  }
});

if (isStandalone) {
  configureStandaloneMode();
  startHourlyTimer();
  void runHourlyTasks();
  console.log('[Standalone] 已启动，无需连接 NapCat。');
} else {
  await napcat.connect();
}

let shutdownInitiated = false;
const shutdown = async () => {
  if (shutdownInitiated) {
    console.log('\nForce exiting...');
    process.exit(1);
  }
  shutdownInitiated = true;
  console.log('\nGracefully shutting down...');

  stopHourlyTimer();

  if (!isStandalone) {
    napcat.disconnect();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([socketClose.promise, timeout]);
  }

  db.close();
  console.log('[SQLite] Database closed.');

  console.log('Process exited.');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
