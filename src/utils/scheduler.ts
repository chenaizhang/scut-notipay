import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { encryptionService } from './encryption.js';
import type {
  NotificationChannel,
  NotificationChannelConfig,
  NotificationChannelType,
  QQChannelConfig,
  StoredNotificationChannel
} from '../notifications/types.js';

export interface Notification {
  id?: number;
  chat_type: 'private' | 'group';
  chat_id: string;
  qq_id: string;
  hour: number;
  threshold?: number | null;
  electric_threshold?: number | null;
  water_threshold?: number | null;
  ac_threshold?: number | null;
  electric_alerted?: number;
  water_alerted?: number;
  ac_alerted?: number;
  last_sent?: string | null;
  lines?: string;
  created_at?: string;
  updated_at?: string;
}

export interface NotificationThresholds {
  electric?: number | null;
  water?: number | null;
  ac?: number | null;
}

class NotificationScheduler {
  private db: Database.Database;
  private masterPassword: string;

  constructor(database: Database.Database, masterPassword: string) {
    this.db = database;
    this.masterPassword = masterPassword;
    this.migrateLegacyNotificationChannels();
  }

  private destinationKey(type: NotificationChannelType, config: NotificationChannelConfig): string {
    const raw =
      type === 'qq'
        ? `${(config as QQChannelConfig).chatType}:${(config as QQChannelConfig).chatId}`
        : (config as { webhookUrl: string }).webhookUrl;
    return createHash('sha256').update(raw).digest('hex');
  }

  private decodeChannel(row: StoredNotificationChannel): NotificationChannel {
    return {
      id: row.id,
      qq_id: row.qq_id,
      type: row.type,
      name: row.name,
      config: JSON.parse(
        encryptionService.decrypt(row.config_encrypted, this.masterPassword)
      ) as NotificationChannelConfig,
      enabled: row.enabled === 1,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private migrateLegacyNotificationChannels(): void {
    const rows = this.db
      .prepare(
        `
      SELECT n.id, n.chat_type, n.chat_id, n.qq_id FROM notifications n
      JOIN students s ON s.qq_id = n.qq_id
      WHERE n.id NOT IN (SELECT notification_id FROM notification_rule_channels)
    `
      )
      .all() as Array<{
      id: number;
      chat_type: 'private' | 'group';
      chat_id: string;
      qq_id: string;
    }>;

    const migrate = this.db.transaction(() => {
      for (const row of rows) {
        const channel = this.ensureQQChannel(row.qq_id, row.chat_type, row.chat_id);
        this.setNotificationChannels(row.id, row.qq_id, [channel.id]);
      }
    });
    migrate();
  }

  upsertChannel(
    qqId: string,
    type: Exclude<NotificationChannelType, 'qq'>,
    name: string,
    config: NotificationChannelConfig
  ): NotificationChannel {
    const encrypted = encryptionService.encrypt(JSON.stringify(config), this.masterPassword);
    const destinationKey = this.destinationKey(type, config);
    const channelId = this.db.transaction(() => {
      const byName = this.db
        .prepare('SELECT id FROM notification_channels WHERE qq_id = ? AND name = ?')
        .get(qqId, name) as { id: number } | undefined;
      const byDestination = this.db
        .prepare(
          `SELECT id FROM notification_channels
           WHERE qq_id = ? AND type = ? AND destination_key = ?`
        )
        .get(qqId, type, destinationKey) as { id: number } | undefined;

      if (byName && byDestination && byName.id !== byDestination.id) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO notification_rule_channels (notification_id, channel_id)
             SELECT notification_id, ? FROM notification_rule_channels WHERE channel_id = ?`
          )
          .run(byName.id, byDestination.id);
        this.db.prepare('DELETE FROM notification_channels WHERE id = ?').run(byDestination.id);
      }

      const existingId = byName?.id ?? byDestination?.id;
      if (existingId !== undefined) {
        this.db
          .prepare(
            `UPDATE notification_channels SET
               type = ?, name = ?, destination_key = ?, config_encrypted = ?,
               enabled = 1, updated_at = datetime('now', 'localtime')
             WHERE id = ?`
          )
          .run(type, name, destinationKey, encrypted, existingId);
        return existingId;
      }

      return Number(
        this.db
          .prepare(
            `INSERT INTO notification_channels
               (qq_id, type, name, destination_key, config_encrypted)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(qqId, type, name, destinationKey, encrypted).lastInsertRowid
      );
    })();
    const row = this.db
      .prepare('SELECT * FROM notification_channels WHERE id = ?')
      .get(channelId) as StoredNotificationChannel;
    return this.decodeChannel(row);
  }

  ensureQQChannel(
    qqId: string,
    chatType: 'private' | 'group',
    chatId: string
  ): NotificationChannel {
    const config = { chatType, chatId } as const;
    const key = this.destinationKey('qq', config);
    const existing = this.db
      .prepare(
        `
      SELECT * FROM notification_channels WHERE qq_id = ? AND type = 'qq' AND destination_key = ?
    `
      )
      .get(qqId, key) as StoredNotificationChannel | undefined;
    if (existing) return this.decodeChannel(existing);

    const baseName = chatType === 'private' ? 'QQ私聊' : `QQ群${chatId}`;
    let name = baseName;
    let suffix = 2;
    while (
      this.db
        .prepare('SELECT 1 FROM notification_channels WHERE qq_id = ? AND name = ?')
        .get(qqId, name)
    ) {
      name = `${baseName}-${suffix++}`;
    }
    const encrypted = encryptionService.encrypt(JSON.stringify(config), this.masterPassword);
    const result = this.db
      .prepare(
        `
      INSERT INTO notification_channels (qq_id, type, name, destination_key, config_encrypted)
      VALUES (?, 'qq', ?, ?, ?)
    `
      )
      .run(qqId, name, key, encrypted);
    return this.getChannel(Number(result.lastInsertRowid), qqId)!;
  }

  getChannel(id: number, qqId: string): NotificationChannel | null {
    const row = this.db
      .prepare('SELECT * FROM notification_channels WHERE id = ? AND qq_id = ?')
      .get(id, qqId) as StoredNotificationChannel | undefined;
    return row ? this.decodeChannel(row) : null;
  }

  getChannelsForUser(qqId: string): NotificationChannel[] {
    const rows = this.db
      .prepare('SELECT * FROM notification_channels WHERE qq_id = ? ORDER BY id')
      .all(qqId) as StoredNotificationChannel[];
    return rows.map((row) => this.decodeChannel(row));
  }

  getChannelsForNotification(notificationId: number, qqId: string): NotificationChannel[] {
    const rows = this.db
      .prepare(
        `
      SELECT c.* FROM notification_channels c
      JOIN notification_rule_channels rc ON rc.channel_id = c.id
      WHERE rc.notification_id = ? AND c.qq_id = ? AND c.enabled = 1
      ORDER BY c.id
    `
      )
      .all(notificationId, qqId) as StoredNotificationChannel[];
    return rows.map((row) => this.decodeChannel(row));
  }

  setNotificationChannels(notificationId: number, qqId: string, channelIds: number[]): void {
    if (channelIds.length === 0) throw new Error('至少选择一个通知渠道');
    const placeholders = channelIds.map(() => '?').join(',');
    const count = this.db
      .prepare(
        `
      SELECT COUNT(*) AS count FROM notification_channels
      WHERE qq_id = ? AND enabled = 1 AND id IN (${placeholders})
    `
      )
      .get(qqId, ...channelIds) as { count: number };
    if (count.count !== new Set(channelIds).size) {
      throw new Error('包含无效或不属于您的通知渠道');
    }

    const replace = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM notification_rule_channels WHERE notification_id = ?')
        .run(notificationId);
      const insert = this.db.prepare(
        'INSERT INTO notification_rule_channels (notification_id, channel_id) VALUES (?, ?)'
      );
      for (const channelId of new Set(channelIds)) insert.run(notificationId, channelId);
    });
    replace();
  }

  /**
   * Add or update a notification schedule
   */
  setNotification(
    chatType: 'private' | 'group',
    chatId: string,
    qqId: string,
    hour: number,
    threshold?: number,
    lines: string = 'ewa',
    thresholds?: NotificationThresholds
  ): Notification {
    if (hour < 0 || hour > 23) {
      throw new Error('Hour must be between 0 and 23');
    }

    if (threshold !== undefined && threshold < 0) {
      throw new Error('Threshold must be a positive number');
    }

    for (const value of Object.values(thresholds || {})) {
      if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new Error('Each notification threshold must be a non-negative number or null');
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO notifications (
        chat_type, chat_id, qq_id, hour, threshold, lines,
        electric_threshold, water_threshold, ac_threshold
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_type, chat_id, qq_id) DO UPDATE SET
        hour = excluded.hour,
        threshold = excluded.threshold,
        lines = excluded.lines,
        electric_alerted = CASE
          WHEN notifications.electric_threshold IS excluded.electric_threshold
          THEN notifications.electric_alerted ELSE 0 END,
        water_alerted = CASE
          WHEN notifications.water_threshold IS excluded.water_threshold
          THEN notifications.water_alerted ELSE 0 END,
        ac_alerted = CASE
          WHEN notifications.ac_threshold IS excluded.ac_threshold
          THEN notifications.ac_alerted ELSE 0 END,
        electric_threshold = excluded.electric_threshold,
        water_threshold = excluded.water_threshold,
        ac_threshold = excluded.ac_threshold,
        updated_at = datetime('now', 'localtime')
    `);

    stmt.run(
      chatType,
      chatId,
      qqId,
      hour,
      threshold ?? null,
      lines,
      thresholds?.electric ?? null,
      thresholds?.water ?? null,
      thresholds?.ac ?? null
    );

    const notification = this.getNotification(chatType, chatId, qqId);
    if (!notification) {
      throw new Error('Failed to set notification');
    }
    return notification;
  }

  /**
   * Get notification for a specific chat and user
   */
  getNotification(
    chatType: 'private' | 'group',
    chatId: string,
    qqId: string
  ): Notification | null {
    const stmt = this.db.prepare(`
      SELECT * FROM notifications
      WHERE chat_type = ? AND chat_id = ? AND qq_id = ?
    `);

    return stmt.get(chatType, chatId, qqId) as Notification | null;
  }

  /**
   * Get all notifications for a specific chat
   */
  getChatNotifications(chatType: 'private' | 'group', chatId: string): Notification[] {
    const stmt = this.db.prepare(`
      SELECT * FROM notifications
      WHERE chat_type = ? AND chat_id = ?
    `);

    return stmt.all(chatType, chatId) as Notification[];
  }

  /**
   * Get all notifications for a specific user by QQ ID
   */
  getNotificationsForUser(qqId: string): Notification[] {
    const stmt = this.db.prepare(`
      SELECT * FROM notifications
      WHERE qq_id = ?
    `);

    return stmt.all(qqId) as Notification[];
  }

  /**
   * Get notifications for a specific user by QQ ID
   */
  getNotificationsAtHourForUser(qqId: string, hour: number): Notification[] {
    const stmt = this.db.prepare(`
      SELECT * FROM notifications
      WHERE qq_id = ? AND hour = ?
    `);

    return stmt.all(qqId, hour) as Notification[];
  }

  /**
   * Delete a notification
   */
  deleteNotification(chatType: 'private' | 'group', chatId: string, qqId: string): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM notifications
      WHERE chat_type = ? AND chat_id = ? AND qq_id = ?
    `);

    const result = stmt.run(chatType, chatId, qqId);
    return result.changes > 0;
  }

  /**
   * Update last sent timestamp
   */
  updateLastSent(id: number): void {
    const stmt = this.db.prepare(`
      UPDATE notifications
      SET last_sent = datetime('now', 'localtime')
      WHERE id = ?
    `);

    stmt.run(id);
  }

  updateThresholdAlertState(
    id: number,
    state: { electric: boolean; water: boolean; ac: boolean }
  ): void {
    this.db
      .prepare(
        `
      UPDATE notifications
      SET electric_alerted = ?, water_alerted = ?, ac_alerted = ?,
          updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `
      )
      .run(state.electric ? 1 : 0, state.water ? 1 : 0, state.ac ? 1 : 0, id);
  }

  hasReportDelivery(qqId: string, type: 'weekly' | 'monthly', periodKey: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `
        SELECT 1 FROM report_deliveries
        WHERE qq_id = ? AND report_type = ? AND period_key = ?
      `
        )
        .get(qqId, type, periodKey)
    );
  }

  recordReportDelivery(qqId: string, type: 'weekly' | 'monthly', periodKey: string): void {
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO report_deliveries (qq_id, report_type, period_key)
      VALUES (?, ?, ?)
    `
      )
      .run(qqId, type, periodKey);
  }

  /**
   * Get notifications that should be sent now
   */
  getAllNotifications(): Notification[] {
    const stmt = this.db.prepare('SELECT * FROM notifications');
    return stmt.all() as Notification[];
  }

  /**
   * Get notification count
   */
  getNotificationCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM notifications');
    const result = stmt.get() as { count: number };
    return result.count;
  }
}

// Export class for testing
export { NotificationScheduler };
