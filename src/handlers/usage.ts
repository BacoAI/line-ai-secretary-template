/**
 * v183: /api/usage endpoint — 接 iOS Shortcuts POST 通報「使用者開了某個 app」
 *
 * 預期 payload: { user_id: "U...", app: "Instagram", token: "<shared secret>" }
 *
 * 邏輯:
 *   1. 驗證 token(env.USAGE_WEBHOOK_TOKEN)
 *   2. 確認 user_id 在白名單(對齊既有 ALLOWED_LINE_USER_IDS)
 *   3. 確認此 app 在 user 的 distraction-list
 *   4. 確認當下時間在 work-hours 內
 *   5. 全中 → push 警告(LINE + Pushover Critical Alert)+ 拖延帳本 +1
 *
 * 學員相容:無 token / 無 distraction-list / 無 work-hours → silent 200(不爆錯,避免 setup 中段)
 */

import type { Context } from 'hono';
import type { Env } from '../core/types';
import {
  getDistractionList,
  isDistractionApp,
  getWorkHours,
  isInWorkHours,
  isInWorkTimeByNotion,
  incrementProcrastinationLog,
} from '../core/distraction/store';
import { tryPushoverNotify } from '../adapters/pushover';
import { localWallClock } from '../core/util/time';
import { overlayConfig } from '../core/config/runtime-config';

export async function handleUsageWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = await overlayConfig(c.env); // 2a 入口覆蓋:設定 D1 優先

  // 1. 驗證 token
  const expectedToken = (env as any).USAGE_WEBHOOK_TOKEN as string | undefined;
  if (!expectedToken) {
    return c.json({ ok: false, reason: 'webhook_not_configured(USAGE_WEBHOOK_TOKEN 未設)' }, 503);
  }
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    // 也接 query string 容錯
    body = {
      user_id: c.req.query('user_id'),
      app: c.req.query('app'),
      token: c.req.query('token'),
    };
  }
  const { user_id: userId, app, token } = body || {};
  if (!token || token !== expectedToken) {
    return c.json({ ok: false, reason: 'bad_token' }, 401);
  }
  if (!userId || !app) {
    return c.json({ ok: false, reason: 'missing user_id or app' }, 400);
  }

  // 2. user 白名單(對齊 ALLOWED_LINE_USER_IDS;入口已 overlayConfig → D1 /setup 的值也認)
  const allowed = (env.ALLOWED_LINE_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(userId)) {
    console.warn(`[usage] unauthorized userId ${userId.substring(0, 8)}...`);
    return c.json({ ok: false, reason: 'user_not_allowed' }, 403);
  }

  // 3. 看是否分心 app
  // v190: app="mixed" 是 iOS Shortcuts 的特例 marker — iOS automation 不會告訴我們是哪個 app
  //       因為 user 已在 iOS 端勾選了要監測的 app 清單,server 不再次檢查 distraction-list,
  //       直接信任(進到這層代表 user 自己選的 distraction app 已被開啟)。
  //       但仍需確認 user 有設過 distraction-list(代表他真的啟用過此功能,避免裸 token 任意觸發)。
  const list = await getDistractionList(env, userId);
  if (list.length === 0) {
    return c.json({ ok: true, reason: 'no_distraction_list_set', noted: false });
  }
  if (app !== 'mixed' && !isDistractionApp(list, app)) {
    return c.json({ ok: true, reason: 'not_in_distraction_list', noted: false, app });
  }

  // 4. 看是否在工作時段
  // v185: 兩段判斷
  //   優先:KV work-hours(user 手動設的 override)
  //   fallback:Notion reminders(預設自動跟 Notion 動態同步)
  //   都沒 → 不警告
  const now = new Date();
  const tpe = localWallClock(env, now.getTime()); // 當地時間(學員時區)
  const nowMin = tpe.getUTCHours() * 60 + tpe.getUTCMinutes();
  const periods = await getWorkHours(env, userId);
  let inWork = false;
  let workSource = '';
  let matchedReminderText = '';
  if (periods.length > 0) {
    inWork = isInWorkHours(periods, nowMin);
    workSource = 'manual';
  } else {
    const r = await isInWorkTimeByNotion(env, userId, nowMin);
    inWork = r.inWork;
    workSource = 'notion';
    matchedReminderText = r.matchedReminder?.text || '';
  }
  if (!inWork) {
    return c.json({ ok: true, reason: 'outside_work_hours', noted: false, nowMin, workSource });
  }

  // 5. 全中 → push 警告 + 拖延帳本 +1
  const count = await incrementProcrastinationLog(env, userId, app);
  const contextLine = workSource === 'notion' && matchedReminderText
    ? `正在做的事項:${matchedReminderText.replace(/🔔/g, '').trim()}`
    : '現在是工作時段';
  // v190: app="mixed" 時用通用文案(iOS 沒法告訴 server 是哪個 app)
  const appLine = app === 'mixed' ? '→ 結果你開了分心 app' : `→ 結果你開了「${app}」`;
  const pushoverApp = app === 'mixed' ? '分心 app' : app;
  const warningText = [
    '🐢 偵測到拖延!',
    '━━━━━━━━━━━━',
    contextLine,
    appLine,
    `今日累計拖延:${count} 次`,
    '',
    '立刻關掉 → 切回 LINE 或 Notion 繼續工作',
  ].join('\n');

  // LINE push
  await pushLineText(env, userId, warningText);

  // Pushover Critical Alert(若 user 啟用)
  await tryPushoverNotify(env, userId, '🐢 工作時段拖延中', `${pushoverApp}(今日第 ${count} 次)`, 1);

  return c.json({ ok: true, reason: 'warned', count, app });
}

async function pushLineText(env: Env, userId: string, text: string): Promise<void> {
  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text }],
      }),
    });
  } catch (e: any) {
    console.error('[usage] LINE push failed:', e?.message ?? e);
  }
}
