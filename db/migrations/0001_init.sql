-- Initial Schema for line-ai-secretary
-- 對應 src/core/db/schema.ts

-- users
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  language TEXT DEFAULT 'zh-TW',
  timezone TEXT DEFAULT 'Asia/Taipei',
  phone_number TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- tasks
CREATE TABLE tasks (
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
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_start_time ON tasks(start_time);
CREATE INDEX idx_tasks_user_id ON tasks(user_id);

-- conversations
CREATE TABLE conversations (
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
);
CREATE INDEX idx_conv_user_time ON conversations(user_id, created_at);
CREATE INDEX idx_conv_task ON conversations(related_task_id);

-- memory
CREATE TABLE memory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  source_type TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX idx_memory_user_key ON memory(user_id, key);
CREATE INDEX idx_memory_category ON memory(category);

-- preferences
CREATE TABLE preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX idx_pref_user_key ON preferences(user_id, key);

-- cost_log
CREATE TABLE cost_log (
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
);
CREATE INDEX idx_cost_date ON cost_log(created_at);
CREATE INDEX idx_cost_context ON cost_log(task_context);

-- schedule_log
CREATE TABLE schedule_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  action_type TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  executed_at TEXT,
  success INTEGER DEFAULT 0,
  error_message TEXT,
  related_task_id TEXT REFERENCES tasks(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX idx_sched_scheduled_for ON schedule_log(scheduled_for);
CREATE INDEX idx_sched_task ON schedule_log(related_task_id);

-- escalation_state
CREATE TABLE escalation_state (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  current_level INTEGER NOT NULL DEFAULT 0,
  last_escalated_at TEXT,
  next_escalation_at TEXT,
  resolved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX idx_esc_task ON escalation_state(task_id);
CREATE INDEX idx_esc_unresolved ON escalation_state(resolved, next_escalation_at);

-- rich_menu_config
CREATE TABLE rich_menu_config (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  template TEXT NOT NULL DEFAULT 'work',
  buttons TEXT NOT NULL,
  line_rich_menu_id TEXT,
  extra TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- notion_field_mapping
CREATE TABLE notion_field_mapping (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  notion_db_id TEXT NOT NULL,
  field_mapping TEXT NOT NULL,
  sync_strategy TEXT DEFAULT 'bidirectional',
  last_sync_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- db_meta
CREATE TABLE db_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT INTO db_meta (key, value) VALUES ('schema_version', '1.0.0');
INSERT INTO db_meta (key, value) VALUES ('storage_mode', 'internal');
INSERT INTO db_meta (key, value) VALUES ('edition', 'free');
