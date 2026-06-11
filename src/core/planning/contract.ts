/**
 * v200: 排計畫 — Notion 區塊契約
 *
 * 設計:bot 排計畫 SOP 需要在學員 Notion 找到對應區塊(未來計畫 / 每天固定 / 週期性等)。
 * 學員 Notion 命名各異,所以用「安裝精靈 + KV 寫入學員選擇」策略:
 *   1. 安裝精靈列學員所有 H1 / sub-page,問學員「你的『未來計畫』是哪個?」
 *   2. 學員選 → 寫進 KV `planning-contract:<userId>`
 *   3. bot 跑 SOP 時讀 KV 直接拿到精確 block id,絕對精確,不用 fuzzy match
 *   4. 學員改 Notion 後 → 重跑精靈一次(或對 bot 講「重設契約」)
 *
 * 對學員的 Claude 友善:
 *  - 契約 schema 在這個檔
 *  - 學員加新區塊類型只要在 ContractKeys 加一條
 *  - 加新 locator 邏輯只要實作 listCandidates() 補回傳項
 */

import type { Env } from '../types';

// ============== Types ==============

/**
 * 契約欄位 — 每個對應 user Notion 上一個 block id
 * 學員想加新區塊就在這加 key,然後 SOP 程式碼裡 import + 使用
 */
export interface PlanningContract {
  // 必要(SOP 不可少)
  todayPlanPageId: string;        // 「今日計畫」主頁 id
  workLogParentPageId: string;    // 「工作記錄」父頁(下面有月度子頁)
  futurePlanBlockId: string;      // 「未來計畫」H1 block id(下面按日期列)
  dailyFixedBlockId: string;      // 「每天固定工作」H1 block id(下面 toggle 週一~週日)

  // 選用(沒有就 SOP 對應段跳過)
  recurringBlockId?: string;      // 「週期性工作」H1
  monthlyFixedBlockId?: string;   // 「每月固定工作」H1(toggle 月初/月中/月底)
  festivalBlockId?: string;       // 「節日生日」H1
  todoListBlockId?: string;       // 「待辦事項」H3 群開頭 block id

  // meta
  setupAt: string;                // ISO,何時做的契約設定
  notionRootPageId?: string;      // 學員指定的主頁(若 != todayPlanPageId)
}

export type ContractKey = keyof Pick<
  PlanningContract,
  | 'todayPlanPageId'
  | 'workLogParentPageId'
  | 'futurePlanBlockId'
  | 'dailyFixedBlockId'
  | 'recurringBlockId'
  | 'monthlyFixedBlockId'
  | 'festivalBlockId'
  | 'todoListBlockId'
>;

export const REQUIRED_KEYS: ContractKey[] = [
  'todayPlanPageId',
  'workLogParentPageId',
  'futurePlanBlockId',
  'dailyFixedBlockId',
];

export const OPTIONAL_KEYS: ContractKey[] = [
  'recurringBlockId',
  'monthlyFixedBlockId',
  'festivalBlockId',
  'todoListBlockId',
];

// 區塊類型 → 人類可讀名稱(精靈問學員時用)
export const CONTRACT_LABELS: Record<ContractKey, string> = {
  todayPlanPageId: '今日計畫主頁',
  workLogParentPageId: '工作記錄(備份目的地父頁)',
  futurePlanBlockId: '未來計畫',
  dailyFixedBlockId: '每天固定工作',
  recurringBlockId: '週期性工作',
  monthlyFixedBlockId: '每月固定工作',
  festivalBlockId: '節日生日',
  todoListBlockId: '待辦事項',
};

// ============== KV ==============

export async function getContract(env: Env, userId: string): Promise<PlanningContract | null> {
  if (!env.CACHE) return null;
  try {
    const v = await env.CACHE.get(`planning-contract:${userId}`);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

// v220(A-1): per-user「今日計畫頁 id」的共用讀法 — 取代散落在 store/cron/notion-write-tools 的寫死 TODAY_PAGE_ID。
//   有 contract → 回 todayPlanPageId;沒有 → 回 null(呼叫端決定報錯或回空,避免靜默操作到別人的 Notion 頁)。
export async function getTodayPageId(env: Env, userId: string): Promise<string | null> {
  // internal 模式(不接 Notion)無今日計畫頁 → 回 null,讓所有靠此 id 的點(掃提醒 / 出門帶東西 /
  //   同步檢查 / 狀態)走「沒有 Notion 頁」分支,不打 api.notion.com。根因兜底:notion→internal
  //   切換後 KV 的 contract 會殘留,不在這裡擋就會用殘留 id 戳 Notion。
  //   內聯判斷(不 import isInternalMode)避免與 runtime-config 的循環依賴(它 import 本檔的 isDeveloperUser)。
  if (((env.STORAGE_MODE as string) || 'internal') === 'internal') return null;
  const c = await getContract(env, userId);
  return c?.todayPlanPageId ?? null;
}

export async function setContract(env: Env, userId: string, c: PlanningContract): Promise<void> {
  if (!env.CACHE) return;
  await env.CACHE.put(`planning-contract:${userId}`, JSON.stringify(c));
}

export async function patchContract(
  env: Env,
  userId: string,
  patch: Partial<PlanningContract>
): Promise<PlanningContract> {
  const cur = (await getContract(env, userId)) || ({} as PlanningContract);
  const next = { ...cur, ...patch, setupAt: new Date().toISOString() };
  await setContract(env, userId, next);
  return next;
}

export async function deleteContract(env: Env, userId: string): Promise<void> {
  if (!env.CACHE) return;
  await env.CACHE.delete(`planning-contract:${userId}`);
}

// ============== Validation ==============

export interface ContractStatus {
  ok: boolean;
  missing: ContractKey[];           // 缺的必要欄位
  missingOptional: ContractKey[];   // 缺的選用欄位
  contract: PlanningContract | null;
}

export async function checkContract(env: Env, userId: string): Promise<ContractStatus> {
  const c = await getContract(env, userId);
  if (!c) {
    return { ok: false, missing: REQUIRED_KEYS, missingOptional: OPTIONAL_KEYS, contract: null };
  }
  const missing = REQUIRED_KEYS.filter((k) => !c[k]);
  const missingOptional = OPTIONAL_KEYS.filter((k) => !c[k]);
  return { ok: missing.length === 0, missing, missingOptional, contract: c };
}

// ============== Notion candidate listing ==============

/**
 * 列指定頁面下所有「可能是契約對象」的 candidates:
 *  - H1 / H2 / H3 headings
 *  - child_page 子頁
 *  - toggle 標題
 *
 * 用於安裝精靈互動式問學員「下面哪個是你的『未來計畫』?」
 */
export interface NotionCandidate {
  blockId: string;
  type: 'heading_1' | 'heading_2' | 'heading_3' | 'child_page' | 'toggle';
  text: string;
}

export async function listCandidates(env: Env, pageId: string): Promise<NotionCandidate[]> {
  const token = (env as any).NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN 未設');

  const out: NotionCandidate[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const url = `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
    });
    if (!r.ok) throw new Error(`Notion API ${r.status}`);
    const data: any = await r.json();
    for (const b of data.results || []) {
      const t = b.type;
      if (t === 'child_page') {
        out.push({ blockId: b.id, type: 'child_page', text: b.child_page?.title || '' });
      } else if (t === 'heading_1' || t === 'heading_2' || t === 'heading_3') {
        const text = (b[t]?.rich_text || []).map((r: any) => r.plain_text || '').join('');
        if (text.trim()) out.push({ blockId: b.id, type: t, text: text.trim() });
      } else if (t === 'toggle') {
        const text = (b.toggle?.rich_text || []).map((r: any) => r.plain_text || '').join('');
        if (text.trim()) out.push({ blockId: b.id, type: 'toggle', text: text.trim() });
      }
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return out;
}

// ============== 開發者本人判斷 ==============

// 擁有者本人在「自己的部署」裡的 LINE id 前綴 — 從設定 env.OWNER_USER_ID_PREFIX 來,不寫死。
//   僅作 isOwner() 的 legacy fallback(擁有者未在 /setup 設 owner_user_id 時靠它認得本人)。
//   公開範本【不帶】此設定 → 一律回 false,買家全靠 owner_user_id 精確比對,不碰前綴。
export function isDeveloperUser(env: Env, userId: string): boolean {
  const prefix = env.OWNER_USER_ID_PREFIX;
  return !!prefix && !!userId && userId.startsWith(prefix);
}

// ============== 預設 contract(由設定提供,不寫死任何人的 Notion id)==============

/**
 * 預設契約改由「設定」提供,不再寫死任何人的 Notion block id。
 *   - 來源:env.DEFAULT_PLANNING_CONTRACT = 一段 JSON(內容是 PlanningContract)。
 *     擁有者把自己的值放在「自己(gitignored)的 wrangler.toml [vars]」;公開範本不帶。
 *   - 沒設 / JSON 不合法 / 缺必要欄位 → 回 null → 呼叫端引導使用者去 /setup 設自己的
 *     Notion 結構,【絕不】fallback 到別人的值。
 *
 * 取代了舊的 seedDefaultContractForFanke():那支把開發者 8 個寫死 Notion id 灌進「任何
 * owner」的 KV,導致買家(尤其 internal 模式無 Notion)一排工作就去讀不存在的頁面 → 崩。
 */
function readConfiguredDefaultContract(env: Env): PlanningContract | null {
  const raw = env.DEFAULT_PLANNING_CONTRACT;
  if (!raw || typeof raw !== 'string') return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[contract] DEFAULT_PLANNING_CONTRACT 不是合法 JSON,忽略');
    return null;
  }
  for (const k of REQUIRED_KEYS) {
    if (!parsed?.[k]) {
      console.warn(`[contract] DEFAULT_PLANNING_CONTRACT 缺必要欄位 ${k},忽略`);
      return null;
    }
  }
  return { ...parsed, setupAt: parsed.setupAt ?? new Date().toISOString() } as PlanningContract;
}

/**
 * 擁有者缺契約時,嘗試用「設定提供的預設契約」一次性 seed。
 *   有設定 → 寫進 KV 並回傳;沒設定 → 回 null(呼叫端引導去 /setup)。
 */
export async function seedDefaultContract(env: Env, userId: string): Promise<PlanningContract | null> {
  const def = readConfiguredDefaultContract(env);
  if (!def) return null;
  await setContract(env, userId, def);
  return def;
}
