/**
 * v200: 排計畫 — 節日生日 提前提醒 + AI marker
 *
 * 設計:
 *  - 每個項目原文可帶提前天數 marker:
 *      [提前 N 天]   ← 使用者親手寫
 *      [AI:提前 N 天] ← AI 第一次判斷後寫回
 *  - 排計畫 SOP 跑時:
 *      a. 掃節日生日區所有項目
 *      b. parse 日期 + parse marker
 *      c. 若沒 marker → 列入「待 AI 估天數」清單,讓 Claude tool use 估完寫回
 *      d. 若有 marker → 比對 today 距該項目日期 是否 ≤ marker 天數
 *      e. 是 → 列入「該提醒」清單
 *
 * Claude tool use 流程:
 *  - scan_festivals_for_planning → 拿「該提醒 + 待估」兩清單
 *  - 對「待估」清單每筆,Claude 自己用判斷力給 N 天 + 呼叫 set_festival_marker 寫回
 */

import type { Env } from '../types';
import { localWallClock } from '../util/time';

const NOTION_API = 'https://api.notion.com/v1';

async function notionFetch(env: Env, path: string, init?: RequestInit): Promise<any> {
  const token = (env as any).NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN 未設');
  const r = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      ...((init?.headers as any) || {}),
    },
  });
  if (!r.ok) throw new Error(`Notion ${path} ${r.status}: ${(await r.text()).substring(0, 200)}`);
  return r.json();
}

async function listChildren(env: Env, blockId: string): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const q = `page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const data = await notionFetch(env, `/blocks/${blockId}/children?${q}`);
    all.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return all;
}

// ============== Marker parsing ==============

const MARKER_RE = /\[(AI:)?\s*提前\s*(\d+)\s*天\]/;

export interface FestivalItem {
  blockId: string;
  blockType: string;
  rawText: string;
  /** 解析出的日期(MM-DD,不含年) */
  dateMMDD: string | null;
  /** marker 給的提前天數;null = 沒 marker */
  advanceDays: number | null;
  /** marker 是不是 AI 給的(true)還是 user 親寫(false);沒 marker = null */
  markerByAI: boolean | null;
}

function blockPlainText(b: any): string {
  const t = b.type;
  const rt = b[t]?.rich_text || [];
  return rt.map((r: any) => r.plain_text || '').join('');
}

/** 從文字 parse 日期(M/D / MM/DD / 「M / D」含空格 / 模糊「N月初/中/底/第K週」) */
function parseDateFromText(text: string): string | null {
  const pad = (n: number) => String(n).padStart(2, '0');
  // 1. 明確 M/D(容許斜線前後空格 — 使用者很多寫「2 / 2」「9 / 4」)
  const m = text.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (m) {
    return `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  // 2. v211 模糊日期估算:給「提前 14 天」用,不需精準到日。
  //    N月初→03 / N月中→15 / N月底(末)→28
  const fz1 = text.match(/(\d{1,2})\s*月\s*(初|中旬|中|底|末)/);
  if (fz1) {
    const mo = parseInt(fz1[1], 10);
    const day = /初/.test(fz1[2]) ? 3 : /中/.test(fz1[2]) ? 15 : 28;
    return `${pad(mo)}-${pad(day)}`;
  }
  //    N月第K週 → 該週中間(第二週≈11,如母親節「5月第二週」→5/11)
  const fz2 = text.match(/(\d{1,2})\s*月\s*第\s*([一二三四1-4])\s*週/);
  if (fz2) {
    const mo = parseInt(fz2[1], 10);
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, '1': 1, '2': 2, '3': 3, '4': 4 };
    const k = map[fz2[2]] || 1;
    const day = Math.min((k - 1) * 7 + 4, 28);
    return `${pad(mo)}-${pad(day)}`;
  }
  return null;
}

function parseMarker(text: string): { days: number | null; byAI: boolean | null } {
  const m = text.match(MARKER_RE);
  if (!m) return { days: null, byAI: null };
  return { days: parseInt(m[2]), byAI: m[1] === 'AI:' };
}

// ============== Scan ==============

export interface ScanResult {
  itemsToRemind: FestivalItem[];        // 今天距離該項目日期在 marker 天數內,該提醒
  itemsNeedingMarker: FestivalItem[];   // 沒 marker,需 AI 估天數
  allItems: FestivalItem[];
}

function getTaipeiNow(env: Env): Date {
  return localWallClock(env);
}

function dateDaysAhead(now: Date, monthDay: string): number {
  // monthDay = "MM-DD"
  const [m, d] = monthDay.split('-').map(Number);
  // 假設「今年」或「明年」(若已過 → 看明年)
  const year = now.getUTCFullYear();
  const thisYear = new Date(Date.UTC(year, m - 1, d));
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let target = thisYear.getTime();
  if (target < todayMs) {
    target = new Date(Date.UTC(year + 1, m - 1, d)).getTime();
  }
  return Math.floor((target - todayMs) / (24 * 3600 * 1000));
}

/**
 * v207: 改用 walker 模式 — Notion H1 不是容器,項目是 siblings。
 *       傳入 todayPagePageId + festivalH1Id,從 H1 anchor walk siblings 到下個 H1/divider。
 */
function walkSiblingsFrom(allBlocks: any[], anchorId: string): any[] {
  const idx = allBlocks.findIndex((b) => b.id === anchorId);
  if (idx === -1) return [];
  const out: any[] = [];
  for (let i = idx + 1; i < allBlocks.length; i++) {
    const b = allBlocks[i];
    // v222: 區段結束只認 H1 + divider(移除 child_page)。內嵌子頁不是分隔符,
    //   舊邏輯會在子頁提早 break,把後面的節日整批漏掉。同 store.ts / tomorrow.ts 修正。
    if (b.type === 'heading_1' || b.type === 'divider') break;
    out.push(b);
  }
  return out;
}

export async function scanFestivals(env: Env, opts: {
  todayPagePageId: string;
  festivalBlockId: string;
}): Promise<ScanResult> {
  if (!opts.festivalBlockId || !opts.todayPagePageId) {
    return { itemsToRemind: [], itemsNeedingMarker: [], allItems: [] };
  }
  const allBlocks = await listChildren(env, opts.todayPagePageId);
  const blocks = walkSiblingsFrom(allBlocks, opts.festivalBlockId);
  const now = getTaipeiNow(env);

  const all: FestivalItem[] = [];
  for (const b of blocks) {
    const text = blockPlainText(b).trim();
    if (!text) continue;
    if (!['paragraph', 'to_do', 'bulleted_list_item', 'numbered_list_item'].includes(b.type)) continue;

    const dateMMDD = parseDateFromText(text);
    const { days, byAI } = parseMarker(text);

    all.push({
      blockId: b.id,
      blockType: b.type,
      rawText: text,
      dateMMDD,
      advanceDays: days,
      markerByAI: byAI,
    });
  }

  const toRemind: FestivalItem[] = [];
  const needMarker: FestivalItem[] = [];

  for (const item of all) {
    if (!item.dateMMDD) continue;  // 沒日期就跳過
    const daysAhead = dateDaysAhead(now, item.dateMMDD);
    // v211: 使用者要求「要慶祝的節日至少提前 2 週提醒」→ 提前天數一律至少 14 天;
    //        若 marker 寫的比 14 大(例報稅提前更久)就用 marker 的。沒 marker 也用 14 當下限。
    const effectiveAdvance = Math.max(item.advanceDays ?? 0, 14);
    if (daysAhead >= 0 && daysAhead <= effectiveAdvance) {
      toRemind.push(item);
    }
    // 沒 marker 的仍列入待估(讓 AI 寫回 marker,供記錄/未來);但提醒與否已用上面 14 天下限判定
    if (item.advanceDays === null) {
      needMarker.push(item);
    }
  }

  return { itemsToRemind: toRemind, itemsNeedingMarker: needMarker, allItems: all };
}

// ============== Write marker back to Notion block ==============

/**
 * 在指定 block 的 text 結尾 append `[AI:提前 N 天]` marker
 * 用 PATCH /v1/blocks/{block_id} 整段 rich_text 重寫
 */
export async function appendAIMarker(env: Env, blockId: string, days: number): Promise<void> {
  // 先 get current block 拿原 text
  const b = await notionFetch(env, `/blocks/${blockId}`);
  const t = b.type;
  const rt = b[t]?.rich_text || [];
  const currentText = rt.map((r: any) => r.plain_text || '').join('');
  const newText = `${currentText} [AI:提前 ${days} 天]`;

  await notionFetch(env, `/blocks/${blockId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      [t]: {
        rich_text: [{ type: 'text', text: { content: newText } }],
      },
    }),
  });
}
