/**
 * 靜音狀態管理
 *
 * 兩種型態:
 * - temp     暫時(設了 N 小時,到時間自動解除)
 * - recurring 永久(每天某時段)
 *
 * 注意:靜音只擋「提醒類 push」,使用者主動對話不受影響
 */

import type { Env } from '../types';

export interface SilenceState {
  type: 'temp' | 'recurring';
  // temp 用:
  endsAt?: string; // ISO timestamp,過了就失效
  // recurring 用:
  startHHMM?: string; // "23:00"
  endHHMM?: string; // "07:30"
  // 共用:
  createdAt: string;
}

function silenceKey(userId: string): string {
  return `silence:${userId}`;
}

export async function getSilence(env: Env, userId: string): Promise<SilenceState | null> {
  if (!env.CACHE) return null;
  try {
    const raw = await env.CACHE.get(silenceKey(userId));
    if (!raw) return null;
    const s: SilenceState = JSON.parse(raw);
    // temp 過期自動回 null(但 KV 還在,下次寫會覆蓋)
    if (s.type === 'temp' && s.endsAt) {
      if (new Date(s.endsAt).getTime() < Date.now()) return null;
    }
    return s;
  } catch {
    return null;
  }
}

export async function setSilenceTemp(env: Env, userId: string, hours: number): Promise<SilenceState> {
  const endsAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const s: SilenceState = { type: 'temp', endsAt, createdAt: new Date().toISOString() };
  if (env.CACHE) {
    await env.CACHE.put(silenceKey(userId), JSON.stringify(s), {
      expirationTtl: Math.ceil(hours * 3600) + 60,
    });
  }
  return s;
}

export async function setSilenceRecurring(
  env: Env,
  userId: string,
  startHHMM: string,
  endHHMM: string
): Promise<SilenceState> {
  const s: SilenceState = {
    type: 'recurring',
    startHHMM,
    endHHMM,
    createdAt: new Date().toISOString(),
  };
  if (env.CACHE) {
    // 永久存(30 天 TTL,使用者可手動取消或更新)
    await env.CACHE.put(silenceKey(userId), JSON.stringify(s), {
      expirationTtl: 30 * 24 * 3600,
    });
  }
  return s;
}

export async function cancelSilence(env: Env, userId: string): Promise<boolean> {
  if (!env.CACHE) return false;
  const existing = await env.CACHE.get(silenceKey(userId));
  if (!existing) return false;
  await env.CACHE.delete(silenceKey(userId));
  return true;
}

// 當前是否在靜音中(考慮 recurring 的每天時段)
export async function isSilentNow(env: Env, userId: string): Promise<boolean> {
  const s = await getSilence(env, userId);
  if (!s) return false;
  if (s.type === 'temp') {
    return !!(s.endsAt && new Date(s.endsAt).getTime() > Date.now());
  }
  // recurring:檢查當前台北時間是否在區間內
  if (!s.startHHMM || !s.endHHMM) return false;
  const now = new Date();
  const tpe = new Intl.DateTimeFormat('en-GB', {
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const [h, m] = tpe.split(':').map((x) => parseInt(x));
  const nowMin = h * 60 + m;
  const startMin = hhmmToMin(s.startHHMM);
  const endMin = hhmmToMin(s.endHHMM);
  if (startMin <= endMin) {
    // 例:09:00~17:00
    return nowMin >= startMin && nowMin < endMin;
  } else {
    // 跨午夜,例:23:00~07:30
    return nowMin >= startMin || nowMin < endMin;
  }
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map((x) => parseInt(x));
  return h * 60 + m;
}
