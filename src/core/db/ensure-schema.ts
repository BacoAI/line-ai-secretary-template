/**
 * 空 D1 自動建表(self-migrate)— 給「一鍵部署」的買家用。
 *
 * 背景:Deploy to Cloudflare 按鈕會 provision 一個「全新空 D1」,但【不會】自動跑 migration。
 *       買家第一次進 /setup 要寫 app_config(設密碼/貼 key)時,表還不存在 → INSERT 直接炸。
 *       這支在 /setup 入口先把 schema 冪等建好(CREATE TABLE IF NOT EXISTS),買家就能開箱即用。
 *
 * 與 db/migrations/* 的關係:
 *   - 這裡是「最終 schema 的冪等快照」(reflect 0001~0004 全跑完的狀態)。
 *   - Workers 執行期讀不到 .sql 檔,所以 DDL 內聯在此。
 *   - ⚠ 改 db/migrations/ 的 schema 時,這支要同步更新(漏改 → 買家新 D1 缺欄位)。
 *
 * ⚠ 買家版 schema 變更鐵則(2026-06-10):買家更新到新版後唯一的 migration 路徑就是這支
 *   (開 /setup 觸發),而 CREATE TABLE IF NOT EXISTS 對「已存在的表」是 no-op —
 *   既有表加欄位這裡建不出來(歷史上 0003 的 ALTER 是折進 CREATE 語句,只救得了全新 D1)。
 *   → 給已部署買家的 schema 變更【只能用「新增表」表達】;真要對既有表加欄位,
 *     必須在這支加冪等 ALTER 邏輯(查 PRAGMA table_info 後補欄位)+ CHANGELOG 註明。
 *
 * 對擁有者的影響:零。擁有者 instance 不設 ENABLE_SETUP → /setup 一律 404 → 這支不會被呼叫;
 *   就算呼叫,全部 IF NOT EXISTS / INSERT OR IGNORE,對既有資料無副作用。
 */

import type { Env } from '../types';

// 模組級旗標:同一 isolate 內只跑一次(失敗則不設旗標 → 下次重試)
let _ensured = false;

// 最終 schema(對應 db/migrations/0001~0004)
const TABLES: string[] = [
  // 0001_init
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    language TEXT DEFAULT 'zh-TW',
    timezone TEXT DEFAULT 'Asia/Taipei',
    phone_number TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started',
    priority TEXT DEFAULT 'p2_normal',
    start_time TEXT,
    end_time TEXT,
    estimated_duration_min INTEGER,
    original_start_time TEXT,
    type TEXT,
    energy_required TEXT,
    project TEXT,
    postpone_count INTEGER DEFAULT 0,
    last_postponed_at TEXT,
    notes TEXT,
    ai_observation TEXT,
    source TEXT DEFAULT 'user_chat',
    notion_page_id TEXT,
    notion_last_sync_at TEXT,
    extra TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    trigger TEXT NOT NULL,
    model_used TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    related_task_id TEXT REFERENCES tasks(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    source_type TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS preferences (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cost_log (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    service TEXT NOT NULL,
    operation TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    call_duration_seconds INTEGER,
    cost_usd REAL NOT NULL,
    task_context TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS schedule_log (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    action_type TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    executed_at TEXT,
    success INTEGER DEFAULT 0,
    error_message TEXT,
    related_task_id TEXT REFERENCES tasks(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS escalation_state (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    current_level INTEGER NOT NULL DEFAULT 0,
    last_escalated_at TEXT,
    next_escalation_at TEXT,
    resolved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rich_menu_config (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    template TEXT NOT NULL DEFAULT 'work',
    buttons TEXT NOT NULL,
    line_rich_menu_id TEXT,
    extra TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS notion_field_mapping (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    notion_db_id TEXT NOT NULL,
    field_mapping TEXT NOT NULL,
    sync_strategy TEXT DEFAULT 'bidirectional',
    last_sync_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS db_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  // 0002_family
  `CREATE TABLE IF NOT EXISTS family_links (
    id TEXT PRIMARY KEY,
    parent_user_id TEXT NOT NULL,
    child_user_id TEXT NOT NULL,
    child_label TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    parent_user_id TEXT NOT NULL,
    child_label TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    used_by_user_id TEXT
  )`,
  // 0002_family + 0003_assigned_once(once_date 直接內含)
  `CREATE TABLE IF NOT EXISTS assigned_reminders (
    id TEXT PRIMARY KEY,
    creator_user_id TEXT NOT NULL,
    assignee_user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    time_hhmm TEXT NOT NULL,
    days_of_week TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    once_date TEXT
  )`,
  // 0004_app_config
  `CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT
  )`,
];

const INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_start_time ON tasks(start_time)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conv_user_time ON conversations(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_conv_task ON conversations(related_task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_user_key ON memory(user_id, key)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category)`,
  `CREATE INDEX IF NOT EXISTS idx_pref_user_key ON preferences(user_id, key)`,
  `CREATE INDEX IF NOT EXISTS idx_cost_date ON cost_log(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_cost_context ON cost_log(task_context)`,
  `CREATE INDEX IF NOT EXISTS idx_sched_scheduled_for ON schedule_log(scheduled_for)`,
  `CREATE INDEX IF NOT EXISTS idx_sched_task ON schedule_log(related_task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_esc_task ON escalation_state(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_esc_unresolved ON escalation_state(resolved, next_escalation_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_family_pair ON family_links(parent_user_id, child_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_family_parent ON family_links(parent_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_family_child ON family_links(child_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invite_parent ON invite_codes(parent_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_assigned_assignee ON assigned_reminders(assignee_user_id, enabled)`,
  `CREATE INDEX IF NOT EXISTS idx_assigned_creator ON assigned_reminders(creator_user_id)`,
];

const SEEDS: string[] = [
  `INSERT OR IGNORE INTO db_meta (key, value) VALUES ('schema_version', '1.0.0')`,
  `INSERT OR IGNORE INTO db_meta (key, value) VALUES ('storage_mode', 'internal')`,
  `INSERT OR IGNORE INTO db_meta (key, value) VALUES ('edition', 'free')`,
];

/**
 * 冪等建好整個 schema。買家全新空 D1 第一次進 /setup 時呼叫。
 * 同一 isolate 內只實際跑一次;全部 IF NOT EXISTS / INSERT OR IGNORE,可安全重複呼叫。
 */
export async function ensureSchema(env: Env): Promise<void> {
  if (_ensured) return;
  // 先建表、再建索引、最後 seed(索引/seed 依賴表存在)
  const stmts = [...TABLES, ...INDEXES, ...SEEDS];
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
  _ensured = true;
}
