/**
 * v183: 分心 app 名單 + 工作時段 KV 儲存
 *
 * KV keys:
 *   distraction-list:{userId} = JSON string[] (lowercased app names)
 *   work-hours:{userId} = "HH:MM-HH:MM,HH:MM-HH:MM" (multiple periods, comma separated)
 *   procrastination-log:{userId}:{YYYY-MM-DD} = counter (incremented per distraction event)
 *
 * 學員相容:全部 opt-in,KV 沒值 = 功能未啟用 silent no-op
 */

import type { Env } from '../types';
import { localWallClock } from '../util/time';

export interface WorkPeriod {
  startMin: number;
  endMin: number;
}

export async function getDistractionList(env: Env, userId: string): Promise<string[]> {
  if (!env.CACHE) return [];
  try {
    const v = await env.CACHE.get(`distraction-list:${userId}`);
    return v ? JSON.parse(v) : [];
  } catch {
    return [];
  }
}

export async function setDistractionList(env: Env, userId: string, apps: string[]): Promise<void> {
  if (!env.CACHE) return;
  // normalize: lowercase + dedupe + trim
  const norm = Array.from(new Set(apps.map((a) => a.trim().toLowerCase()).filter(Boolean)));
  await env.CACHE.put(`distraction-list:${userId}`, JSON.stringify(norm));
}

export async function addDistractionApp(env: Env, userId: string, app: string): Promise<string[]> {
  const cur = await getDistractionList(env, userId);
  const next = Array.from(new Set([...cur, app.trim().toLowerCase()].filter(Boolean)));
  await setDistractionList(env, userId, next);
  return next;
}

export async function removeDistractionApp(env: Env, userId: string, app: string): Promise<string[]> {
  const cur = await getDistractionList(env, userId);
  const norm = app.trim().toLowerCase();
  const next = cur.filter((a) => a !== norm);
  await setDistractionList(env, userId, next);
  return next;
}

export function isDistractionApp(list: string[], app: string): boolean {
  const norm = app.trim().toLowerCase();
  return list.includes(norm);
}

/**
 * 工作時段
 * 格式:"09:00-12:00,14:00-18:00"
 */
export async function getWorkHours(env: Env, userId: string): Promise<WorkPeriod[]> {
  if (!env.CACHE) return [];
  try {
    const raw = await env.CACHE.get(`work-hours:${userId}`);
    if (!raw) return [];
    return parseWorkHours(raw);
  } catch {
    return [];
  }
}

export async function setWorkHours(env: Env, userId: string, spec: string): Promise<WorkPeriod[]> {
  if (!env.CACHE) return [];
  const parsed = parseWorkHours(spec);
  if (parsed.length === 0) return [];
  await env.CACHE.put(`work-hours:${userId}`, spec);
  return parsed;
}

export function parseWorkHours(spec: string): WorkPeriod[] {
  const out: WorkPeriod[] = [];
  for (const part of spec.split(/[,,]/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d{1,2})(?::(\d{2}))?\s*[-~到至]\s*(\d{1,2})(?::(\d{2}))?$/);
    if (!m) continue;
    const sh = parseInt(m[1], 10);
    const sm = m[2] ? parseInt(m[2], 10) : 0;
    const eh = parseInt(m[3], 10);
    const em = m[4] ? parseInt(m[4], 10) : 0;
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin >= 0 && startMin < 24 * 60 && endMin > startMin && endMin <= 24 * 60) {
      out.push({ startMin, endMin });
    }
  }
  return out;
}

export function formatWorkHours(periods: WorkPeriod[]): string {
  return periods
    .map((p) => `${formatHHMM(p.startMin)}-${formatHHMM(p.endMin)}`)
    .join(', ');
}

function formatHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isInWorkHours(periods: WorkPeriod[], nowMin: number): boolean {
  return periods.some((p) => nowMin >= p.startMin && nowMin < p.endMin);
}

/**
 * v186 / v211: 從 KV reminders 推導工作時段(Notion 動態驅動)
 *
 * 核心定義:工作時段 = 「當下有一個未完成事項,其時間窗涵蓋現在」。
 *
 * 每個 active 事項的時間窗:
 *   1. 有顯式範圍(endTimeMin)→ 照 [start, end]
 *   2. 沒範圍 + 後面有下個事項 + 間隔 ≤ 90 分 → 算到下個事項開始
 *   3. 沒範圍 + 間隔 > 90 分 或 最後一個 → 預設 60 分鐘窗
 *
 * state === 'started'(user 按過「開始做了」)的處理 — v211 修 bug:
 *   - 舊版:started → 永遠算工作中,完全忽略時間。導致像「21:00 洗澡睡覺」按了開始,
 *     整晚(甚至隔天)都被當工作中,休息開分心 app 就誤報拖延。
 *   - 新版:仍信任「user 說在做了」,但把窗錨定在實際開始時間 startedAt,
 *     延伸到 startedAt + 事項時長即結束(處理「排程 08:30、09:45 才真正開工」的遲開工,
 *     又不會無限延伸)。沒有 startedAt 才退回排程窗。
 *
 * 任一 matched 事項:都即時查 Notion 確認是否已勾(v203,避免 KV stale 誤判)。
 */
export async function isInWorkTimeByNotion(env: Env, userId: string, nowMin: number): Promise<{ inWork: boolean; matchedReminder?: { text: string; startMin: number; endMin: number } }> {
  if (!env.CACHE) return { inWork: false };
  const tpe = localWallClock(env);
  const dateStr = `${tpe.getUTCFullYear()}-${String(tpe.getUTCMonth() + 1).padStart(2, '0')}-${String(tpe.getUTCDate()).padStart(2, '0')}`;
  const raw = await env.CACHE.get(`reminders:${userId}:${dateStr}`);
  if (!raw) return { inWork: false };
  let reminders: any[];
  try { reminders = JSON.parse(raw); } catch { return { inWork: false }; }

  // v203: 即時查 Notion 確認單一 block 是否已勾(避免 KV stale 導致誤判)
  const isCheckedInNotion = async (blockId: string): Promise<boolean> => {
    const token = (env as any).NOTION_TOKEN;
    if (!token || !blockId) return false;
    try {
      const r = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
      });
      if (!r.ok) return false;
      const b: any = await r.json();
      return !!b?.to_do?.checked;
    } catch {
      return false;
    }
  };

  // ISO timestamp → 台北「當天分鐘數」(00:00 起算)。無法解析回 null。
  const isoToTpeMin = (iso?: string): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const d = localWallClock(env, t);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  };

  // 篩 + 排序 active reminders(含 started — started 不再有「忽略時間、永遠算工作」的特權)
  // v220: 排除電話提醒(📞 / 「X點打給我」,callAction=true)— 電話提醒是「動作設定」不是工作時段,
  //       否則設個「📞19:15 吃藥」會讓 19:15 被判成工作時間 → 打開分心 app 被誤判分心。
  //       🔔 一般提醒保留(「🔔9:00 開會」那種通常是真工作)。
  const active = reminders
    .filter((r: any) => r.enabled !== false && r.state !== 'resolved' && r.callAction !== true)
    .sort((a: any, b: any) => a.startTimeMin - b.startTimeMin);

  // 對每個 active 計算時間窗,看 now 是否落在窗內
  for (let i = 0; i < active.length; i++) {
    const r = active[i];
    const start = r.startTimeMin;

    // 排程窗
    let winStart = start;
    let winEnd: number;
    if (r.endTimeMin) {
      winEnd = r.endTimeMin;
    } else {
      const next = active[i + 1];
      if (next) {
        const gap = next.startTimeMin - start;
        winEnd = gap <= 90 ? next.startTimeMin : start + 60;
      } else {
        winEnd = start + 60;
      }
    }

    // v211: started → 錨定實際開始時間,窗 = [startedAt, startedAt + 時長](有界,不再整天)
    if (r.state === 'started') {
      const startedMin = isoToTpeMin(r.startedAt);
      if (startedMin != null) {
        const duration = r.endTimeMin ? Math.max(r.endTimeMin - start, 30) : 60;
        winStart = startedMin;
        winEnd = startedMin + duration;
      }
      // 沒有 startedAt → 退回排程窗(winStart/winEnd 不變)
    }

    if (nowMin >= winStart && nowMin < winEnd) {
      // v203: 即時 Notion check — 已勾就跳過,看下個 active
      if (r.blockId && await isCheckedInNotion(r.blockId)) {
        continue;
      }
      return { inWork: true, matchedReminder: { text: r.text, startMin: winStart, endMin: winEnd } };
    }
  }
  return { inWork: false };
}

/**
 * 拖延帳本(counter per day)
 */
export async function incrementProcrastinationLog(env: Env, userId: string, app: string): Promise<number> {
  if (!env.CACHE) return 0;
  const tpe = localWallClock(env);
  const dateStr = `${tpe.getUTCFullYear()}-${String(tpe.getUTCMonth() + 1).padStart(2, '0')}-${String(tpe.getUTCDate()).padStart(2, '0')}`;
  const key = `procrastination-log:${userId}:${dateStr}`;
  const raw = await env.CACHE.get(key);
  let data: { total: number; byApp: Record<string, number> } = { total: 0, byApp: {} };
  if (raw) {
    try { data = JSON.parse(raw); } catch {}
  }
  data.total += 1;
  data.byApp[app] = (data.byApp[app] ?? 0) + 1;
  await env.CACHE.put(key, JSON.stringify(data), { expirationTtl: 7 * 24 * 3600 });
  return data.total;
}

export async function getProcrastinationLog(env: Env, userId: string): Promise<{ total: number; byApp: Record<string, number> }> {
  if (!env.CACHE) return { total: 0, byApp: {} };
  const tpe = localWallClock(env);
  const dateStr = `${tpe.getUTCFullYear()}-${String(tpe.getUTCMonth() + 1).padStart(2, '0')}-${String(tpe.getUTCDate()).padStart(2, '0')}`;
  const raw = await env.CACHE.get(`procrastination-log:${userId}:${dateStr}`);
  if (!raw) return { total: 0, byApp: {} };
  try { return JSON.parse(raw); } catch { return { total: 0, byApp: {} }; }
}
