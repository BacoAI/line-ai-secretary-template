/**
 * 今日「該帶什麼」組裝器(NFC 嗶 / 早安推播 共用)
 *
 * 問題:要帶的東西散在多個「抽屜」,從來沒人合起來。這支就做一件事:
 *   把今天相關的全撈出來 → 去重 → 回一張乾淨的單(附來源分組)。
 *
 * v225 Phase 1a 來源(KV,便宜可靠):
 *   1. 固定必帶 base kit
 *   2. 今日臨時加 outing adhoc(kind!=='general'、未 fire、未過期)
 *   3. 今日(或已逾期未還)承諾
 * Phase 1b 會再加:今日計畫出門項(讀 Notion)。
 */

import type { Env } from '../types';
import { getBaseKit, getAdhocList, getCommitments, getTemplate, getSuggestedRegulars } from './store';
import { getTodayPageId } from '../planning/contract';
import { parseHeadingDate } from '../reminders/store';
import { hasDepartureSignal, matchTemplateNames } from './classify';
import { chat } from '../ai/claude';

export interface BringGroup {
  label: string;
  items: string[];
}

export interface TodayBringList {
  groups: BringGroup[];
  all: string[];
  /** 只有 base kit、沒有任何今天特定項目 */
  onlyBase: boolean;
  /** v226 回饋圈:常帶但還沒固定的東西,建議加進固定必帶/模板 */
  suggestions: Array<{ item: string; count: number }>;
}

/** 今天(當地時區)的 YYYY-MM-DD */
function todayLocal(env: Env): string {
  const tz = env.TIMEZONE || 'Asia/Taipei';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()); // en-CA → YYYY-MM-DD
  return parts;
}

/** 讀 Notion 頁所有 children(翻頁) */
async function listChildren(env: Env, pageId: string): Promise<any[]> {
  const token = (env as any).NOTION_TOKEN;
  if (!token) return [];
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const url = `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
    });
    if (!r.ok) break;
    const data: any = await r.json();
    out.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return out;
}

function blockPlainText(b: any): string {
  const c = b?.[b?.type];
  const rt = c?.rich_text;
  if (!Array.isArray(rt)) return '';
  return rt.map((x: any) => x.plain_text ?? '').join('');
}

/** 今天當地的 month/day */
function todayMonthDay(env: Env): { month: number; day: number } {
  const tz = env.TIMEZONE || 'Asia/Taipei';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || '0', 10);
  return { month: get('month'), day: get('day') };
}

/**
 * 讀「今日計畫」頁今天區段,回所有事項的純文字(供 keyword 與 AI 兩條路共用)。
 * 找今天區段邏輯跟 scanTodayPlanForReminders(v221)一致:今天的日期 heading,沒有就用最後一個日期區段;
 * 區段結束只認 divider + 下一個日期 heading(不認 child_page)。
 */
async function getTodaySectionItemTexts(env: Env, userId: string): Promise<string[]> {
  const pageId = await getTodayPageId(env, userId);
  if (!pageId) return [];
  const blocks = await listChildren(env, pageId);
  if (blocks.length === 0) return [];

  const { month: tMonth, day: tDay } = todayMonthDay(env);
  const dateHeadings: Array<{ idx: number; isToday: boolean }> = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.type?.startsWith('heading_')) continue;
    const hd = parseHeadingDate(blockPlainText(b));
    if (hd) dateHeadings.push({ idx: i, isToday: hd.month === tMonth && hd.day === tDay });
  }
  if (dateHeadings.length === 0) return [];
  const activeH = dateHeadings.find((h) => h.isToday) ?? dateHeadings[dateHeadings.length - 1];

  let scanEnd = blocks.length;
  for (let i = activeH.idx + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'divider') { scanEnd = i; break; }
    if (b.type?.startsWith('heading_') && parseHeadingDate(blockPlainText(b))) { scanEnd = i; break; }
  }

  const texts: string[] = [];
  for (let i = activeH.idx + 1; i < scanEnd; i++) {
    const b = blocks[i];
    if (!['to_do', 'paragraph', 'bulleted_list_item', 'numbered_list_item'].includes(b.type)) continue;
    const text = blockPlainText(b).split('\n')[0].trim();
    if (text) texts.push(text);
  }
  return texts;
}

/**
 * keyword 路徑:今日項目中有出門訊號的 → 對到【所有】命中情境模板(情境疊加)→ 該模板要帶的東西。
 * Phase 1b 限制:只認「對得到既有模板(keyword)」的;對不到的(例「去客戶那」)由 Phase 3 AI 補。
 */
async function gatherTodayPlanOutings(
  env: Env,
  userId: string,
  texts: string[]
): Promise<Array<{ template: string; items: string[] }>> {
  const wantTemplates = new Set<string>();
  for (const text of texts) {
    if (!hasDepartureSignal(text)) continue;
    for (const tpl of matchTemplateNames(text)) wantTemplates.add(tpl); // 情境疊加:全部命中都收
  }
  const out: Array<{ template: string; items: string[] }> = [];
  for (const name of wantTemplates) {
    const items = await getTemplate(env, userId, name);
    if (items && items.length) out.push({ template: name, items });
  }
  return out;
}

/**
 * AI 路徑(Phase 3):用 Claude(haiku,便宜)判「今天哪些事項要出門、各該帶什麼」。
 * 補 keyword 對不到的(「去客戶那」「陪媽媽回診」)。
 * 燒錢防護:走 chat() 內建 guard;缺 key / 超預算 → 回 null → 這裡回 [] → 自動降級 keyword。
 * 只在 NFC 嗶 / 早安這種低頻高價值時刻呼叫(平日 cron 仍走便宜 keyword)。
 */
async function gatherTodayPlanOutingsAI(env: Env, userId: string, texts: string[]): Promise<string[]> {
  if (!texts.length) return [];
  let baseKit: string[] = [];
  try { baseKit = await getBaseKit(env, userId); } catch { /* ignore */ }

  const system =
    '你是幫使用者「出門帶東西」的助理。只輸出 JSON 字串陣列,每個元素是一件「該隨身帶的實體物品」。' +
    '不要解釋、不要 markdown。' +
    // v226(Phase3 審查):防 Haiku 過度聯想 — 明確限量、只列「非帶不可」的。
    '【嚴格】只列「跟該行程直接相關、不帶會出問題」的東西,最多 5 件;一般通用品(現金/身分證/眼鏡/口罩)除非行程特別需要否則不要列;不確定就少列,寧缺勿濫。';
  const prompt =
    `今天的行程事項:\n${texts.map((t) => `- ${t}`).join('\n')}\n\n` +
    `(使用者的「固定必帶」已另外處理,不用重複列:${baseKit.join('、') || '無'})\n\n` +
    `請判斷:這些事項中哪些代表「要出門到某地」,各該額外帶什麼【關鍵】實體物品(每個行程最多 2~3 件)?` +
    `例:「去客戶那開會」→ ["合約","名片"];「陪媽媽回診」→ ["健保卡"];「在家寫程式」→ 不算出門,不列。\n` +
    `只回 JSON 陣列(例 ["合約","名片"]);沒有要出門就回 []。`;

  const res = await chat(env, {
    taskContext: `nfc-bring-ai:${userId}`,
    userId,
    taskType: 'simple', // haiku
    system,
    maxTokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });
  if (!res || !res.text) return [];
  try {
    const m = res.text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 6); // v226: 上限收到 6,防過度列
  } catch {
    return [];
  }
}

/** dueBy(YYYY-MM-DD)是否今天或更早(逾期未還也該提醒帶) */
function isDueTodayOrPast(dueBy: string | undefined, env: Env): boolean {
  if (!dueBy) return true; // 沒寫期限 → 視為隨時該帶
  const m = dueBy.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return true;
  return m[0] <= todayLocal(env); // 字串比較對 YYYY-MM-DD 有效
}

export async function assembleTodayBringList(
  env: Env,
  userId: string,
  opts: { useAI?: boolean } = {}
): Promise<TodayBringList> {
  const groups: BringGroup[] = [];
  const seen = new Set<string>();
  const add = (label: string, items: string[]) => {
    const fresh = items.map((s) => s.trim()).filter((s) => s && !seen.has(s));
    fresh.forEach((s) => seen.add(s));
    if (fresh.length) groups.push({ label, items: fresh });
  };

  // 1. 固定必帶
  add('固定必帶', await getBaseKit(env, userId));
  const baseCount = seen.size;

  // 2. 今日臨時加(帶東西 adhoc;排除一般定時提醒 kind='general')
  try {
    const now = Date.now();
    const adhoc = await getAdhocList(env, userId);
    const adhocItems = adhoc
      .filter((r) => r.kind !== 'general' && !r.firedAt)
      .filter((r) => !r.expiresAt || new Date(r.expiresAt).getTime() > now)
      .flatMap((r) => r.items);
    add('臨時加的', adhocItems);
  } catch {
    /* 撈不到就略過,不擋整張單 */
  }

  // 3. 今日(或逾期未還)承諾
  try {
    const commits = await getCommitments(env, userId);
    const commitItems = commits
      .filter((c) => !c.fulfilledAt)
      .filter((c) => isDueTodayOrPast(c.dueBy, env))
      .map((c) => (c.person ? `${c.item}(給${c.person})` : c.item));
    add('承諾', commitItems);
  } catch {
    /* 略過 */
  }

  // 4. 今日計畫出門項 — 讀今日計畫一次,keyword 疊加(Phase 1b)+(useAI)AI 判語意(Phase 3)
  try {
    const texts = await getTodaySectionItemTexts(env, userId);
    // 4a keyword:出門訊號 → 全部命中模板的東西
    const planOutings = await gatherTodayPlanOutings(env, userId, texts);
    for (const { template, items } of planOutings) {
      add(`今日行程·${template}`, items);
    }
    // 4b AI(僅 NFC 嗶 / 早安等低頻):補 keyword 對不到的(去客戶那→合約/名片)
    if (opts.useAI) {
      const aiItems = await gatherTodayPlanOutingsAI(env, userId, texts);
      add('今日行程·AI 判斷', aiItems);
    }
  } catch {
    /* Notion 讀失敗 / AI 失敗不擋整張單 */
  }

  // 5. 常帶建議(回饋圈):達門檻又還沒固定的東西
  let suggestions: Array<{ item: string; count: number }> = [];
  try {
    suggestions = await getSuggestedRegulars(env, userId);
  } catch {
    /* 略過 */
  }

  return {
    groups,
    all: Array.from(seen),
    onlyBase: seen.size <= baseCount,
    suggestions,
  };
}

/** 把組裝結果格式成推播文字 */
export function formatBringList(list: TodayBringList): string {
  const lines = ['📦 今天要帶', '━━━━━━━━━━━━'];
  for (const g of list.groups) {
    lines.push(`【${g.label}】${g.items.join(' / ')}`);
  }
  if (list.onlyBase) {
    lines.push('');
    lines.push('(今天沒有額外要帶的,帶好上面這些就行)');
  }
  // v226 回饋圈:常帶但沒固定 → 主動建議
  if (list.suggestions && list.suggestions.length) {
    const s = list.suggestions[0];
    lines.push('');
    lines.push(`💡 你最近常帶「${s.item}」(${s.count} 次了),要不要固定?`);
    lines.push(`　跟我說「固定必帶加 ${s.item}」就不用每次提。`);
  }
  lines.push('');
  lines.push('帶齊了嗎?要臨時加就跟我講「帶 X」。');
  return lines.join('\n');
}
