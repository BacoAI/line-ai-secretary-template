/**
 * v200: 排計畫 — 待辦事項「卡很久」偵測
 *
 * 邏輯:
 *  - 有 due 限制(text 含「M/D 前」「截止」「by M/D」等) + 過期沒勾 → 提醒
 *  - 沒 due + created_time > 7 天前 + 沒勾 → 提醒
 *
 * 注意:使用者的「待辦事項(每天全面檢查)」是一個 H3,下面是一堆同層的 sub-H3(分類:後續上架/雜事/英文類/...)
 * 各 sub-H3 下才是實際 to_do/paragraph。所以掃描要「從 H3 anchor 到下個 divider/H1 為止」。
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

function blockPlainText(b: any): string {
  const t = b.type;
  const rt = b[t]?.rich_text || [];
  return rt.map((r: any) => r.plain_text || '').join('');
}

function getTaipeiNow(env: Env): Date {
  return localWallClock(env);
}

// ============== Due 解析 ==============

interface DueInfo {
  hasDue: boolean;
  dueMMDD?: string;  // "MM-DD"
  daysUntil?: number; // <0 = 過期
}

function parseDue(text: string, today: Date): DueInfo {
  // 嘗試多種格式:「M/D 前」「截止 M/D」「by M/D」「DUE M/D」
  const patterns = [
    /(\d{1,2})\/(\d{1,2})\s*前/,
    /截止\s*(\d{1,2})\/(\d{1,2})/,
    /by\s*(\d{1,2})\/(\d{1,2})/i,
    /due\s*(\d{1,2})\/(\d{1,2})/i,
    /deadline\s*(\d{1,2})\/(\d{1,2})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const mo = parseInt(m[1]);
      const d = parseInt(m[2]);
      const mmdd = `${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      // days until
      const year = today.getUTCFullYear();
      let target = Date.UTC(year, mo - 1, d);
      const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      // 若 due 已是過去年的,就視為今年(以免一直當未來)
      const days = Math.floor((target - todayMs) / (24 * 3600 * 1000));
      return { hasDue: true, dueMMDD: mmdd, daysUntil: days };
    }
  }
  return { hasDue: false };
}

function daysSinceCreated(createdTimeISO: string, today: Date): number {
  const created = new Date(createdTimeISO).getTime();
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((todayMs - created) / (24 * 3600 * 1000));
}

// ============== Scan ==============

export interface StuckItem {
  blockId: string;
  rawText: string;
  reason: 'due_passed' | 'old_no_due';
  daysOverdue?: number;   // for due_passed
  daysOld?: number;       // for old_no_due
  dueMMDD?: string;
  inSubSection?: string;  // 屬於哪個 sub-H3 分類
}

export async function scanStuckTodos(env: Env, opts: {
  pageId: string;           // 今日計畫頁
  todoListAnchorId: string; // 「待辦事項(每天全面檢查)」H3 blockId
  oldDayThreshold?: number; // 預設 7 天
}): Promise<StuckItem[]> {
  if (!opts.todoListAnchorId) return [];
  const threshold = opts.oldDayThreshold ?? 7;
  const today = getTaipeiNow(env);
  const allBlocks = await listChildren(env, opts.pageId);

  // 找 anchor 在哪
  const anchorIdx = allBlocks.findIndex((b) => b.id === opts.todoListAnchorId);
  if (anchorIdx === -1) return [];

  // 從 anchor + 1 開始,到下個 divider 為止
  const sectionBlocks: any[] = [];
  let currentSubH3: string | undefined;
  const inSubSection: Record<string, string> = {};  // blockId → sub-section name
  for (let i = anchorIdx + 1; i < allBlocks.length; i++) {
    const b = allBlocks[i];
    if (b.type === 'divider' || b.type === 'heading_1') break;
    if (b.type === 'heading_2') break;
    if (b.type === 'heading_3') {
      currentSubH3 = blockPlainText(b).trim();
      continue;
    }
    sectionBlocks.push(b);
    if (currentSubH3) inSubSection[b.id] = currentSubH3;
  }

  // 過濾 to_do(包含 toggle 內的;暫不深入遞迴 toggle children,先處理 top-level)
  const todoBlocks = sectionBlocks.filter((b) => b.type === 'to_do' && !b.to_do?.checked);

  const stuck: StuckItem[] = [];
  for (const tb of todoBlocks) {
    const text = blockPlainText(tb).trim();
    if (!text) continue;
    const due = parseDue(text, today);
    if (due.hasDue) {
      if ((due.daysUntil ?? 0) < 0) {
        stuck.push({
          blockId: tb.id,
          rawText: text,
          reason: 'due_passed',
          daysOverdue: -(due.daysUntil ?? 0),
          dueMMDD: due.dueMMDD,
          inSubSection: inSubSection[tb.id],
        });
      }
    } else {
      const age = daysSinceCreated(tb.created_time, today);
      if (age >= threshold) {
        stuck.push({
          blockId: tb.id,
          rawText: text,
          reason: 'old_no_due',
          daysOld: age,
          inSubSection: inSubSection[tb.id],
        });
      }
    }
  }
  return stuck;
}
