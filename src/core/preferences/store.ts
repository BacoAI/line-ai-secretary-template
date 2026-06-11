/**
 * 使用者偏好設定 — KV-based,per user
 *
 * 結構:preferences:{userId} = JSON UserPreferences
 *
 * 設定項目:
 * - 推播開關 + 時間
 * - 靜音規則(目前另外存 silence:{userId})
 * - 未來:語氣、時區、提醒升級層級...
 */

import type { Env } from '../types';

export interface UserPreferences {
  morningBriefEnabled?: boolean;     // 早安推播開關
  morningBriefHHMM?: string;          // "08:30"
  eveningSummaryEnabled?: boolean;    // 晚間總結開關
  eveningSummaryHHMM?: string;        // "22:00"
  procrastinationDetectionEnabled?: boolean; // 拖延偵測
  stuckAlertEnabled?: boolean;        // 卡住告知
  // v151: 追殺等級 + 不打擾時段
  followupLevel?: 'off' | 'lite' | 'standard' | 'aggressive'; // 預設 standard
  quietHoursEnabled?: boolean;        // 不打擾時段開關(預設 true)
  quietHoursStart?: string;           // "23:00"
  quietHoursEnd?: string;             // "07:00"
  // v211: 提醒時序(可調)
  reminderLeadMin?: number;           // 工作開始前提前幾分鐘提醒(T-N),預設 5
  reminderStartNotify?: boolean;      // 到點(T+0)是否再提醒一次,預設 true
  reminderCheckAfterMin?: number;     // 開始後幾分鐘檢測(沒動就進追殺),預設 15
  weatherLocation?: string;           // 天氣預設地點(城市/地區名),可用 LINE 口語改;沒設 → 台北
  updatedAt?: string;
}

// v151: 追殺等級對應的內部參數
export function getFollowupInterval(level: 'off' | 'lite' | 'standard' | 'aggressive'): number {
  // 追殺間隔(分鐘)
  if (level === 'lite') return 9.5;
  return 0.5; // standard / aggressive 維持每 cron tick 都追(實際 1 分鐘間隔)
}

export function getFollowupMaxCount(level: 'off' | 'lite' | 'standard' | 'aggressive'): number | null {
  if (level === 'lite') return 3;
  return null; // standard / aggressive 無上限
}

export function getEmergencyStartCount(level: 'off' | 'lite' | 'standard' | 'aggressive'): number {
  if (level === 'aggressive') return 1; // 第一次就 emergency
  return 3; // lite / standard 第 3 次起
}

export function isFollowupOff(level: 'off' | 'lite' | 'standard' | 'aggressive'): boolean {
  return level === 'off';
}

// v151: 判斷現在是否在不打擾時段內
// nowHHMM 例:'01:30',時段 23:00-07:00 → true(跨日)
export function isInQuietHours(prefs: UserPreferences, nowHHMM: string): boolean {
  if (!prefs.quietHoursEnabled) return false;
  const start = prefs.quietHoursStart || '23:00';
  const end = prefs.quietHoursEnd || '07:00';
  const [nH, nM] = nowHHMM.split(':').map((x) => parseInt(x, 10));
  const [sH, sM] = start.split(':').map((x) => parseInt(x, 10));
  const [eH, eM] = end.split(':').map((x) => parseInt(x, 10));
  const nMin = nH * 60 + nM;
  const sMin = sH * 60 + sM;
  const eMin = eH * 60 + eM;
  if (sMin <= eMin) {
    // 同日(例:09:00-17:00)
    return nMin >= sMin && nMin < eMin;
  } else {
    // 跨日(例:23:00-07:00)
    return nMin >= sMin || nMin < eMin;
  }
}

// 免費版預設(opt-in 安全)
const DEFAULT_FREE_TIER: UserPreferences = {
  morningBriefEnabled: true,
  morningBriefHHMM: '08:30',
  eveningSummaryEnabled: true,
  eveningSummaryHHMM: '22:00',
  procrastinationDetectionEnabled: false,
  stuckAlertEnabled: true,
  // v151
  followupLevel: 'standard',
  quietHoursEnabled: true,
  quietHoursStart: '23:00',
  quietHoursEnd: '07:00',
  reminderLeadMin: 5,
  reminderStartNotify: true,
  reminderCheckAfterMin: 15,
};

// Pro 版預設(全開)
const DEFAULT_PRO_TIER: UserPreferences = {
  morningBriefEnabled: true,
  morningBriefHHMM: '08:30',
  eveningSummaryEnabled: true,
  eveningSummaryHHMM: '22:00',
  procrastinationDetectionEnabled: true,
  stuckAlertEnabled: true,
  // v151
  followupLevel: 'standard',
  quietHoursEnabled: true,
  quietHoursStart: '23:00',
  quietHoursEnd: '07:00',
  reminderLeadMin: 5,
  reminderStartNotify: true,
  reminderCheckAfterMin: 15,
};

// 擁有者前綴從設定 env.OWNER_USER_ID_PREFIX 來,不寫死。
//   命中 → 給 PRO 預設(擁有者自己);否則(含所有買家)給 FREE 預設。
//   公開範本不帶此設定 → 一律 FREE_TIER。
function getDefault(env: Env, userId: string): UserPreferences {
  const prefix = env.OWNER_USER_ID_PREFIX;
  return prefix && userId.startsWith(prefix) ? { ...DEFAULT_PRO_TIER } : { ...DEFAULT_FREE_TIER };
}

function key(userId: string): string {
  return `preferences:${userId}`;
}

export async function getPreferences(env: Env, userId: string): Promise<UserPreferences> {
  const def = getDefault(env, userId);
  if (!env.CACHE) return def;
  try {
    const raw = await env.CACHE.get(key(userId));
    if (!raw) return def;
    const stored: UserPreferences = JSON.parse(raw);
    // merge default 補滿缺漏欄位
    return { ...def, ...stored };
  } catch {
    return def;
  }
}

export async function setPreferences(
  env: Env,
  userId: string,
  patch: Partial<UserPreferences>
): Promise<UserPreferences> {
  const current = await getPreferences(env, userId);
  const updated: UserPreferences = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (env.CACHE) {
    await env.CACHE.put(key(userId), JSON.stringify(updated), {
      expirationTtl: 365 * 24 * 3600, // 1 年
    });
  }
  return updated;
}

// 把當前台北時間(HH:MM)對到 user 的某個觸發時間
// 容錯範圍:目標時間前後 7 分鐘內都算"觸發"
// 因為 cron 每 15 分跑一次,可能 hit 00/15/30/45 而非精確 HH:MM
export function matchesTriggerTime(targetHHMM: string, nowHHMM: string): boolean {
  const [th, tm] = targetHHMM.split(':').map((x) => parseInt(x));
  const [nh, nm] = nowHHMM.split(':').map((x) => parseInt(x));
  const target = th * 60 + tm;
  const now = nh * 60 + nm;
  const diff = Math.abs(target - now);
  return diff <= 7;
}
