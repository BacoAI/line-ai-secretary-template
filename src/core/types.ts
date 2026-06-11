/**
 * 全域型別定義
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

/**
 * Cloudflare Workers 環境變數與綁定
 */
export interface Env {
  // === Bindings(wrangler.toml) ===
  DB: D1Database;
  CACHE: KVNamespace;
  AI: any; // Workers AI(Whisper 用)

  // === Secrets(wrangler secret put)===
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  ANTHROPIC_API_KEY: string;
  OWNER_USER_ID?: string; // 擁有者 LINE userId(可用 env 設;優先序低於 D1 app_config.owner_user_id)
  ALLOWED_LINE_USER_IDS?: string; // 使用者白名單(逗號分隔)。D1 /setup 優先、env secret 後備;與 owner/家庭綁定共組准入規則
  NOTION_TOKEN: string;
  NOTION_SHARED_MEMORY_PAGE_ID: string;
  NOTION_TASK_DB_ID?: string; // 模式 B/C 才需要
  TAVILY_API_KEY?: string; // 上網搜尋
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string; // Twilio 來電顯示號碼(trial 給的號碼)
  USER_PHONE_NUMBER?: string; // 撥給誰(MVP 個人版用 env;商品化改 per-user users.phoneNumber)

  // === Vars(wrangler.toml [vars])===
  TIMEZONE: string;
  ENABLE_SETUP?: string; // '1' 才開放 /setup 設定頁。擁有者 instance 不設→/setup 404(零攻擊面);買家版模板內建 '1'
  SETUP_TOKEN?: string; // 安裝權杖(買家版必設;範本部署表單必填):首次在 /setup 設密碼需輸入一致(堵部署→設密碼的搶註空窗);未設時 /setup 拒絕初始化(fail-closed)
  STORAGE_MODE: 'internal' | 'notion-new' | 'notion-existing';
  MONTHLY_BUDGET_USD: string;
  LOOP_DETECTION_THRESHOLD: string;
  SINGLE_TASK_CONFIRMATION_USD: string;

  // Notion 共享記憶
  NOTION_SHARED_MEMORY_ROOT?: string;
  NOTION_PROFILE_PAGE?: string;
  NOTION_PROJECTS_PAGE?: string;
  NOTION_OBSERVATIONS_PAGE?: string;
  NOTION_RECENT_PAGE?: string;
  NOTION_FANKECLAUDE_SYNC_PAGE?: string;
  NOTION_WORK_LOG_PARENT?: string;

  // 預設排計畫契約(JSON 字串,內容是一份 PlanningContract)。
  //   擁有者把自己的 Notion block id 放在「自己(gitignored)的 wrangler.toml [vars]」;
  //   公開範本【不帶】這個值 → 買家缺契約時只會被引導去 /setup,絕不 fallback 別人的 id。
  DEFAULT_PLANNING_CONTRACT?: string;

  // === 擁有者個人化(都從設定來,公開範本不帶 → 買家拿到泛用預設)===
  OWNER_NAME?: string;                 // 人設用:「你是 {OWNER_NAME} 的私人 AI 秘書」;沒設用「使用者」
  OWNER_USER_ID_PREFIX?: string;       // 擁有者 LINE id 前綴(isOwner 的 legacy fallback / PRO tier 預設);沒設→買家一律靠 owner_user_id
  WORKER_PUBLIC_URL?: string;          // 本 worker 對外網址(拖延偵測捷徑等要用);沒設→該功能提示去設定
  PERSONAL_VOCABULARY?: string;        // 個人詞庫 JSON {people?,brands?,tools?,projects?,actions?};跟通用詞庫合併;沒設→只用通用詞庫
  NOTION_STRUCTURE_GUIDE?: string;     // 擁有者的 Notion 結構導航(自由文字,含自己的頁面 id);internal 模式或沒設→system prompt 省略整段
}

/**
 * 任務優先級
 */
export type Priority = 'p0_urgent' | 'p1_important' | 'p2_normal' | 'p3_whenever';

/**
 * 任務狀態
 */
export type TaskStatus =
  | 'not_started'
  | 'in_progress'
  | 'completed'
  | 'interrupted'
  | 'postponed'
  | 'cancelled';

/**
 * 任務類型
 */
export type TaskType = 'deep_work' | 'meeting' | 'errand' | 'learning' | 'rest';

/**
 * 能量需求
 */
export type EnergyLevel = 'high' | 'medium' | 'low';

/**
 * Claude 模型
 */
export type ClaudeModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7';
