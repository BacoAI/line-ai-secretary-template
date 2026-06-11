/**
 * 資料庫 Schema — Cloudflare D1 (SQLite)
 *
 * 設計原則:
 * - 支援 3 種 Notion 模式(internal / notion-new / notion-existing)
 * - 預留欄位給付費版升級時使用(不需要再 migration)
 * - 所有 timestamp 用 ISO 8601 字串(SQLite 沒有原生 datetime)
 *
 * 表結構:
 * - users: 使用者(個人 bot 通常只有 1 個)
 * - tasks: 任務(模式 A 全部存這,模式 B/C 是 Notion 的 cache/同步狀態)
 * - conversations: LINE 對話歷史(用於 AI 上下文)
 * - memory: AI 對使用者的記憶與觀察
 * - preferences: 使用者偏好設定(推播時間、語氣等)
 * - cost_log: API 用量與成本追蹤(燒錢防護用)
 * - schedule_log: 排程動作歷史(debug、迴圈偵測用)
 * - escalation_state: 提醒升級狀態(追蹤目前升到第幾級)
 * - rich_menu_config: Rich Menu 客製化設定
 * - notion_field_mapping: 模式 C 用,既有 Notion DB 的欄位對應
 */

import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ============================================================
// users — 使用者
// ============================================================
export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // LINE user ID
  displayName: text('display_name'),
  language: text('language').default('zh-TW'),
  timezone: text('timezone').default('Asia/Taipei'),
  phoneNumber: text('phone_number'), // 用於電話介入
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ============================================================
// tasks — 任務
// ============================================================
// 模式 A (internal): 完整資料存這
// 模式 B (notion-new): 同步 Notion 的鏡像
// 模式 C (notion-existing): 同步既有 Notion DB 的鏡像
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(), // UUID
  userId: text('user_id').notNull().references(() => users.id),

  // 核心欄位
  title: text('title').notNull(),
  status: text('status', {
    enum: ['not_started', 'in_progress', 'completed', 'interrupted', 'postponed', 'cancelled'],
  }).default('not_started').notNull(),
  priority: text('priority', {
    enum: ['p0_urgent', 'p1_important', 'p2_normal', 'p3_whenever'],
  }).default('p2_normal'),

  // 時間區段
  startTime: text('start_time'),         // ISO 8601, 可空(無時間概念的雜事)
  endTime: text('end_time'),             // 配對用
  estimatedDurationMin: integer('estimated_duration_min'),
  originalStartTime: text('original_start_time'), // 第一次安排,看出拖了多久

  // 分類
  type: text('type', {
    enum: ['deep_work', 'meeting', 'errand', 'learning', 'rest'],
  }),
  energyRequired: text('energy_required', {
    enum: ['high', 'medium', 'low'],
  }),
  project: text('project'),

  // 拖延追蹤
  postponeCount: integer('postpone_count').default(0),
  lastPostponedAt: text('last_postponed_at'),

  // 備註與 AI 觀察
  notes: text('notes'),
  aiObservation: text('ai_observation'),

  // 來源
  source: text('source', {
    enum: ['user_chat', 'journal_extracted', 'manual_notion', 'client_request', 'recurring'],
  }).default('user_chat'),

  // Notion 連結(模式 B/C 用)
  notionPageId: text('notion_page_id'),
  notionLastSyncAt: text('notion_last_sync_at'),

  // 預留給付費版的 extra 欄位(JSON 字串)
  extra: text('extra'), // JSON: { customField1, customField2, ... }

  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  statusIdx: index('idx_tasks_status').on(table.status),
  startTimeIdx: index('idx_tasks_start_time').on(table.startTime),
  userIdIdx: index('idx_tasks_user_id').on(table.userId),
}));

// ============================================================
// conversations — LINE 對話歷史
// ============================================================
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),

  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(),

  // 觸發來源
  trigger: text('trigger', {
    enum: ['line_message', 'scheduled', 'follow_up', 'phone_call'],
  }).notNull(),

  // AI 處理 metadata
  modelUsed: text('model_used'), // claude-haiku-4-5 / claude-sonnet-4-6 / claude-opus-4-7
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: real('cost_usd'),

  // 關聯(若這則訊息是某任務的對話)
  relatedTaskId: text('related_task_id').references(() => tasks.id),

  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  userTimeIdx: index('idx_conv_user_time').on(table.userId, table.createdAt),
  taskIdx: index('idx_conv_task').on(table.relatedTaskId),
}));

// ============================================================
// memory — AI 對使用者的記憶與觀察
// ============================================================
// 用 key-value 結構,彈性最大
// 例:
//   { key: 'personality.tone', value: 'casual_friendly', category: 'personality' }
//   { key: 'pattern.low_energy_window', value: '14:00-16:00', category: 'pattern' }
//   { key: 'preference.morning_brief_time', value: '08:30', category: 'preference' }
export const memory = sqliteTable('memory', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  category: text('category', {
    enum: ['profile', 'personality', 'preference', 'pattern', 'observation', 'project'],
  }).notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(), // JSON 字串或純文字
  confidence: real('confidence').default(1.0), // AI 推測的信心度(0-1)
  sourceType: text('source_type', {
    enum: ['user_told', 'ai_inferred', 'pattern_detected', 'imported'],
  }),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  userKeyIdx: index('idx_memory_user_key').on(table.userId, table.key),
  categoryIdx: index('idx_memory_category').on(table.category),
}));

// ============================================================
// preferences — 使用者明確設定的偏好
// ============================================================
// 跟 memory 不同:memory 是 AI 推測,preferences 是使用者「明確設定」的
export const preferences = sqliteTable('preferences', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  key: text('key').notNull(), // 例:'morning_brief_time' / 'do_not_disturb_start'
  value: text('value').notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  userKeyIdx: index('idx_pref_user_key').on(table.userId, table.key),
}));

// ============================================================
// cost_log — API 用量與成本追蹤
// ============================================================
// 用於月度預算限制、單次任務上限檢查
export const costLog = sqliteTable('cost_log', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id),

  service: text('service', {
    enum: ['anthropic', 'twilio', 'line_push', 'notion', 'other'],
  }).notNull(),
  operation: text('operation'), // 例:'chat_completion', 'phone_call', 'audio_message'

  // Anthropic 用
  model: text('model'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cachedTokens: integer('cached_tokens'),

  // Twilio 用
  callDurationSeconds: integer('call_duration_seconds'),

  // 通用
  costUsd: real('cost_usd').notNull(),
  taskContext: text('task_context'), // 哪個任務/動作觸發的(迴圈偵測用)

  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  dateIdx: index('idx_cost_date').on(table.createdAt),
  contextIdx: index('idx_cost_context').on(table.taskContext),
}));

// ============================================================
// schedule_log — 排程動作歷史
// ============================================================
// 用於 debug、追蹤推播是否成功、迴圈偵測
export const scheduleLog = sqliteTable('schedule_log', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id),

  actionType: text('action_type', {
    enum: ['morning_brief', 'pre_task_reminder', 'evening_summary', 'escalation', 'phone_call'],
  }).notNull(),
  scheduledFor: text('scheduled_for').notNull(),
  executedAt: text('executed_at'),

  success: integer('success', { mode: 'boolean' }).default(false),
  errorMessage: text('error_message'),

  // 對應的任務或事件
  relatedTaskId: text('related_task_id').references(() => tasks.id),

  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  scheduledIdx: index('idx_sched_scheduled_for').on(table.scheduledFor),
  taskIdx: index('idx_sched_task').on(table.relatedTaskId),
}));

// ============================================================
// escalation_state — 提醒升級狀態
// ============================================================
// 追蹤目前對某任務升級到第幾級
export const escalationState = sqliteTable('escalation_state', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  taskId: text('task_id').notNull().references(() => tasks.id),

  // 升級級別
  // 1: text reminder
  // 2: urgent text
  // 3: phone call(若有 Twilio)
  currentLevel: integer('current_level').default(0).notNull(),
  lastEscalatedAt: text('last_escalated_at'),

  // 何時可以下一次升級
  nextEscalationAt: text('next_escalation_at'),

  // 是否已解決(使用者回應或任務完成)
  resolved: integer('resolved', { mode: 'boolean' }).default(false),

  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  taskIdx: index('idx_esc_task').on(table.taskId),
  unresolvedIdx: index('idx_esc_unresolved').on(table.resolved, table.nextEscalationAt),
}));

// ============================================================
// rich_menu_config — Rich Menu 客製化
// ============================================================
export const richMenuConfig = sqliteTable('rich_menu_config', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),

  // 目前用哪個範本
  template: text('template', {
    enum: ['work', 'creative', 'life', 'custom'],
  }).default('work').notNull(),

  // 6 顆按鈕的設定(JSON)
  // [{ position: 1, label: '今日', action: 'show_today' }, ...]
  buttons: text('buttons').notNull(),

  // LINE 端的 Rich Menu ID
  lineRichMenuId: text('line_rich_menu_id'),

  // 預留付費版用
  extra: text('extra'), // JSON: { schedules, ai_recommendations, ... }

  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ============================================================
// notion_field_mapping — 模式 C 用,既有 Notion DB 的欄位對應
// ============================================================
// 例如使用者既有 Notion DB 的「標題」欄位叫「Task Name」,要對應到 bot 的 title
export const notionFieldMapping = sqliteTable('notion_field_mapping', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),

  notionDbId: text('notion_db_id').notNull(),

  // bot 的標準欄位 → 使用者 Notion 的欄位名
  // JSON: { "title": "Task Name", "status": "Status", "start_time": "When", ... }
  fieldMapping: text('field_mapping').notNull(),

  // 模式 C 同步策略
  syncStrategy: text('sync_strategy', {
    enum: ['notion_to_db', 'db_to_notion', 'bidirectional'],
  }).default('bidirectional'),

  lastSyncAt: text('last_sync_at'),

  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ============================================================
// db_meta — 資料庫版本與設定
// ============================================================
// 用於 migration 與 升級判斷
export const dbMeta = sqliteTable('db_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// db_meta 初始值會插入:
// - key: 'schema_version', value: '1.0.0'
// - key: 'storage_mode', value: 'internal' (或 notion-new / notion-existing)
// - key: 'edition', value: 'free' (或 'paid')

// ============================================================
// family_links / invite_codes / assigned_reminders — 親子提醒(功能 2)
// ============================================================
// 見 db/migrations/0002_family.sql。不下 FK,完整性由 app 層管。

// family_links — 家長 ↔ 小孩 綁定關係(多家長/多小孩皆可)
export const familyLinks = sqliteTable('family_links', {
  id: text('id').primaryKey(),
  parentUserId: text('parent_user_id').notNull(),
  childUserId: text('child_user_id').notNull(),
  childLabel: text('child_label'),                       // 家長給小孩的暱稱(小明)
  status: text('status', { enum: ['active', 'revoked'] }).default('active').notNull(),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  pairIdx: index('idx_family_pair').on(table.parentUserId, table.childUserId),
  parentIdx: index('idx_family_parent').on(table.parentUserId),
  childIdx: index('idx_family_child').on(table.childUserId),
}));

// invite_codes — 一次性綁定碼(家長產 → 小孩傳碼綁定)
export const inviteCodes = sqliteTable('invite_codes', {
  code: text('code').primaryKey(),                       // 6 碼數字
  parentUserId: text('parent_user_id').notNull(),
  childLabel: text('child_label'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  expiresAt: text('expires_at').notNull(),               // ISO,過期作廢
  usedAt: text('used_at'),                               // NULL = 未用
  usedByUserId: text('used_by_user_id'),
}, (table) => ({
  parentIdx: index('idx_invite_parent').on(table.parentUserId),
}));

// assigned_reminders — 家長指派給小孩的提醒「模板」(重複規則,只有家長能改/停)
export const assignedReminders = sqliteTable('assigned_reminders', {
  id: text('id').primaryKey(),
  creatorUserId: text('creator_user_id').notNull(),      // 家長
  assigneeUserId: text('assignee_user_id').notNull(),    // 小孩
  text: text('text').notNull(),                          // 事項(刷牙)
  timeHhmm: text('time_hhmm').notNull(),                 // 'HH:MM' 觸發時刻(小孩時區)
  daysOfWeek: text('days_of_week'),                      // NULL = 每天;否則 '1,2,3,4,5'(1=Mon..7=Sun)
  onceDate: text('once_date'),                           // NULL = 循環;'YYYY-MM-DD' = 一次性(臨時提醒)
  enabled: integer('enabled', { mode: 'boolean' }).default(true).notNull(),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  assigneeIdx: index('idx_assigned_assignee').on(table.assigneeUserId, table.enabled),
  creatorIdx: index('idx_assigned_creator').on(table.creatorUserId),
}));
