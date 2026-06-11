-- 親子提醒(功能 2)— family schema
-- 對應 src/core/db/schema.ts 的 familyLinks / inviteCodes / assignedReminders
--
-- 設計:
-- - 不下 FK REFERENCES users(id):綁定/產碼流程的 row 建立順序彈性,完整性由 app 層管。
-- - 「指派提醒模板」存這裡(家長擁有);每天由 cron 物化成小孩名下的 KV Reminder 投遞。
-- - 小孩任何指令都碰不到本表 → 提醒停不掉、刪不掉(防亂關)。

-- family_links — 家長 ↔ 小孩 綁定關係(多家長/多小孩皆可)
CREATE TABLE family_links (
  id TEXT PRIMARY KEY,                       -- UUID
  parent_user_id TEXT NOT NULL,             -- 家長 LINE userId
  child_user_id TEXT NOT NULL,              -- 小孩 LINE userId
  child_label TEXT,                         -- 家長給小孩的暱稱(小明)
  status TEXT NOT NULL DEFAULT 'active',    -- active | revoked
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX idx_family_pair ON family_links(parent_user_id, child_user_id);
CREATE INDEX idx_family_parent ON family_links(parent_user_id);
CREATE INDEX idx_family_child ON family_links(child_user_id);

-- invite_codes — 一次性綁定碼(家長產 → 小孩傳碼綁定)
CREATE TABLE invite_codes (
  code TEXT PRIMARY KEY,                     -- 6 碼數字,也是查詢 key
  parent_user_id TEXT NOT NULL,             -- 產碼的家長
  child_label TEXT,                         -- 家長預設的小孩暱稱
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  expires_at TEXT NOT NULL,                 -- ISO,過期作廢
  used_at TEXT,                             -- 被使用的時間(NULL = 未用)
  used_by_user_id TEXT                      -- 用碼綁定的小孩 userId
);
CREATE INDEX idx_invite_parent ON invite_codes(parent_user_id);

-- assigned_reminders — 家長指派給小孩的提醒「模板」(重複規則)
CREATE TABLE assigned_reminders (
  id TEXT PRIMARY KEY,                       -- UUID
  creator_user_id TEXT NOT NULL,            -- 家長
  assignee_user_id TEXT NOT NULL,           -- 小孩
  text TEXT NOT NULL,                       -- 事項(刷牙)
  time_hhmm TEXT NOT NULL,                  -- 'HH:MM' 觸發時刻(小孩時區)
  days_of_week TEXT,                        -- NULL = 每天;否則 '1,2,3,4,5'(1=Mon..7=Sun)
  enabled INTEGER NOT NULL DEFAULT 1,       -- 只有家長能改/停
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX idx_assigned_assignee ON assigned_reminders(assignee_user_id, enabled);
CREATE INDEX idx_assigned_creator ON assigned_reminders(creator_user_id);
