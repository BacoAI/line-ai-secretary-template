/**
 * 時區工具 — 取代散落各處寫死的 `new Date(ms + 8 * 3600 * 1000)`(UTC+8)。
 *
 * 商品化:學員可設自己的 env.TIMEZONE,不該被釘死在台北。
 *
 * localWallClock(env, ms?) 回傳一個 Date,其「UTC 欄位」= env.TIMEZONE 當地的牆上時鐘:
 *   localWallClock(env).getUTCHours()  === 當地小時
 *   localWallClock(env).getUTCDate()   === 當地日
 * 在 env.TIMEZONE='Asia/Taipei' 時,行為與舊的 `new Date(ms + 8h)` 完全一致(含毫秒),
 * 所以可當 drop-in 直接替換,既有台北部署零行為改變。
 */

import type { Env } from '../types';

export function localWallClock(env: Env, baseMs?: number): Date {
  const tz = (env && env.TIMEZONE) || 'Asia/Taipei';
  const ms = baseMs == null ? Date.now() : baseMs;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || '0', 10);
  let h = g('hour'); if (h === 24) h = 0; // Intl 某些環境午夜回 24
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), h, g('minute'), g('second'));
  // 保留毫秒:offset = 當地牆上時鐘(到秒)對應的 UTC - 此刻(到秒)
  const offset = asUTC - Math.floor(ms / 1000) * 1000;
  return new Date(ms + offset);
}

/** 當地 YYYY-MM-DD */
export function localDateStr(env: Env, baseMs?: number): string {
  return localWallClock(env, baseMs).toISOString().substring(0, 10);
}

/** 當地「今天 0 點起算的分鐘數」(hour*60+minute) */
export function localNowMinutes(env: Env, baseMs?: number): number {
  const d = localWallClock(env, baseMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * 本週/下週日期對照表(查表用,避免 LLM 心算週界出錯)。
 * 全套提示與輕量提示共用 —— 輕量沒這張表時會把「本週X/上週X/下週X」算錯一天(2026-06-04 測出)。
 */
export function buildWeekDateTable(env: Env): string {
  const now = new Date();
  const tpe = localWallClock(env, now.getTime());
  const yy = tpe.getUTCFullYear();
  const mm = tpe.getUTCMonth();
  const dd = tpe.getUTCDate();
  const dow = tpe.getUTCDay(); // 0=Sun, 1=Mon, ...
  // 本週一(ISO:週一是一週起點)
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const thisMonday = new Date(Date.UTC(yy, mm, dd + mondayOffset));
  const weekdayZh = ['一', '二', '三', '四', '五', '六', '日'];
  const lines = ['【上週/本週/下週日期對照(查表用,直接查,不要做任何加減)】'];
  // 從「上週一」起,列 3 週共 21 天 → 上週X / 本週X / 下週X 全部能直接查,免心算(跨月減法最容易錯)。
  for (let i = -7; i < 14; i++) {
    const d = new Date(Date.UTC(thisMonday.getUTCFullYear(), thisMonday.getUTCMonth(), thisMonday.getUTCDate() + i));
    const weekLabel = i < 0 ? '上週' : i < 7 ? '本週' : '下週';
    const dayLabel = weekdayZh[((i % 7) + 7) % 7];
    const dateStr = `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    const isToday = d.getUTCFullYear() === yy && d.getUTCMonth() === mm && d.getUTCDate() === dd;
    lines.push(`- ${weekLabel}${dayLabel}: ${dateStr}${isToday ? '(今天)' : ''}`);
  }
  return lines.join('\n');
}
