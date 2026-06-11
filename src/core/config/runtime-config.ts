/**
 * 執行期設定層(安裝商品化 — 自架版地基)。
 *
 * 目的:讓買家在 worker 的 /setup 頁貼 key → 存進「他自己的 D1」(app_config 表),
 *       程式一律透過這層拿設定,**先讀 D1、讀不到才退回 env**(wrangler secret/vars)。
 *
 * 向後相容鐵則:
 *   - 擁有者既有 instance 沒有 app_config 資料列(甚至表還沒建)→ 全部退回 env,行為不變。
 *   - 表不存在時 readOverrides 安靜回空物件(不拋錯),所以可先部署程式、晚點再套 migration。
 *
 * 這支只負責「讀/寫設定 + 判斷 owner」;實際把各 call site 從 env 換成這層,是下一階段的事。
 */

import type { Env } from '../types';
import { isDeveloperUser } from '../planning/contract';

export interface RuntimeConfig {
  ownerUserId: string; // 擁有者 LINE userId;'' = 未設(退回 legacy 開發者前綴判斷)
  allowedLineUserIds: string; // 使用者白名單(逗號分隔);'' = 沒額外放行的人
  lineChannelAccessToken: string;
  lineChannelSecret: string;
  anthropicApiKey: string;
  notionToken: string;
  notionSharedMemoryPageId: string;
  storageMode: string;
}

/** 設定 key 常數(同時是 app_config 的主鍵) */
export const CONFIG_KEYS = {
  ownerUserId: 'owner_user_id',
  allowedLineUserIds: 'allowed_line_user_ids',
  lineChannelAccessToken: 'line_channel_access_token',
  lineChannelSecret: 'line_channel_secret',
  anthropicApiKey: 'anthropic_api_key',
  notionToken: 'notion_token',
  notionSharedMemoryPageId: 'notion_shared_memory_page_id',
  storageMode: 'storage_mode',
} as const;

// 模組級快取(單一部署 = 單租戶,短 TTL 安全);寫入時清掉
let _cache: { overrides: Record<string, string>; at: number } | null = null;
const CACHE_TTL_MS = 5000;

/** 讀 app_config 全部 override;表不存在 / 出錯 → 空物件(退回 env) */
async function readOverrides(env: Env): Promise<Record<string, string>> {
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) return _cache.overrides;
  let overrides: Record<string, string> = {};
  try {
    const res = await env.DB.prepare(`SELECT key, value FROM app_config`).all<{ key: string; value: string }>();
    for (const r of res.results || []) {
      if (r.value != null && r.value !== '') overrides[r.key] = r.value;
    }
  } catch (e: any) {
    // 表還沒建 / D1 暫時讀不到 → 全走 env(向後相容)。留 warn 讓運維看得到,不靜默吞。
    console.warn('[runtime-config] readOverrides 失敗,退回 env:', e?.message ?? e);
    overrides = {};
  }
  _cache = { overrides, at: now };
  return overrides;
}

/** 取得解析後的設定(D1 override 優先,否則 env)。 */
export async function getConfig(env: Env): Promise<RuntimeConfig> {
  const o = await readOverrides(env);
  const pick = (key: string, envVal?: string) => o[key] ?? envVal ?? '';
  return {
    ownerUserId: pick(CONFIG_KEYS.ownerUserId, env.OWNER_USER_ID), // D1 優先,否則 env.OWNER_USER_ID,再否則 ''
    allowedLineUserIds: pick(CONFIG_KEYS.allowedLineUserIds, env.ALLOWED_LINE_USER_IDS),
    lineChannelAccessToken: pick(CONFIG_KEYS.lineChannelAccessToken, env.LINE_CHANNEL_ACCESS_TOKEN),
    lineChannelSecret: pick(CONFIG_KEYS.lineChannelSecret, env.LINE_CHANNEL_SECRET),
    anthropicApiKey: pick(CONFIG_KEYS.anthropicApiKey, env.ANTHROPIC_API_KEY),
    notionToken: pick(CONFIG_KEYS.notionToken, env.NOTION_TOKEN),
    notionSharedMemoryPageId: pick(CONFIG_KEYS.notionSharedMemoryPageId, env.NOTION_SHARED_MEMORY_PAGE_ID),
    storageMode: pick(CONFIG_KEYS.storageMode, env.STORAGE_MODE),
  };
}

/** 讀單一設定 key 的原始值(/setup 頁讀 setup_password_hash 等非 RuntimeConfig 欄位用);無則 null。 */
export async function getConfigValue(env: Env, key: string): Promise<string | null> {
  const o = await readOverrides(env);
  return o[key] ?? null;
}

/** 寫一筆設定(/setup 頁用);寫完清快取讓下次 getConfig 立即看到。 */
export async function setConfigValue(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value, new Date().toISOString())
    .run();
  _cache = null;
}

/**
 * 入口覆蓋:回傳一份「設定 D1 優先、否則 env」的 env。
 * 用在每個進入點最前面 → 下游程式照常同步讀 env.XXX,但拿到的是買家在 /setup 設的值。
 * (DB / CACHE / AI 等 binding 原樣保留;只蓋 secret/var 字串欄位。)
 */
export async function overlayConfig(env: Env): Promise<Env> {
  const cfg = await getConfig(env);
  return {
    ...env,
    ALLOWED_LINE_USER_IDS: cfg.allowedLineUserIds,
    LINE_CHANNEL_ACCESS_TOKEN: cfg.lineChannelAccessToken,
    LINE_CHANNEL_SECRET: cfg.lineChannelSecret,
    ANTHROPIC_API_KEY: cfg.anthropicApiKey,
    NOTION_TOKEN: cfg.notionToken,
    NOTION_SHARED_MEMORY_PAGE_ID: cfg.notionSharedMemoryPageId,
    STORAGE_MODE: (cfg.storageMode as Env['STORAGE_MODE']) || env.STORAGE_MODE,
  };
}

/** 擁有者 LINE userId;'' 表示尚未在 /setup 設定。 */
export async function getOwnerUserId(env: Env): Promise<string> {
  return (await getConfig(env)).ownerUserId;
}

/**
 * 是否為 internal 儲存模式(只用內建 D1、完全不接 Notion)。
 *   - 呼叫前 env 須已 overlayConfig(STORAGE_MODE 才是 D1 優先值);各入口已 overlay。
 *   - 未設時保守當 internal(fail-safe:寧可不打 Notion,也不要對沒設 Notion 的人亂戳)。
 * 用途:閘掉 internal 模式不該出現的 Notion 功能(工具表 / 早晚安 cron / 排工作 / prompt)。
 */
export function isInternalMode(env: Env): boolean {
  return ((env.STORAGE_MODE as string) || 'internal') === 'internal';
}

/**
 * 是否為擁有者(開發者/主人)。
 *   - /setup 設過 owner_user_id → 精確比對(買家自架版)。
 *   - 未設 → 退回 legacy 擁有者前綴(擁有者既有 instance 照舊)。
 * 取代散落的 isDeveloperUser() 是下一階段的事;這裡先提供統一入口。
 */
export async function isOwner(env: Env, userId: string): Promise<boolean> {
  if (!userId) return false;
  const owner = await getOwnerUserId(env);
  if (owner) return userId === owner;
  return isDeveloperUser(env, userId);
}
