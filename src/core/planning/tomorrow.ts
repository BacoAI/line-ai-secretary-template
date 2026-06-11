/**
 * v204: 排工作 — 純 READ 工具,列出明日該做的事
 *
 * v207 fix:Notion H1 不是容器,下方項目是 siblings 不是 children。
 *           改用「列 todayPlanPageId 全頁 → 從 H1 anchor walk siblings」的 walker 模式。
 *
 * 來源 4 個契約區段(都是同層 H1):
 *   - 未來計畫:section 內找 paragraph 為日期(例 5/29(五))→ 下方 todos
 *   - 每天固定工作:section 內找 toggle 為「星期 X」→ listChildren(toggle)
 *   - 週期性工作:整段 section 全納
 *   - 每月固定工作:section 內找 toggle「N 號前 / 月底前」+ 日期符合 → listChildren(toggle)
 */

import type { Env } from '../types';
import { localWallClock } from '../util/time';

const NOTION_API = 'https://api.notion.com/v1';

async function notionFetch(env: Env, path: string): Promise<any> {
  const token = (env as any).NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN 未設');
  const r = await fetch(`${NOTION_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
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

function blockPlainText(b: any): string {
  const t = b.type;
  const rt = b[t]?.rich_text || [];
  return rt.map((r: any) => r.plain_text || '').join('');
}

function getTaipeiNow(env: Env): Date {
  return localWallClock(env);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 3600 * 1000);
}

const WEEKDAYS_CN = ['日', '一', '二', '三', '四', '五', '六'];
function weekdayCN(d: Date): string {
  return WEEKDAYS_CN[d.getUTCDay()];
}

function formatMMSlashDD(d: Date): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${m}/${dd}`;
}

const TIME_RE = /(?:🔔)?(\d{1,2}):(\d{2})/;
function extractTimeMin(text: string): number | null {
  const m = text.match(TIME_RE);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}

/**
 * v208: 月份 gate — 若 text 以「N月:」「N月、」「N月 」等開頭,
 * 只在 N === target month 時通過(避免 conditional 月份事項被亂列)
 */
function passMonthGate(text: string, targetMonth: number): boolean {
  // v211 修:舊版字元類漏了使用者實際用的全形冒號「：」(U+FF1A) → 比對不到 → 直接放行 → 非當月也混進來。
  //   改成「行首 N月」即視為月份標記(不依賴後面是哪種標點),最穩。
  const m = text.match(/^(\d{1,2})月/);
  if (!m) return true;
  return parseInt(m[1], 10) === targetMonth;
}

/**
 * 從 anchor block id 開始,walk siblings 收集到下一個 H1 / divider
 *
 * v222: 區段結束只認 H1 + divider。移除原本「child_page 也算結束」—
 *   契約區段以 H1 錨點界定,child_page 從來不是分隔符;使用者若在區段中間內嵌子頁,
 *   舊邏輯會在 child_page 提早 break,把後面的待辦/未來計畫整批切掉 → 漏資料。
 *   (與 store.ts scanTodayPlanForReminders 同款修正)
 */
function walkSiblingsFrom(allBlocks: any[], anchorId: string): any[] {
  const idx = allBlocks.findIndex((b) => b.id === anchorId);
  if (idx === -1) return [];
  const out: any[] = [];
  for (let i = idx + 1; i < allBlocks.length; i++) {
    const b = allBlocks[i];
    if (b.type === 'heading_1' || b.type === 'divider') break;
    out.push(b);
  }
  return out;
}

export interface TomorrowTodo {
  text: string;
  timeMin: number | null;
  source: 'future_plan' | 'daily_fixed' | 'monthly_fixed' | 'recurring';
}

function pickFromFuturePlanSection(sectionBlocks: any[], target: Date): TomorrowTodo[] {
  const targetMonth = target.getUTCMonth() + 1;
  const targetDay = target.getUTCDate();
  const isDateLine = (text: string) => /^(\d{1,2}\/\d{1,2})/.test(text.trim());
  // v211: 用數字比對月/日,不管有沒有補零都對。
  //        舊版只比「06/01」「6/01」字串,使用者寫「6/1」(個位數日無補零)→ 整天待辦被靜默丟掉。
  const matchTarget = (text: string) => {
    const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})/);
    if (!m) return false;
    return parseInt(m[1], 10) === targetMonth && parseInt(m[2], 10) === targetDay;
  };
  let inTarget = false;
  const out: TomorrowTodo[] = [];
  for (const b of sectionBlocks) {
    const text = blockPlainText(b);
    if (b.type === 'paragraph' && isDateLine(text)) {
      inTarget = matchTarget(text);
      // v211: 日期與內容寫同一(段/行)時,例「7/1（三）開賣\n試看課」—
      //        舊版只把它當日期行 continue 掉,內容整段消失。改:剝掉開頭日期(+括號星期)後若還有內容就收。
      if (inTarget) {
        const rest = text.trim().replace(/^\d{1,2}\/\d{1,2}\s*(?:（[^）]*）|\([^)]*\))?[\s:：]*/, '').trim();
        if (rest) out.push({ text: rest, timeMin: extractTimeMin(rest), source: 'future_plan' });
      }
      continue;
    }
    if (!inTarget) continue;
    // v211: 補收 bulleted/numbered list(舊版只收 to_do+paragraph,漏掉條列待辦)
    if (['to_do', 'paragraph', 'bulleted_list_item', 'numbered_list_item'].includes(b.type)) {
      const t = text.trim();
      if (!t) continue;
      if (!passMonthGate(t, targetMonth)) continue;
      out.push({ text: t, timeMin: extractTimeMin(text), source: 'future_plan' });
    }
  }
  return out;
}

async function pickFromDailyFixedSection(env: Env, sectionBlocks: any[], target: Date): Promise<TomorrowTodo[]> {
  const wd = weekdayCN(target);
  const targetMonth = target.getUTCMonth() + 1;
  const targets = [`星期${wd}`, `週${wd}`];
  let toggleId: string | undefined;
  for (const b of sectionBlocks) {
    if (b.type === 'toggle') {
      const text = blockPlainText(b).trim();
      if (targets.some((t) => text.includes(t))) {
        toggleId = b.id;
        break;
      }
    }
  }
  if (!toggleId) return [];
  const children = await listChildren(env, toggleId);
  const out: TomorrowTodo[] = [];
  for (const c of children) {
    const text = blockPlainText(c).trim();
    if (!text) continue;
    if (!passMonthGate(text, targetMonth)) continue;
    if (['to_do', 'paragraph', 'bulleted_list_item', 'numbered_list_item'].includes(c.type)) {
      out.push({ text, timeMin: extractTimeMin(text), source: 'daily_fixed' });
    }
  }
  return out;
}

async function pickFromMonthlyFixedSection(env: Env, sectionBlocks: any[], target: Date): Promise<TomorrowTodo[]> {
  const day = target.getUTCDate();
  const matchedToggleIds: string[] = [];
  for (const b of sectionBlocks) {
    if (b.type !== 'toggle') continue;
    const text = blockPlainText(b).trim();
    if (text.includes('月底前')) {
      const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      const daysBefore = lastDay - day;
      const m = text.match(/月底前\s*(\d+)/);
      const offset = m ? parseInt(m[1]) : 3;
      if (daysBefore <= offset) matchedToggleIds.push(b.id);
    } else {
      const m = text.match(/(\d+)\s*號前/);
      if (m) {
        const cutoff = parseInt(m[1]);
        if (day <= cutoff) matchedToggleIds.push(b.id);
      }
    }
  }
  const targetMonth = target.getUTCMonth() + 1;
  const out: TomorrowTodo[] = [];
  for (const tid of matchedToggleIds) {
    const children = await listChildren(env, tid);
    for (const c of children) {
      const text = blockPlainText(c).trim();
      if (!text) continue;
      if (!passMonthGate(text, targetMonth)) continue;
      if (['to_do', 'paragraph', 'bulleted_list_item', 'numbered_list_item'].includes(c.type)) {
        out.push({ text, timeMin: extractTimeMin(text), source: 'monthly_fixed' });
      }
    }
  }
  return out;
}

function pickFromRecurringSection(sectionBlocks: any[], target: Date): TomorrowTodo[] {
  const targetMonth = target.getUTCMonth() + 1;
  const out: TomorrowTodo[] = [];
  for (const b of sectionBlocks) {
    const text = blockPlainText(b).trim();
    if (!text) continue;
    if (!passMonthGate(text, targetMonth)) continue;
    if (!['to_do', 'paragraph', 'bulleted_list_item', 'numbered_list_item'].includes(b.type)) continue;
    // v211: 剝掉「N月：」前綴;剝完若沒內容(例「5月：」空佔位)→ 跳過,不要當待辦
    const afterMonth = text.replace(/^\d{1,2}月[、,，:：\s]*/, '').trim();
    if (!afterMonth) continue;
    out.push({ text: afterMonth, timeMin: extractTimeMin(text), source: 'recurring' });
  }
  return out;
}

export interface TomorrowReport {
  targetDate: Date;
  mmdd: string;
  weekday: string;
  byTime: TomorrowTodo[];
  noTime: TomorrowTodo[];
  totalCount: number;
  countsBySource: Record<string, number>;
}

export async function getTomorrowReport(env: Env, opts: {
  todayPagePageId: string;
  futurePlanBlockId: string;
  dailyFixedBlockId: string;
  monthlyFixedBlockId?: string;
  recurringBlockId?: string;
  offsetDays?: number;
}): Promise<TomorrowReport> {
  const target = addDays(getTaipeiNow(env), opts.offsetDays ?? 1);

  // 一次列今日計畫整頁,後續所有 walker 共享
  const allBlocks = await listChildren(env, opts.todayPagePageId);

  const futureSection = opts.futurePlanBlockId ? walkSiblingsFrom(allBlocks, opts.futurePlanBlockId) : [];
  const dailySection = opts.dailyFixedBlockId ? walkSiblingsFrom(allBlocks, opts.dailyFixedBlockId) : [];
  const monthlySection = opts.monthlyFixedBlockId ? walkSiblingsFrom(allBlocks, opts.monthlyFixedBlockId) : [];
  const recurringSection = opts.recurringBlockId ? walkSiblingsFrom(allBlocks, opts.recurringBlockId) : [];

  // 各 pick 平行
  const [a, b, c, d] = await Promise.all([
    Promise.resolve(pickFromFuturePlanSection(futureSection, target)),
    pickFromDailyFixedSection(env, dailySection, target),
    pickFromMonthlyFixedSection(env, monthlySection, target),
    Promise.resolve(pickFromRecurringSection(recurringSection, target)),
  ]);

  // 合併去重
  const seen = new Set<string>();
  const merged: TomorrowTodo[] = [];
  for (const item of [...a, ...b, ...c, ...d]) {
    if (seen.has(item.text)) continue;
    seen.add(item.text);
    merged.push(item);
  }

  const byTime = merged.filter((x) => x.timeMin !== null).sort((x, y) => (x.timeMin ?? 0) - (y.timeMin ?? 0));
  const noTime = merged.filter((x) => x.timeMin === null);

  return {
    targetDate: target,
    mmdd: formatMMSlashDD(target),
    weekday: weekdayCN(target),
    byTime,
    noTime,
    totalCount: merged.length,
    countsBySource: {
      future_plan: a.length,
      daily_fixed: b.length,
      monthly_fixed: c.length,
      recurring: d.length,
    },
  };
}
