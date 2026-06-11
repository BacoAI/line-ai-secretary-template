/**
 * Pushover 通知整合(v129)
 *
 * 用途:LINE 通知不夠強烈時(手機靜音/戴耳機),走 Pushover 突破靜音
 * 只 bot 主動 push 到 Pushover,user 其他 LINE 訊息完全不會進來
 *
 * 啟用流程:
 *   1. 開發者(你)註冊 Pushover application 拿 PUSHOVER_APP_TOKEN
 *      → wrangler secret put PUSHOVER_APP_TOKEN
 *   2. user 註冊 Pushover 帳號拿 user key(USER KEY,不是 app token)
 *   3. user LINE 傳「pushover <key>」或「設定 pushover <key>」啟用
 *   4. user LINE 傳「pushover 關」隨時停用
 *
 * 預設行為:沒設 token 或 user 沒給 key → 不 push(完全 no-op)
 */

import type { Env } from '../core/types';

export type PushoverPriority = -2 | -1 | 0 | 1 | 2;
// -2 = no notification (just badge)
// -1 = quiet (no sound)
//  0 = normal
//  1 = high (bypass quiet hours)
//  2 = emergency (Critical Alerts, repeats until acknowledged)

export async function sendPushover(
  env: Env,
  userKey: string,
  title: string,
  message: string,
  priority: PushoverPriority = 0
): Promise<{ ok: boolean; reason?: string }> {
  const appToken = (env as any).PUSHOVER_APP_TOKEN;
  if (!appToken) return { ok: false, reason: 'no_app_token' };
  if (!userKey) return { ok: false, reason: 'no_user_key' };

  const body: Record<string, any> = {
    token: appToken,
    user: userKey,
    title: title.substring(0, 250),
    message: message.substring(0, 1024),
    priority,
  };
  if (priority === 2) {
    // emergency 必填:retry(間隔秒) + expire(多久內 retry)
    // v163: 跟追殺週期(1 分鐘)同步 — 每響 1 次後 30 秒 expire,不疊加
    //       下一輪追殺到時推新 emergency 響,追殺停就跟著停
    //       避免原本 expire 600 = 10 分鐘瘋狂重響的體驗
    body.retry = 30;    // Pushover 最小值
    body.expire = 30;   // 響 1 次後 30 秒 expire,等下輪追殺再響
    body.sound = 'persistent';
  }

  try {
    const r = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text();
      console.warn(`[pushover] HTTP ${r.status}: ${txt.substring(0, 200)}`);
      return { ok: false, reason: `http_${r.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    console.warn('[pushover] exception:', e?.message ?? e);
    return { ok: false, reason: 'exception' };
  }
}

// per-user pushover key 存取(KV)
export async function getUserPushoverKey(env: Env, userId: string): Promise<string | null> {
  if (!env.CACHE) return null;
  try {
    const v = await env.CACHE.get(`user-pushover:${userId}`);
    return v && v.length > 5 ? v : null;
  } catch {
    return null;
  }
}

export async function setUserPushoverKey(env: Env, userId: string, key: string): Promise<void> {
  if (!env.CACHE) return;
  await env.CACHE.put(`user-pushover:${userId}`, key);
}

export async function deleteUserPushoverKey(env: Env, userId: string): Promise<void> {
  if (!env.CACHE) return;
  await env.CACHE.delete(`user-pushover:${userId}`);
}

/**
 * Pushover「全開」模式(v166):限定時間內所有提醒從第一次推送就走 Pushover
 *
 * 影響範圍(僅在此模式啟用 + 未過期時):
 *   - firstSendBatch(提前 N 分鐘第一次提醒)→ 補一則 Pushover priority 1
 *   - startNotifyBatch(T+0 時間到)→ Pushover priority 從 0 升 1
 *   - followupBatch(追殺)→ emergencyStart 強制 = 1(每次追殺都響,不看 aggressive level)
 *
 * 學員相容:無 Pushover key 時 tryPushoverNotify 自動 no-op,此模式對學員零影響
 */
export async function getPushoverAllUntil(env: Env, userId: string): Promise<Date | null> {
  if (!env.CACHE) return null;
  try {
    const v = await env.CACHE.get(`user-pushover-all-until:${userId}`);
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export async function setPushoverAllUntil(env: Env, userId: string, until: Date): Promise<void> {
  if (!env.CACHE) return;
  await env.CACHE.put(`user-pushover-all-until:${userId}`, until.toISOString());
}

export async function deletePushoverAllUntil(env: Env, userId: string): Promise<void> {
  if (!env.CACHE) return;
  await env.CACHE.delete(`user-pushover-all-until:${userId}`);
}

export async function isPushoverAllActive(env: Env, userId: string): Promise<boolean> {
  const until = await getPushoverAllUntil(env, userId);
  if (!until) return false;
  return until.getTime() > Date.now();
}

// 給呼叫端用:確認 user 有啟用就推,沒啟用直接 return 不做事
export async function tryPushoverNotify(
  env: Env,
  userId: string,
  title: string,
  message: string,
  priority: PushoverPriority = 1
): Promise<void> {
  const key = await getUserPushoverKey(env, userId);
  if (!key) return; // user 沒設,no-op
  await sendPushover(env, key, title, message, priority);
}
