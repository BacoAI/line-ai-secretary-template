/**
 * Cron Trigger Handler
 *
 * Cloudflare Cron 每次觸發都會呼叫 scheduled() handler
 * 我們根據 cron expression 分派到對應任務
 *
 * 排程(在 wrangler.toml):
 * - "30 0 * * *"   = 每天 UTC 00:30 = 台北 08:30 → 早安推播
 * - "*\/15 * * * *" = 每 15 分鐘 → 檢查任務提醒
 * - "0 14 * * *"   = 每天 UTC 14:00 = 台北 22:00 → 晚安總結
 */

import type { Env } from '../core/types';
import { getTodayWrites } from '../core/tools/notion-write-tools';
import { getMonthlyCost, calculateClaudeCost, logCost } from '../core/safety/budget';
import { overlayConfig, isInternalMode } from '../core/config/runtime-config';
import {
  loadReminders,
  saveReminders,
  scanTodayPlanForReminders,
  checkBlockStatus,
  formatTime,
  type Reminder,
} from '../core/reminders/store';
import { isSilentNow } from '../core/reminders/silence';
import { getPreferences, matchesTriggerTime, getFollowupInterval, getFollowupMaxCount, getEmergencyStartCount, isFollowupOff, isInQuietHours } from '../core/preferences/store';
import { tryPushoverNotify, isPushoverAllActive } from '../adapters/pushover';
import { placeCall, isTwilioConfigured } from '../adapters/twilio';
import { getContract, getTodayPageId } from '../core/planning/contract'; // v219 查詢型電話 / v220(A-1) 今日計畫頁 per-user
import { getTomorrowReport } from '../core/planning/tomorrow'; // v219: 今天/明天計畫(offsetDays 0/1)
import {
  getAdhocList,
  findDueAdhocByTime,
  markAdhocFired,
  cleanupExpiredAdhoc,
  getTemplate,
  getCommitments,
  findCommitmentsToRemind,
  markCommitmentReminded,
} from '../core/outing/store';
import { hasDepartureSignal, matchTemplateName } from '../core/outing/classify'; // v225: 出門語意判斷共用
import { localWallClock } from '../core/util/time';
import { getEnabledAssignedForChild, getChildLabel, deletePastOnceReminders } from '../core/family/store';
import {
  isTemplateDueToday,
  templateToReminder,
  missedReportText,
  CHILD_MISSED_AFTER_MIN,
  CHILD_EMERGENCY_AFTER_MIN,
  CHILD_MATERIALIZE_GRACE_MIN,
  CHILD_SNOOZE_MAX,
} from '../core/family/delivery';

export async function handleCron(event: ScheduledEvent, env: Env): Promise<void> {
  // 2a 入口覆蓋:設定改「D1 優先、否則 env」(cron 也會推 LINE / 呼叫 Claude)。
  env = await overlayConfig(env);
  const cron = event.cron;
  console.log('Cron triggered:', cron, new Date(event.scheduledTime).toISOString());

  try {
    // v110: 每 1 分鐘跑:提醒檢查 + per-user 動態觸發早安/晚安(讀 KV preferences,自帶 dedup)
    await runReminderCheck(env);
    await runPerUserScheduledPushes(env);
    // v191: 出門提醒 — 掃 ad-hoc 時間到 + 承諾 due 提醒
    await runOutingChecks(env);

    // 每天 08:30(台北)順便檢查預算
    const tpe = new Intl.DateTimeFormat('en-GB', {
      timeZone: env.TIMEZONE || 'Asia/Taipei',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    if (tpe === '08:30') {
      await runBudgetCheck(env);
      await runLinePushQuotaCheck(env); // v158
    }
  } catch (err) {
    console.error('Cron error:', err);
  }
}

// v110: 每 1 分鐘跑時,檢查每個 user 偏好的「早安/晚安時間」是否到了(matchesTriggerTime 容差 + KV dedup)
async function runPerUserScheduledPushes(env: Env): Promise<void> {
  // internal 模式(不接 Notion):早安 / 晚安 / 7:00「今天沒提醒」nudge 的內容核心都是讀 Notion
  //   今日計畫頁,選這模式的買家沒有 Notion → 整組跳過,避免天天誤報「還沒偵測到提醒」「今天比較安靜」。
  //   (每分鐘 KV 提醒檢查 runReminderCheck / 出門檢查 runOutingChecks 不在此函式,照常跑。)
  //   ⚠ 本函式目前只含 Notion 早晚安推播;未來若加「非 Notion」的 per-user 推播,把這個 early return
  //     改成針對各推播點的 isInternalMode guard,別讓非 Notion 推播被一起跳過。
  if (isInternalMode(env)) return;

  const tpe = new Intl.DateTimeFormat('en-GB', {
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());

  // 撈所有 user
  let users: Array<{ id: string }> = [];
  try {
    const result = await env.DB.prepare(`SELECT id FROM users`).all<{ id: string }>();
    users = result.results || [];
  } catch (err) {
    console.error('[per-user-cron] 撈 users 失敗:', err);
    return;
  }

  for (const u of users) {
    const p = await getPreferences(env, u.id);

    // 早安推播
    if (p.morningBriefEnabled && p.morningBriefHHMM &&
        matchesTriggerTime(p.morningBriefHHMM, tpe)) {
      // 防重複:KV 標記今天已推
      const todayKey = new Date().toISOString().substring(0, 10);
      const dupKey = `morning-pushed:${u.id}:${todayKey}`;
      if (env.CACHE) {
        const dup = await env.CACHE.get(dupKey);
        if (dup) {
          console.log(`[per-user-cron] morning 已推過 ${u.id.substring(0, 8)},跳過`);
          continue;
        }
        await env.CACHE.put(dupKey, '1', { expirationTtl: 24 * 3600 });
      }
      console.log(`[per-user-cron] 觸發早安推播 ${u.id.substring(0, 8)}`);
      await runMorningBriefForUser(env, u.id);
    }

    // v211 方向B:早上 7:00 檢查今天有沒有 🔔 提醒事項,完全沒有就推一次(一天一次,週末也推)。
    //   配 v211 方向A(不靠標題日期),這個 nudge 只在「真的整段沒寫 🔔」時才出現 → 兜底「靜默失效」。
    if (matchesTriggerTime('07:00', tpe)) {
      const todayKey = new Date().toISOString().substring(0, 10);
      const dupKey = `noreminder-nudged:${u.id}:${todayKey}`;
      if (env.CACHE) {
        const dup = await env.CACHE.get(dupKey);
        if (!dup) {
          await env.CACHE.put(dupKey, '1', { expirationTtl: 24 * 3600 }); // 先標記,確保整天只檢查一次
          try {
            const todays = await scanTodayPlanForReminders(env, u.id);
            if (todays.length === 0) {
              await pushLineMessage(env, u.id, [
                '☀️ 今天還沒偵測到任何 🔔 提醒事項',
                '━━━━━━━━━━━━',
                '是還沒排,還是今天不用?',
                '要排的話:在「今日計畫」當天那段的事項前面加「🔔」,我就會自動提醒你。',
              ].join('\n'));
              console.log(`[per-user-cron] 7:00 無🔔,已推 nudge ${u.id.substring(0, 8)}`);
            } else {
              console.log(`[per-user-cron] 7:00 檢查:今天有 ${todays.length} 筆🔔,不推 nudge`);
            }
          } catch (e) {
            console.warn('[noreminder-nudge] 檢查/推送失敗:', e);
          }
        }
      }
    }

    // 晚間總結
    if (p.eveningSummaryEnabled && p.eveningSummaryHHMM &&
        matchesTriggerTime(p.eveningSummaryHHMM, tpe)) {
      const todayKey = new Date().toISOString().substring(0, 10);
      const dupKey = `evening-pushed:${u.id}:${todayKey}`;
      if (env.CACHE) {
        const dup = await env.CACHE.get(dupKey);
        if (dup) continue;
        await env.CACHE.put(dupKey, '1', { expirationTtl: 24 * 3600 });
      }
      console.log(`[per-user-cron] 觸發晚間總結 ${u.id.substring(0, 8)}`);
      await runEveningSummaryForUser(env, u.id);
    }
  }
}

/**
 * 安全網 2:預算逼近警告
 * 50% / 80% / 95% 三道閾值,跨過一次推一次
 */
async function runBudgetCheck(env: Env): Promise<void> {
  const limit = parseFloat(env.MONTHLY_BUDGET_USD);
  if (!limit || limit <= 0) return;

  let monthly = 0;
  try {
    monthly = await getMonthlyCost(env);
  } catch (err) {
    console.error('[budget] 撈月用量失敗:', err);
    return;
  }
  const pct = (monthly / limit) * 100;
  console.log(`[budget] 本月用量 USD$${monthly.toFixed(3)} / $${limit} (${pct.toFixed(1)}%)`);

  const thresholds: Array<{ level: number; emoji: string; tone: string }> = [
    { level: 50, emoji: '●', tone: '本月已用過半' },
    { level: 80, emoji: '⚠️', tone: '本月用量逼近上限' },
    { level: 95, emoji: '🚨', tone: '本月即將達上限,bot 隨時可能停擺' },
  ];

  const monthKey = new Date().toISOString().substring(0, 7); // YYYY-MM

  for (const t of thresholds) {
    if (pct < t.level) continue;
    const kvKey = `budget-alert:${monthKey}:${t.level}`;
    if (env.CACHE) {
      const already = await env.CACHE.get(kvKey);
      if (already) continue;
      await env.CACHE.put(kvKey, '1', { expirationTtl: 35 * 24 * 3600 });
    }
    // 推給所有 user
    const text = [
      `${t.emoji} 預算警告`,
      '━━━━━━━━━━━━',
      `${t.tone}`,
      `本月已用:USD $${monthly.toFixed(2)} / $${limit} (${pct.toFixed(1)}%)`,
      '━━━━━━━━━━━━',
      '若需要提高上限,改 wrangler.toml MONTHLY_BUDGET_USD 並重新部署。',
    ].join('\n');
    await pushToAllUsers(env, text);
  }
}

/**
 * v158: LINE push 配額警告 — 50% / 80% / 95% 三道閾值
 * 免費 plan 200/月很容易爆,升級 5000/月 仍要追蹤。每月跨過閾值推一次。
 * 仿照 runBudgetCheck pattern。
 */
async function runLinePushQuotaCheck(env: Env): Promise<void> {
  const headers = { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  let used = 0;
  let limit = 0;
  try {
    const r1 = await fetch('https://api.line.me/v2/bot/message/quota', { headers });
    if (!r1.ok) return;
    const d1: any = await r1.json();
    if (d1?.type !== 'limited') return; // 無限制 plan 不警告
    limit = Number(d1.value ?? 0);
    const r2 = await fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers });
    if (!r2.ok) return;
    const d2: any = await r2.json();
    used = Number(d2?.totalUsage ?? 0);
  } catch (e) {
    console.warn('[line-quota] fetch failed:', e);
    return;
  }
  if (!limit || limit <= 0) return;
  const pct = (used / limit) * 100;
  console.log(`[line-quota] 本月 push: ${used} / ${limit} (${pct.toFixed(1)}%)`);

  const thresholds: Array<{ level: number; emoji: string; tone: string }> = [
    { level: 50, emoji: '●', tone: '本月 LINE push 已用過半' },
    { level: 80, emoji: '⚠️', tone: 'LINE push 額度逼近上限,即將失去主動推播能力' },
    { level: 95, emoji: '🚨', tone: 'LINE push 即將達上限,提醒功能隨時可能無法送出' },
  ];

  const monthKey = new Date().toISOString().substring(0, 7); // YYYY-MM
  for (const t of thresholds) {
    if (pct < t.level) continue;
    const kvKey = `line-quota-alert:${monthKey}:${t.level}`;
    if (env.CACHE) {
      const already = await env.CACHE.get(kvKey);
      if (already) continue;
      await env.CACHE.put(kvKey, '1', { expirationTtl: 35 * 24 * 3600 });
    }
    const text = [
      `${t.emoji} LINE Push 配額警告`,
      '━━━━━━━━━━━━',
      t.tone,
      `本月已推:${used} / ${limit} (${pct.toFixed(1)}%)`,
      '━━━━━━━━━━━━',
      '升級:LINE Developers Console → Messaging API → 月費 plan',
      '或:減少推播頻率(改設「追殺等級 lite」/「不打擾 開」)',
    ].join('\n');
    await pushToAllUsers(env, text);
  }
}

async function pushToAllUsers(env: Env, text: string): Promise<void> {
  let users: Array<{ id: string }> = [];
  try {
    const result = await env.DB.prepare(`SELECT id FROM users`).all<{ id: string }>();
    users = result.results || [];
  } catch (err) {
    console.error('[push-all] 撈 users 失敗:', err);
    return;
  }
  for (const user of users) {
    try {
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to: user.id, messages: [{ type: 'text', text }] }),
      });
    } catch (err) {
      console.error('[push-all] push 失敗:', err);
    }
  }
}

/**
 * 早安推播(每天台北 08:30)
 *
 * 邏輯:
 * 1. 讀今日計畫頁,找今天 heading 區段
 * 2. 列出所有事項,標哪些有 🔔(已設提醒)
 * 3. 沒今日計畫 → 推「請開始做計畫」
 * 4. (P3 才做)30 分鐘後追問是否做了計畫
 */
// 對單一 user 推早安(用於 per-user 動態觸發)— 含「設提醒 N」編號清單
export async function runMorningBriefForUser(env: Env, userId: string): Promise<void> {
  const result = await buildMorningBriefTextAndIndex(env, userId);
  // 把編號→blockId 對照存 KV,讓「設提醒 N」可反查
  const todayKey = new Date().toISOString().substring(0, 10);
  if (env.CACHE && result.index.length > 0) {
    await env.CACHE.put(
      `morning-index:${userId}:${todayKey}`,
      JSON.stringify(result.index),
      { expirationTtl: 24 * 3600 }
    );
  }
  // 用 pushLineMessage 順手記 messageId(讓 LINE quote 可反查)
  const msgId = await pushLineMessage(env, userId, result.text);
  if (msgId && env.CACHE) {
    // 早安推播的 messageId 標記為 morning-brief 類別
    await env.CACHE.put(`pushed-msg:${msgId}`, `morning-brief:${todayKey}`, {
      expirationTtl: 36 * 3600,
    });
  }
}

// 對單一 user 推晚間總結
async function runEveningSummaryForUser(env: Env, userId: string): Promise<void> {
  await runEveningSummary(env, userId);
}

// 共用:組早安推播文字 + 編號清單(blockId 對應)
export async function buildMorningBriefTextAndIndex(env: Env, userId: string): Promise<{
  text: string;
  index: Array<{ n: number; blockId: string; text: string; hasReminder: boolean }>;
}> {
  // v220(A-1): 今日計畫頁改走 per-user contract,不再寫死
  const TODAY_PAGE_ID = await getTodayPageId(env, userId);
  if (!TODAY_PAGE_ID) return { text: '(早安推播:找不到你的今日計畫頁設定,請先完成 Notion 設定)', index: [] };
  const indexList: Array<{ n: number; blockId: string; text: string; hasReminder: boolean }> = [];

  const response = await fetch(
    `https://api.notion.com/v1/blocks/${TODAY_PAGE_ID}/children?page_size=100`,
    {
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    }
  );
  if (!response.ok) {
    return { text: `(早安推播讀頁失敗 ${response.status})`, index: [] };
  }
  const data: any = await response.json();
  const blocks = data.results || [];

  const now = new Date();
  const tpeDate = new Intl.DateTimeFormat('zh-TW', {
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const shortDay = tpeDate.replace(/^0/, '');

  let todayHeadingIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (!blocks[i].type.startsWith('heading_')) continue;
    const t = (blocks[i][blocks[i].type]?.rich_text ?? []).map((x: any) => x.plain_text).join('');
    if (t.includes(tpeDate) || t.includes(shortDay)) { todayHeadingIdx = i; break; }
  }

  let endIdx = blocks.length;
  if (todayHeadingIdx !== -1) {
    for (let i = todayHeadingIdx + 1; i < blocks.length; i++) {
      // 區段邊界:下個 heading / child_page / divider(使用者可以用分隔線標記區段結束)
      if (
        blocks[i].type.startsWith('heading_') ||
        blocks[i].type === 'child_page' ||
        blocks[i].type === 'divider'
      ) {
        endIdx = i;
        break;
      }
    }
  }

  if (todayHeadingIdx === -1) {
    return {
      text: [
        '☀️ 早安',
        '━━━━━━━━━━━━',
        '今天的計畫還沒寫。',
        '建議先花 5 分鐘列出今天要做的事(可加 🔔 在事項前自動設提醒)',
        '',
        '寫好後跟我說一聲,或者直接讓我幫你看看。',
      ].join('\n'),
      index: [],
    };
  }

  const items: string[] = [];
  let n = 1;
  for (let i = todayHeadingIdx + 1; i < endIdx; i++) {
    const b = blocks[i];
    const c = b[b.type];
    if (!c?.rich_text) continue;
    const t = c.rich_text.map((x: any) => x.plain_text).join('').trim();
    if (!t) continue;
    if (b.type !== 'to_do' && b.type !== 'paragraph') continue;
    const hasReminder = t.includes('🔔');
    const checked = b.type === 'to_do' && c.checked;
    const clean = t.replace(/🔔/g, '').trim();
    const mark = hasReminder ? ' 🔔' : '';
    const status = checked ? '✓ ' : '';
    items.push(`${n}. ${status}${clean}${mark}`);
    indexList.push({ n, blockId: b.id, text: clean, hasReminder });
    n++;
    if (n > 30) break;
  }
  const text = [
    '☀️ 早安',
    '━━━━━━━━━━━━',
    `今天 ${tpeDate} 有 ${items.length} 件事:`,
    '',
    ...items,
    '',
    '━━━━━━━━━━━━',
    '🔔 = 已設提醒',
    '指令:',
    '• 「設提醒 2 3」← 用編號設提醒(會幫你加 🔔)',
    '• 「取消提醒 2」← 取消單筆',
    '• 「提醒」← 看目前所有提醒',
    '• 「靜音 2 小時」← 暫停提醒',
  ].join('\n');
  return { text, index: indexList };
}

/**
 * 兩階段提醒 — 反拖延設計
 *
 * 階段 1(T-5 分鐘):輕推,帶 Quick Reply 按鈕
 * 階段 2(T+15 分鐘):
 *   - 先檢查 Notion 該 block 狀態(打勾 / 被修改 → 跳過)
 *   - 若仍未動 → 第二次提醒,**無按鈕**(強迫打字回應,拉高欺騙成本)
 */
// ============== 親子提醒(功能 2)投遞 ==============

function currentDow(env: Env): number {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    weekday: 'short',
  }).format(new Date());
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[wd] ?? 1;
}

function currentDateStr(env: Env): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** 把家長指派、今天該觸發的模板物化成小孩名下的 parent_request 提醒(idempotent)。 */
async function materializeAssignedReminders(
  env: Env,
  userId: string,
  merged: Reminder[],
  nowMin: number
): Promise<void> {
  let templates;
  try {
    templates = await getEnabledAssignedForChild(env, userId);
  } catch {
    return;
  }
  if (!templates.length) return;
  const dow = currentDow(env);
  const today = currentDateStr(env);
  for (const t of templates) {
    if (merged.find((e) => e.assignedTemplateId === t.id)) continue; // 今天已物化
    if (!isTemplateDueToday(t.daysOfWeek, t.onceDate, dow, today)) continue;
    const r = templateToReminder(t);
    if (nowMin > r.startTimeMin + CHILD_MATERIALIZE_GRACE_MIN) continue; // 已過太久,今天不補
    merged.push(r);
    console.log(`[family] 物化指派提醒給 ${userId.substring(0, 8)}:${t.text} @ ${t.timeHhmm}`);
  }
}

function childReminderQuickReply(reminderId: string, snoozeCount: number): any {
  const items: any[] = [
    {
      type: 'action',
      action: { type: 'postback', label: '✓ 完成', data: `action=child-done&id=${reminderId}`, displayText: '完成' },
    },
  ];
  if (snoozeCount < CHILD_SNOOZE_MAX) {
    items.push({
      type: 'action',
      action: { type: 'postback', label: '⏰ 等一下做', data: `action=child-snooze&id=${reminderId}`, displayText: '等一下做' },
    });
  }
  return { items };
}

/** parent_request 提醒的專屬投遞:到點推小孩(附完成/等一下按鈕)、過點 15 分沒做通知家長。 */
async function handleParentRequestReminder(
  env: Env,
  childUserId: string,
  r: Reminder,
  nowMin: number
): Promise<void> {
  const delta = r.startTimeMin - nowMin;

  // 階段 1:到點推給小孩
  if (r.state === 'pending' && delta <= 0) {
    if (await isSilentNow(env, childUserId)) return; // 靜音時段先不推,等下一輪
    const t = formatTime(r.startTimeMin);
    const who = r.source === 'self' ? '你設的' : '主帳號設的';
    const text = `🔔 提醒:${r.text}\n(${who} ${t} 提醒)\n做完按「✓ 完成」;要晚點做按「⏰ 等一下做」`;
    const msgId = await pushLineMessage(env, childUserId, text, childReminderQuickReply(r.id, r.childSnoozeCount ?? 0));
    if (msgId) await rememberPushedMsg(env, msgId, r.id);
    // Pushover:突破手機勿擾/靜音(沒設 key → 自動略過,零影響)
    await tryPushoverNotify(env, childUserId, r.source === 'self' ? '🔔 提醒' : '🔔 主帳號提醒', r.text, 1);
    r.state = 'first_sent';
    r.firstSentAt = new Date().toISOString();
    r.totalPushCount = (r.totalPushCount ?? 0) + 1;
    return;
  }

  // 階段 2:過點 CHILD_MISSED_AFTER_MIN 分還沒做 → 通知家長(一次)+ 輕推小孩一次
  if (r.state === 'first_sent' && delta <= -CHILD_MISSED_AFTER_MIN && !r.reportedMissedToParent) {
    // 家長設的才回報家長;自己設的(creator==assignee)不回報
    if (r.creatorUserId && r.creatorUserId !== childUserId) {
      const label = await getChildLabel(env, r.creatorUserId, childUserId);
      await pushLineMessage(env, r.creatorUserId, missedReportText(label, r.text, r.startTimeMin));
    }
    if (!(await isSilentNow(env, childUserId))) {
      await pushLineMessage(
        env,
        childUserId,
        `⏰ 還沒做「${r.text}」喔,做完記得按「✓ 完成」`,
        childReminderQuickReply(r.id, r.childSnoozeCount ?? 0)
      );
      // Pushover:沒做催促也突破勿擾(沒設 key 自動略過)
      await tryPushoverNotify(env, childUserId, '⏰ 還沒做', r.text, 1);
    }
    r.reportedMissedToParent = true;
    r.state = 'second_sent';
    return;
  }

  // 階段 3:過點 CHILD_EMERGENCY_AFTER_MIN 分還沒做 → Pushover 緊急(priority 2 狂響突破靜音),只一次
  if (
    (r.state === 'first_sent' || r.state === 'second_sent') &&
    delta <= -CHILD_EMERGENCY_AFTER_MIN &&
    !r.emergencyPushoverSent
  ) {
    await tryPushoverNotify(env, childUserId, '🚨 真的該做了!', r.text, 2);
    r.emergencyPushoverSent = true;
    return;
  }
  // 之後不再嘮叨,等小孩按完成
}

async function runReminderCheck(env: Env): Promise<void> {
  // 取所有 user(個人版目前只有開發者本人)
  let users: Array<{ id: string }> = [];
  try {
    const result = await env.DB.prepare(`SELECT id FROM users`).all<{ id: string }>();
    users = result.results || [];
  } catch (err) {
    console.error('[reminders] 撈 users 失敗:', err);
    return;
  }

  // 當前台北時間(分鐘數)
  const now = new Date();
  const tpe = new Intl.DateTimeFormat('en-GB', {
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const [hh, mm] = tpe.split(':').map((x) => parseInt(x));
  const nowMin = hh * 60 + mm;

  // 親子提醒(功能 2):每輪清掉過期的一次性提醒(全域,一次)
  await deletePastOnceReminders(env, currentDateStr(env));

  for (const user of users) {
    await checkUserReminders(env, user.id, nowMin);
  }
}

async function checkUserReminders(env: Env, userId: string, nowMin: number): Promise<void> {
  // v151: 撈 user preferences(追殺等級 + 不打擾時段)
  const prefs = await getPreferences(env, userId);
  const followupLevel = prefs.followupLevel || 'standard';
  const nowHH = String(Math.floor(nowMin / 60)).padStart(2, '0');
  const nowMM = String(nowMin % 60).padStart(2, '0');
  const inQuietHours = isInQuietHours(prefs, `${nowHH}:${nowMM}`);

  // v166: 一次撈「Pushover 全開」狀態(此 user 在限定時間內所有提醒從第一次推送就走 Pushover)
  //       學員無 Pushover key 時 tryPushoverNotify 自動 no-op,此模式對學員零影響
  const pushoverAllActive = await isPushoverAllActive(env, userId);

  // 1. 從 Notion 掃今日計畫的啟用提醒
  const fromNotion = await scanTodayPlanForReminders(env, userId);

  // 2. 載入 KV 已存的 reminders
  const existing = await loadReminders(env, userId);

  // 3. 雙向同步:
  //    a. Notion 有但 KV 沒記的 → 新增 reminder
  //    b. KV 有的 → 更新 text/startTimeMin(若 Notion 改了)
  //       時間變了 → 重置 state = pending,給新時間重新走流程
  //    c. KV 有但 Notion 沒有的 → 標 enabled=false 停止追殺
  // v130: 用 KV 載入時(sync 前)的快照,後面比對是否有變更才寫
  const originalSnapshot = JSON.stringify(existing);
  const merged: Reminder[] = [...existing];
  for (const r of fromNotion) {
    const found = merged.find((e) => e.blockId === r.blockId);
    if (!found) {
      merged.push({
        id: crypto.randomUUID(),
        blockId: r.blockId,
        text: r.text,
        startTimeMin: r.startTimeMin,
        endTimeMin: r.endTimeMin,
        enabled: true,
        source: 'notion',
        state: 'pending',
        callAction: r.callAction, // v214: Notion 📞 開頭 → 到點打電話
        queryPlan: r.queryPlan, // v219: Notion 📞 查詢型(報今天/明天工作)→ 到點讀計畫念
      });
    } else {
      // v182: 若 Notion 又看到這條 block → 一律 re-enable
      //       修「反向 sync 一次性故障 disable 後永遠回不來」的 bug
      if (!found.enabled) {
        console.log(`[reminders] re-enable(Notion 又有這事項):${r.text.substring(0, 30)}`);
        found.enabled = true;
      }
      // v214: 同步 📞/🔔 切換 — 使用者可能事後在 Notion 把 🔔 改成 📞(或反之)
      // v215 reviewer #4: 切換時(🔔↔📞)重置 phoneCalledAt + state=pending,讓「新模式」能重新觸發。
      //   情境:本來 📞 已撥過電話(phoneCalledAt 設了),使用者改成 🔔 想改回一般提醒 —
      //   若不重置,phoneCalledAt 還在會擋住、state 卡在中後段不會重走流程。反之亦然。
      const modeChanged = !!found.callAction !== !!r.callAction;
      found.callAction = r.callAction;
      if (modeChanged && found.state !== 'resolved') {
        console.log(`[reminders] callAction 模式切換(🔔↔📞),重置 phoneCalledAt + state:「${r.text.substring(0, 30)}」`);
        found.phoneCalledAt = undefined;
        found.state = 'pending';
        found.firstSentAt = undefined;
        found.secondSentAt = undefined;
        found.lastFollowupAt = undefined;
        found.followupCount = 0;
        found.pushoverNotifyCount = 0;
        found.inProgressMarkedAt = undefined;
        found.startedAt = undefined;       // v218(C3): 漏清 → cron 678 永久 skip,新模式永不觸發
        found.lastUserActionAt = undefined; // v218(C3): 一併清,避免舊互動值干擾 race 防護
      }
      // 同步更新:時間或文字變了
      const timeChanged = found.startTimeMin !== r.startTimeMin;
      const textChanged = found.text !== r.text;
      if (timeChanged || textChanged) {
        console.log(`[reminders] sync 更新:「${found.text}」→「${r.text}」(time ${found.startTimeMin}→${r.startTimeMin})`);
        found.text = r.text;
        found.startTimeMin = r.startTimeMin;
        found.endTimeMin = r.endTimeMin;
        // 時間變了 → 重置 state 給新時間重新走 T-5/T+15/追殺流程
        if (timeChanged && found.state !== 'resolved') {
          found.state = 'pending';
          found.firstSentAt = undefined;
          found.secondSentAt = undefined;
          found.lastFollowupAt = undefined;
          found.followupCount = 0;
          found.inProgressMarkedAt = undefined;
          found.startedAt = undefined;       // v218(C2): 漏清 → cron 678 永久 skip,改時間後新提醒永不觸發
          found.lastUserActionAt = undefined; // v218(C2): 一併清
        }
      }
    }
  }
  // 反向 sync:KV 有但 Notion 沒了的 → 標 disabled
  // v182: 加保護 — 若 scan 返回 0 件,跳過反向 sync(避免一次性故障大規模誤殺)
  //       原 bug:scan 一次返回空 → 整批 reminders 被標 disabled → forward sync 不會 re-enable(v182 已修)
  if (fromNotion.length === 0) {
    console.warn('[reminders] scan 返回 0 件,跳過反向 sync 避免大規模誤殺(可能是 Notion API 暫時 fail)');
  } else {
    for (const r of merged) {
      if (r.source !== 'notion') continue;
      if (!r.enabled) continue;
      if (r.state === 'resolved') continue;
      if (!fromNotion.find((n) => n.blockId === r.blockId)) {
        r.enabled = false;
        console.log(`[reminders] 反向 sync:Notion 已沒這事項,標 disabled:${r.text.substring(0, 30)}`);
      }
    }
  }

  // 親子提醒(功能 2):把家長指派、今天該觸發的模板物化成 parent_request 提醒(idempotent)
  await materializeAssignedReminders(env, userId, merged, nowMin);

  // 4. 收集這輪要推的(合併成一則訊息)
  const nowMs = Date.now();
  const firstSendBatch: Reminder[] = [];
  const startNotifyBatch: Reminder[] = []; // v110: T+0「現在開始」提醒
  const secondSendBatch: Reminder[] = [];
  const followupBatch: Reminder[] = [];

  for (const r of merged) {
    if (!r.enabled || r.state === 'resolved') continue;
    // v110: state=started — 使用者按「開始做了」→ 完全不推任何提醒(等他自己回完成或修 Notion)
    if (r.state === 'started') continue;
    // v128: 強化 KV race 防護 — startedAt 存在 = user 曾經按過按鈕,任何時候都不推
    //       即使 state 被 race 覆蓋成 first_sent / second_sent 也擋住
    if (r.startedAt) continue;
    // v216: callAction 電話提醒 = 一次性。撥過電話(phoneCalledAt 存在)就視為完成,直接 resolved 並跳過,
    //   絕不進任何追殺/提醒 batch。修「打完電話卡 second_sent → cron 每分鐘無限追殺,
    //   手動標 resolved 又被 cron 整包 save race 蓋回」的事故。每輪都會重新 resolved,race 蓋不回去。
    if (r.callAction && r.phoneCalledAt) {
      r.state = 'resolved';
      r.resolvedAt = new Date().toISOString();
      r.resolvedReason = 'skipped'; // 電話一次性,撥過即視為處理掉
      continue;
    }
    // v217: 絕對追殺封頂 — 不分等級/來源,追殺達 ABSOLUTE_FOLLOWUP_CAP 次強制完成。
    //   防一切無限追殺的最後兜底(未知 race / 空 blockId 判不出完成 / standard 無上限,這都擋得住)。
    if ((r.followupCount ?? 0) >= ABSOLUTE_FOLLOWUP_CAP) {
      r.state = 'resolved';
      r.resolvedAt = new Date().toISOString();
      r.resolvedReason = 'skipped';
      console.warn(`[reminders] 達絕對追殺上限 ${ABSOLUTE_FOLLOWUP_CAP} 次,強制停:「${r.text.substring(0, 20)}」`);
      continue;
    }
    // v218(E1): 過期作廢 — 第一次推送後超過 FOLLOWUP_EXPIRE_HOURS 還沒解決 → 自動 resolved。
    //   擋「跨午夜/靜音 count 凍結 → 隔天追昨晚過期任務」(次數封頂在 count 凍結時擋不住,但時長一定會到)。
    if (r.firstSentAt && (nowMs - new Date(r.firstSentAt).getTime()) > FOLLOWUP_EXPIRE_MS) {
      r.state = 'resolved';
      r.resolvedAt = new Date().toISOString();
      r.resolvedReason = 'skipped';
      console.warn(`[reminders] 提醒過期(推送後超過 ${FOLLOWUP_EXPIRE_HOURS}h),自動作廢:「${r.text.substring(0, 20)}」`);
      continue;
    }
    // v127→v128: lastUserActionAt skip window 從 60 秒拉到 30 分鐘(cover T-5~T+15 整個週期)
    if (r.lastUserActionAt) {
      const sinceUserAction = (nowMs - new Date(r.lastUserActionAt).getTime()) / 1000;
      if (sinceUserAction < 1800) continue;
    }
    // 親子提醒(功能 2):parent_request(家長設)/ self(自己設)走專屬投遞(不碰 Notion 完成檢查)
    if (r.source === 'parent_request' || r.source === 'self') {
      await handleParentRequestReminder(env, userId, r, nowMin);
      continue;
    }
    const delta = r.startTimeMin - nowMin;
    // v211: 提醒時序可調(per-user preferences)
    const leadMin = prefs.reminderLeadMin ?? 5;            // 工作開始前提前幾分鐘提醒
    const startNotifyOn = prefs.reminderStartNotify !== false; // 到點是否再提醒一次
    const checkAfterMin = prefs.reminderCheckAfterMin ?? 15;   // 開始後幾分鐘檢測

    // 階段 1:推第一次 — 提前 leadMin 分內 OR 已過。cron 每分鐘跑,不需緩衝
    // v214: callAction(到點打電話)要在「使用者講的那個時間」打,不提前 leadMin → 用 delta <= 0
    const firstSendThreshold = r.callAction ? 0 : leadMin;
    if (r.state === 'pending' && delta <= firstSendThreshold) {
      firstSendBatch.push(r);
      continue;
    }

    // 階段 1.5(v110):T+0「現在開始」提醒 — first_sent 期間 + delta 落在 0~-1 + 還沒推過 + 設定開啟
    if (startNotifyOn && r.state === 'first_sent' && delta <= 0 && delta >= -1 && !r.startNotifiedAt) {
      startNotifyBatch.push(r);
      continue;
    }

    // v131/v211: 開始後 checkAfterMin 分檢測 — 沒動就切 second_sent 進追殺(不再推 T+15 訊息)。
    //   改用 delta <= -checkAfterMin(不設下界):避免 cron 剛好錯過那一分鐘窗 → 卡在 first_sent 永不檢測。
    //   state 轉成 second_sent 後 first_sent 條件不再成立,不會重複觸發。
    if (checkAfterMin > 0 && r.state === 'first_sent' && delta <= -checkAfterMin) {
      const check = await checkBlockStatus(env, r.blockId, r.text);
      if (check.status === 'checked' || check.status === 'deleted') {
        r.state = 'resolved';
        r.resolvedAt = new Date().toISOString();
        r.resolvedReason = check.status === 'checked' ? 'notion_checked' : 'skipped';
        continue;
      }
      if (check.status === 'modified' && check.currentText) {
        console.log(`[reminders] block ${r.blockId.substring(0, 8)} 文字 modified,同步:「${r.text}」→「${check.currentText}」`);
        r.text = check.currentText;
      }
      // v131: 直接切 second_sent,不推「⏰ 還沒動」訊息,等下次 cron 開始溫和追殺
      r.state = 'second_sent';
      r.secondSentAt = new Date().toISOString();
      continue;
    }

    // 階段 2.5:awaiting_reason — 使用者跳過沒給原因 → 每 1 分追問 + 告知花錢(v110:5→1 分)
    if (r.state === 'awaiting_reason') {
      // v151: off 等級 / 不打擾時段內 → skip
      if (isFollowupOff(followupLevel) || inQuietHours) {
        continue;
      }
      const lastFollowup = r.lastFollowupAt
        ? new Date(r.lastFollowupAt).getTime()
        : new Date().getTime();
      const minsSinceLast = (nowMs - lastFollowup) / 60000;
      if (minsSinceLast >= 0.5) {
        followupBatch.push(r); // 共用 followup batch
      }
      continue;
    }

    // 階段 3:第二次後每 1 分鐘追殺 — 檢查 Notion → 仍未動就推下一次(v110:5→1 分)
    if (r.state === 'second_sent') {
      // v151: 等級 off 完全不追;不打擾時段內也不追
      if (isFollowupOff(followupLevel) || inQuietHours) {
        continue;
      }
      // v151: lite 等級追殺上限 3 次後停
      const maxCount = getFollowupMaxCount(followupLevel);
      if (maxCount !== null && (r.followupCount ?? 0) >= maxCount) {
        continue;
      }
      const lastFollowup = r.lastFollowupAt
        ? new Date(r.lastFollowupAt).getTime()
        : new Date(r.secondSentAt!).getTime();
      const minsSinceLast = (nowMs - lastFollowup) / 60000;
      // v151: 一般追殺間隔依等級(lite 10 分 / 其餘 0.5 分);in_progress 標記後改 15 分鐘(給時間)
      // 註:按「▶ 開始做了」按鈕走 state=started 直接停追殺,跟 in_progress 不同層級
      const minInterval = r.inProgressMarkedAt ? 14.5 : getFollowupInterval(followupLevel);
      if (minsSinceLast >= minInterval) {
        const check = await checkBlockStatus(env, r.blockId, r.text);
        if (check.status === 'checked' || check.status === 'deleted') {
          // v120: checked / deleted 才當完成
          r.state = 'resolved';
          r.resolvedAt = new Date().toISOString();
          r.resolvedReason = check.status === 'checked' ? 'notion_checked' : 'skipped';
          continue;
        }
        if (check.status === 'modified' && check.currentText) {
          // v120: 文字改了 → 同步 reminder.text + 繼續追殺
          console.log(`[reminders] block ${r.blockId.substring(0, 8)} 文字 modified(追殺中),同步:「${r.text}」→「${check.currentText}」`);
          r.text = check.currentText;
        }
        followupBatch.push(r);
      }
    }
  }

  // v214: 把「到點要打電話」的 reminder 從一般 LINE 推送 batch 拆出來(判斷放在呼叫端)。
  //        callAction reminder = 來源「X點打給我」指令 or Notion 📞 符號 → 到點用人聲念內容,而非推 LINE。
  const callBatch = firstSendBatch.filter((r) => r.callAction === true);
  const lineFirstBatch = firstSendBatch.filter((r) => r.callAction !== true);

  // v215 整合A: 到點打電話念內容(callAction)— 一筆一通,不合併。
  //   流程改動(合併 reviewer 靜音/狀態/race + 使用者「撥完繼續追」):
  //   1. 靜音時段內 → 不撥電話(跳過,等非靜音再撥),避免半夜吵 → 仍維持 pending 等下一輪 cron。
  //   2. 非靜音 → placeCall;成功設 phoneCalledAt 防重撥;撥完(不管成敗)狀態進 second_sent 讓追殺迴圈接手 —
  //      **不再標 resolved**(使用者要:打完電話後繼續追到他真的處理)。
  //   3. 撥完立即 saveReminders(防 cron 中途當掉 phoneCalledAt 丟失 → 重複撥)。
  for (const r of callBatch) {
    // 念出內容:去掉 🔔/📞 + 開頭時間字串,只留要做的事
    let spoken = r.text.replace(/🔔/g, '').replace(/📞/g, '').trim();
    const startStr = formatTime(r.startTimeMin);
    const shortStart = startStr.replace(/^0/, '');
    if (spoken.startsWith(startStr)) spoken = spoken.slice(startStr.length).trim();
    else if (spoken.startsWith(shortStart)) spoken = spoken.slice(shortStart.length).trim();
    // v219: 查詢型(queryPlan)→ 到點讀 Notion 今天/明天計畫 + Haiku 濃縮念稿;否則念字面提醒。
    let callMsg: string;
    if (r.queryPlan) {
      callMsg = await generatePlanCallScript(env, userId, r.queryPlan);
    } else {
      // 念稿前綴(讓接電話的人知道是提醒)— 內容本身已是使用者寫的事項
      callMsg = spoken ? `提醒你,${spoken}` : '你有一則提醒到時間了';
    }

    // v215 靜音時段內 → 不撥電話,保持 pending 等下一輪非靜音時段再撥(避免半夜吵)
    if (await isSilentNow(env, userId)) {
      console.log(`[reminders] callAction 靜音中,跳過撥號(維持 pending 等非靜音):「${callMsg}」`);
      continue;
    }

    if (isTwilioConfigured(env) && !r.phoneCalledAt) {
      const callRes = await placeCall(env, callMsg);
      if (callRes.ok) {
        r.phoneCalledAt = Date.now();
        console.log(`[reminders] callAction 到點撥號:「${callMsg}」`);
      } else {
        console.warn(`[reminders] callAction 撥號失敗:${callRes.error} → fallback 推 LINE`);
        // Twilio 撥號失敗 → 退回推 LINE 避免漏提醒(仍進追殺)
        await pushLineMessage(env, userId, `☎️→💬 電話沒打通,改用訊息提醒你:\n${spoken || r.text}`);
      }
    } else {
      // 沒設 Twilio(學員)/ 已撥過 → 退回推 LINE,確保提醒不漏(仍進追殺)
      await pushLineMessage(env, userId, `🔔 提醒:${spoken || r.text}`);
    }
    // v216: 到點 callAction 電話 = 一次性,撥完即結束(resolved),不進追殺迴圈。
    //   理由:電話已是最強介入(響鈴+人聲);打完還每分鐘追殺、又把「查詢型」當任務催
    //   (「你準備怎麼開始?」)體驗極差。真正的「追殺電話」(followup 那條)才繼續追;
    //   這條是主動指定 / Notion 📞 的一次性電話,打完就關。
    r.state = 'resolved';
    r.totalPushCount = (r.totalPushCount ?? 0) + 1;
    // v215 reviewer #3 race:撥完立即存 KV,防 cron 中途當掉 phoneCalledAt 丟失重撥
    await saveReminders(env, userId, merged);
  }

  // 推第一次提醒(合併成一則,文字依 delta 動態)
  if (lineFirstBatch.length > 0) {
    const msgId = await pushFirstReminderBatch(env, userId, lineFirstBatch, nowMin);
    // 只在 single 場景記 reminderId(multi 會被覆蓋,改靠原文反查)
    if (lineFirstBatch.length === 1 && msgId) {
      await rememberPushedMsg(env, msgId, lineFirstBatch[0].id);
    }
    for (const r of lineFirstBatch) {
      r.state = 'first_sent';
      r.firstSentAt = new Date().toISOString();
      r.totalPushCount = (r.totalPushCount ?? 0) + 1;
      // v166: 全開模式 — T-5 第一次提醒就走 Pushover priority 1(原本只有 T+0 / 追殺 才推 Pushover)
      if (pushoverAllActive) {
        const clean = r.text.replace(/🔔/g, '').trim();
        await tryPushoverNotify(env, userId, '⏰ 提醒(T-5)', clean, 1);
      }
    }
  }

  // v110: 推 T+0「現在開始」提醒(在 first_sent 期間額外推一次,不切 state)
  for (const r of startNotifyBatch) {
    const msgId = await pushStartNotification(env, userId, r);
    r.startNotifiedAt = new Date().toISOString();
    r.totalPushCount = (r.totalPushCount ?? 0) + 1;
    if (msgId) await rememberPushedMsg(env, msgId, r.id);
    // v136: 同步 Pushover — T+0 普通優先級(出聲但遵守 quiet hours,不到緊急程度)
    // v166: 全開模式 — T+0 升 priority 1,鎖屏 / 靜音也響
    const clean = r.text.replace(/🔔/g, '').trim();
    await tryPushoverNotify(env, userId, '原訂時間到', clean, pushoverAllActive ? 1 : 0);
  }

  // v131: 移除 T+15 第二次提醒 push(user 嫌冗餘)
  //       state 已在 state machine 內切到 second_sent,進入追殺迴圈
  if (false && secondSendBatch.length > 0) {
    // dead code 保留以備未來恢復
    const msgId = await pushSecondReminderBatch(env, userId, secondSendBatch, nowMin);
    if (secondSendBatch.length === 1 && msgId) {
      await rememberPushedMsg(env, msgId, secondSendBatch[0].id);
    }
    for (const r of secondSendBatch) {
      r.state = 'second_sent';
      r.secondSentAt = new Date().toISOString();
      r.totalPushCount = (r.totalPushCount ?? 0) + 1;
      const clean = r.text.replace(/🔔/g, '').trim();
      // v136: T+15 高優先(突破勿擾,但不到 Emergency 反覆重試)
      await tryPushoverNotify(env, userId, '⚠ 還沒動 (T+15)', clean, 1);
    }
  }

  // v211: 推追殺前再讀一次最新 KV — 防 race clobber。
  //   情境:這輪 cron 在 load→處理 的期間,user 剛說「正在做了/完成」把 state 改成 started/resolved,
  //   舊版會拿著載入當下的舊狀態繼續追殺、最後 save 又把整包蓋回去(連 startedAt 一起洗掉)→ 追殺停不了。
  //   解法:推之前重讀,user 已動過的(started/resolved/有 startedAt/30 分內動過)→ 不追,並用最新版回填 merged 不蓋掉。
  let freshById: Record<string, any> = {};
  try {
    for (const fr of await loadReminders(env, userId)) freshById[fr.id] = fr;
  } catch {}
  const userActedSince = (id: string): boolean => {
    const f = freshById[id];
    if (!f) return false;
    if (f.state === 'started' || f.state === 'resolved' || f.startedAt) return true;
    if (f.lastUserActionAt && (nowMs - new Date(f.lastUserActionAt).getTime()) < 1800 * 1000) return true;
    return false;
  };
  const followupToPush = followupBatch.filter((r) => {
    if (userActedSince(r.id)) {
      const idx = merged.findIndex((m) => m.id === r.id);
      if (idx >= 0 && freshById[r.id]) merged[idx] = freshById[r.id]; // 用最新版回填,save 時不蓋掉 user 更新
      console.log(`[reminders] race 防護:user 剛動過 ${r.id.substring(0, 8)},跳過追殺`);
      return false;
    }
    return true;
  });

  // v110: 追殺提醒(每 1 分鐘,含成本告知 — 心理壓力反拖延)
  for (const r of followupToPush) {
    r.followupCount = (r.followupCount ?? 0) + 1;
    r.totalPushCount = (r.totalPushCount ?? 0) + 1;
    const msgId = await pushFollowupReminder(env, userId, r, nowMin);
    r.lastFollowupAt = new Date().toISOString();
    await rememberPushedMsg(env, msgId, r.id);
    // v151: 同步 Pushover — Emergency 起點依等級(aggressive=1,其他=3)
    // v165: priority 2→1 — Critical Alerts for high-priority 也能突破靜音,且不 retry = 跟追殺 1:1 響 1 次
    //       原 priority 2 + retry 30/30 會每分鐘響 2 次,過於擾人
    // v166: 全開模式 — emergencyStart 強制 1,追殺第一次就響(不看 aggressive level)
    const emergencyStart = pushoverAllActive ? 1 : getEmergencyStartCount(followupLevel);
    if ((r.followupCount ?? 0) >= emergencyStart) {
      const clean = r.text.replace(/🔔/g, '').trim();
      await tryPushoverNotify(env, userId, `🚨 追殺 ${r.followupCount} 次`, clean, 1);
      // v215 整合B: 每推一次 Pushover priority 1 → pushoverNotifyCount +1。
      //   追殺電話門檻改用這個相對值(響滿 3 次才打),不再寫死 followupCount=6。
      r.pushoverNotifyCount = (r.pushoverNotifyCount ?? 0) + 1;
    }

    // v215 整合B: 追殺電話升級 — 改用相對門檻「Pushover priority 1 響滿 PHONE_CALL_AT_PUSHOVER 次」。
    //        理由(使用者調整②):不管追殺等級(lite/standard/aggressive 起點不同),只要 Pushover 真的響滿 3 次
    //        都叫不動 → 升級打電話。比寫死 followupCount=6 更貼近「LINE/Pushover 都失效」的真實訊號。
    //        加 isSilentNow:靜音時段內不撥電話(避免半夜吵),等非靜音時段 Pushover 計數仍滿時再撥。
    //        phoneCalledAt 防重撥。學員沒設 Twilio → isTwilioConfigured false 自動 skip。
    if (
      (r.pushoverNotifyCount ?? 0) >= PHONE_CALL_AT_PUSHOVER &&
      isTwilioConfigured(env) &&
      !r.phoneCalledAt &&
      !(await isSilentNow(env, userId))
    ) {
      const cleanForCall = r.text.replace(/🔔/g, '').replace(/📞/g, '').trim();
      const script = await generatePhoneCallScript(env, userId, cleanForCall);
      const callRes = await placeCall(env, script);
      if (callRes.ok) {
        r.phoneCalledAt = Date.now();
        console.log(`[reminders] 追殺電話已撥(Pushover 已響 ${r.pushoverNotifyCount} 次):「${script}」`);
      } else {
        console.warn(`[reminders] 追殺電話撥打失敗:${callRes.error}`);
      }
    }
  }

  // 5. v130: 只在實際有變更時儲存(降低跟 user action 的 race window)
  //    沒推 push、沒 sync 變更 → skip save 完全不寫 KV
  const hasChange = firstSendBatch.length > 0 || startNotifyBatch.length > 0
    || secondSendBatch.length > 0 || followupBatch.length > 0
    || JSON.stringify(merged) !== originalSnapshot;
  if (hasChange) {
    await saveReminders(env, userId, merged);
  }
}

// 文字依 delta 動態:未來 → 「X 分鐘後」/ 現在 → 「現在」/ 已過 → 「已過 X 分鐘」
function timeRelText(r: Reminder, nowMin: number): string {
  const cleanText = r.text.replace(/🔔/g, '').trim();
  const delta = r.startTimeMin - nowMin;
  if (delta > 2) return `🔔 ${delta} 分鐘後:${cleanText}`;
  if (delta >= -2) return `🔔 現在:${cleanText}`;
  return `⏰ ${cleanText}(已過 ${-delta} 分鐘)`;
}

// 隨機回覆例句變體(反肌肉記憶 — 每次例句不同)
const STARTED_VARIANTS = [
  '「14:00 已開工」', '「動手了 14:00」', '「現在做 14:00」',
  '「14:00 開始」', '「我開工了 14:00」', '「14:00 上工」',
];
const POSTPONE_VARIANTS = [
  '「延後 14:00 15 分」', '「14:00 推 20 分」', '「14:00 延 30 分」',
  '「14:00 改 14:30」', '「晚 15 分 14:00」',
];
const SKIP_VARIANTS = [
  '「跳過 14:00 在發燒」', '「不做 14:00 行程取消」', '「14:00 跳掉,改明天」',
  '「14:00 取消 沒空」', '「不去 14:00 改時間」',
];
const DONE_VARIANTS = [
  '「已完成」', '「做完了」', '「OK 了」', '「搞定」', '「處理好了」',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomExamples(t: string): string[] {
  // 把例句裡的 14:00 換成實際時間
  const ex = [
    pick(STARTED_VARIANTS).replace(/14:00/g, t),
    pick(POSTPONE_VARIANTS).replace(/14:00/g, t).replace(/14:30/g, ''),
    pick(SKIP_VARIANTS).replace(/14:00/g, t),
    pick(DONE_VARIANTS),
  ];
  // 4 個隨機抽 3 個
  return ex.sort(() => Math.random() - 0.5).slice(0, 3);
}

async function pushFirstReminderBatch(
  env: Env,
  userId: string,
  reminders: Reminder[],
  nowMin: number
): Promise<string | null> {
  if (await isSilentNow(env, userId)) {
    console.log(`[reminder] 靜音中,跳過 ${reminders.length} 個第一次提醒`);
    return null;
  }

  // 單筆 → 含完整上下文 + 隨機例句(反肌肉記憶,無按鈕)
  if (reminders.length === 1) {
    const r = reminders[0];
    const cleanText = r.text.replace(/🔔/g, '').trim();
    const t = formatTime(r.startTimeMin);
    const delta = r.startTimeMin - nowMin;

    let header: string;
    let body: string;
    if (delta > 2) {
      header = `🔔 ${delta} 分鐘後:${cleanText}`;
      body = `原訂時間:${t}`;
    } else if (delta >= -2) {
      header = `🔔 現在:${cleanText}`;
      body = `原訂時間:${t} 該開始了`;
    } else {
      const over = -delta;
      header = `⏰ ${cleanText}(已過 ${over} 分鐘)`;
      body = `原訂 ${t},超過 ${over} 分鐘還沒勾`;
    }

    const examples = randomExamples(t);
    const text = [
      header,
      '━━━━━━━━━━━━',
      body,
      '',
      '直接打字告訴我狀況(怎麼說都行,我聽得懂):',
      ...examples.map((e) => `  ${e}`),
      '  ↑ 例句僅供參考,你想怎麼講就怎麼講',
      '',
      '或按下面「開始做了」我就不再追殺;按「⏰ 延後」可延 10 / 30 分鐘',
    ].join('\n');
    // v110: 第一次提醒加「▶ 開始做了」按鈕(C 方案 + X 選項:按 → state=started → 停追殺)
    // v178: 加「⏰ 延後」按鈕,點開展開「延後 10 / 30 分鐘」二層選單
    const quickReply = {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '▶ 開始做了',
            data: `action=start&id=${r.id}`,
            displayText: '開始做了',
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '⏰ 延後',
            data: `action=postpone-menu&id=${r.id}`,
            displayText: '延後',
          },
        },
      ],
    };
    return await pushLineMessage(env, userId, text, quickReply);
  }

  // 多筆 → 合併成一則(無按鈕,隨機例句;多筆狀況下沒辦法用單顆按鈕標記某筆,只能打字)
  const lines: string[] = [`🔔 提醒 (${reminders.length} 件)`, '━━━━━━━━━━━━'];
  reminders.sort((a, b) => a.startTimeMin - b.startTimeMin);
  for (const r of reminders) {
    lines.push(timeRelText(r, nowMin));
  }
  // 取第一筆時間做例句
  const firstT = formatTime(reminders[0].startTimeMin);
  const examples = randomExamples(firstT);
  lines.push('━━━━━━━━━━━━');
  lines.push('直接打字逐筆告訴我狀況(怎麼說都行):');
  for (const e of examples) lines.push(`  ${e}`);
  lines.push('  ↑ 例句僅供參考,你想怎麼講就怎麼講');
  lines.push('');
  lines.push('(多筆無法用單顆按鈕標記,只能打字 — 每筆要分別回應)');
  return await pushLineMessage(env, userId, lines.join('\n'));
}

// v110: T+0「現在開始」提醒 — 任務原訂時間到了,額外推一次,附「▶ 開始做了」按鈕
async function pushStartNotification(
  env: Env,
  userId: string,
  r: Reminder
): Promise<string | null> {
  if (await isSilentNow(env, userId)) {
    console.log(`[reminder] 靜音中,跳過 T+0 提醒:${r.text}`);
    return null;
  }

  const cleanText = r.text.replace(/🔔/g, '').trim();
  const t = formatTime(r.startTimeMin);
  const text = [
    `▶ ${t} 開始:${cleanText}`,
    '━━━━━━━━━━━━',
    '原訂時間到了 — 現在開始吧',
    '',
    '按下面「開始做了」我就不再追殺;按「⏰ 延後」可延 10 / 30 分鐘',
    '(若已經結束:打字告訴我「完成」)',
  ].join('\n');

  const quickReply = {
    items: [
      {
        type: 'action',
        action: {
          type: 'postback',
          label: '▶ 開始做了',
          data: `action=start&id=${r.id}`,
          displayText: '開始做了',
        },
      },
    ],
  };

  return await pushLineMessage(env, userId, text, quickReply);
}

// 追殺提醒 — v110:每 1 分鐘一次(原 5 分),含成本告知
const COST_PER_PUSH_NTD = 0.13; // NT$800/月 ÷ 6000 則

// v215 整合B: 追殺電話門檻 — 改用「Pushover priority 1 響滿幾次」相對值(取代寫死的 followupCount=6)。
//        理由:不同追殺等級 Pushover 起點不同(aggressive 第 1 次就響、standard 第 3 次才響),
//        用 followupCount 寫死會讓 lite/standard 太晚或太早打。改數「真的響滿幾次」更貼近「都叫不動」訊號。
//        可調:數字越小越早打電話。預設 3 = Pushover 真的響過 3 次都沒反應才升級成電話。
const PHONE_CALL_AT_PUSHOVER = 3;
// v217: 絕對追殺封頂 — 任何提醒(不分等級/來源)追殺達此次數,強制停止(標 resolved)。
//   這是「防一切無限追殺」的最後兜底保險:即使有未知 race / 空 blockId 判不出完成 /
//   standard·aggressive 等級 maxCount=null 無上限,這道閘都擋得住。
//   30 次 ≈ standard 等級每分鐘追算 30 分鐘 — 半小時還叫不動,再追也沒意義。
const ABSOLUTE_FOLLOWUP_CAP = 30;
// v218(E1): 提醒過期作廢 — 第一次推送後超過此時數還沒解決 → 自動 resolved。
//   補「次數封頂」的缺口:跨午夜/靜音期間 followupCount 凍結,次數封頂擋不住,但時長一定會到。
//   用 firstSentAt(絕對時間戳)判,避開 startTimeMin 當日分鐘跨日失真。
const FOLLOWUP_EXPIRE_HOURS = 6;
const FOLLOWUP_EXPIRE_MS = FOLLOWUP_EXPIRE_HOURS * 3600 * 1000;

// v214: 用 Haiku 生成「電話念出的」超短語音文字(≤10 字、口語、直接講要做的事)
//        失敗 → fallback 簡單模板「該做 {事項} 了」
// v219: 查詢型電話念稿 — 讀 Notion 今天/明天計畫 → Haiku 濃縮成一句口語電話念稿。
//   失敗(契約缺/Notion 掛/Haiku 失敗)一律 fallback 到機械組裝或泛用句,確保有東西念、不會撥空電話。
async function generatePlanCallScript(env: Env, userId: string, when: 'today' | 'tomorrow'): Promise<string> {
  const whenLabel = when === 'today' ? '今天' : '明天';
  try {
    const c = await getContract(env, userId);
    if (!c) return `提醒你查看${whenLabel}的工作計畫`;
    const report = await getTomorrowReport(env, {
      todayPagePageId: c.todayPlanPageId,
      futurePlanBlockId: c.futurePlanBlockId,
      dailyFixedBlockId: c.dailyFixedBlockId,
      monthlyFixedBlockId: c.monthlyFixedBlockId,
      recurringBlockId: c.recurringBlockId,
      offsetDays: when === 'today' ? 0 : 1,
    });
    const items = [...report.byTime.map((x) => x.text), ...report.noTime.map((x) => x.text)];
    if (items.length === 0) return `你${whenLabel}沒有排工作`;
    const mechanical = `你${whenLabel}有 ${items.length} 件事,${items.slice(0, 4).join('、')}`;
    const sys = [
      '你在生成一句「用電話念出來」的工作摘要,對方接起電話會聽到 TTS 念這句話。',
      '硬規則:',
      '1. 簡短口語、像真人秘書,30 字內最好,最多不超過 50 字',
      `2. 開頭講「你${whenLabel}有 N 件事」,再念重點(原本有時間的就帶上時間)`,
      '3. 不要任何符號 / emoji / 編號 / 引號,純口語一段話',
      '4. 只回那句話本身,不要前言或結尾',
    ].join('\n');
    const usr = `${whenLabel}的工作清單(共 ${items.length} 件):\n${items.join('\n')}\n\n請濃縮成一句電話念稿。`;
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 120,
        system: sys,
        messages: [{ role: 'user', content: usr }],
      }),
    });
    if (!resp.ok) {
      console.warn('[plan-call-script] Haiku failed', resp.status);
      return mechanical;
    }
    const d: any = await resp.json();
    try {
      const u = d.usage || {};
      const cost = calculateClaudeCost('claude-haiku-4-5', u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0);
      await logCost(env, {
        userId, service: 'anthropic', operation: 'plan-call-script',
        model: 'claude-haiku-4-5',
        inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
        cachedTokens: u.cache_read_input_tokens ?? 0, costUsd: cost,
        taskContext: 'plan-call-script',
      });
    } catch (e) { console.warn('[plan-call-script] logCost failed', e); }
    const text = (d.content?.[0]?.text ?? '').replace(/["'「」]+/g, '').trim();
    return text || mechanical;
  } catch (e) {
    console.warn('[plan-call-script] exception', e);
    return `提醒你查看${whenLabel}的工作計畫`;
  }
}

async function generatePhoneCallScript(
  env: Env,
  userId: string,
  cleanText: string
): Promise<string> {
  const fallback = `該做${cleanText}了`;
  const sys = [
    '你在生成一句「用電話念出來」的語音提醒。對方接起電話會聽到 TTS 念這句話。',
    '硬規則:',
    '1. 極短:10 個字以內(中文字),一句話',
    '2. 口語、像真人催你,不要任何符號、不要 emoji、不要標點以外的東西',
    '3. 直接講「要做的那件事」,不要寒暄、不要「提醒你」這種冗詞',
    '4. 只回那句話本身,不要前言/引號/結尾',
  ].join('\n');
  const usr = `要催的事項:${cleanText}\n請生成一句 10 字內、用電話念出來的催促語。`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 40,
        system: sys,
        messages: [{ role: 'user', content: usr }],
      }),
    });
    if (!r.ok) {
      console.warn('[phone-script] Haiku failed', r.status);
      return fallback;
    }
    const d: any = await r.json();
    try {
      const u = d.usage || {};
      const cost = calculateClaudeCost(
        'claude-haiku-4-5',
        u.input_tokens ?? 0,
        u.output_tokens ?? 0,
        u.cache_read_input_tokens ?? 0,
        u.cache_creation_input_tokens ?? 0,
      );
      await logCost(env, {
        userId, service: 'anthropic', operation: 'phone-script',
        model: 'claude-haiku-4-5',
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cachedTokens: u.cache_read_input_tokens ?? 0,
        costUsd: cost,
        taskContext: 'phone-script',
      });
    } catch (e) { console.warn('[phone-script] logCost failed', e); }
    const text = (d.content?.[0]?.text ?? '').replace(/["'「」。!?,、\s]+$/g, '').trim();
    return text || fallback;
  } catch (e) {
    console.warn('[phone-script] exception', e);
    return fallback;
  }
}

// v121: Haiku 即時生成追殺訊息正文(反肌肉記憶)
// — 每次切不同角度、要求不同回覆方式、依次數遞增強度
// — 給「過往講過什麼」當 context 防重複
// — 失敗時 fallback 到舊模板
async function generateFollowupStrength(
  env: Env,
  userId: string,
  cleanText: string,
  startHHMM: string,
  overMin: number,
  fcount: number,
  history: string[]
): Promise<string | null> {
  const intensity =
    fcount >= 8 ? '尖銳直接,有點怒氣,但仍給出路(完成/跳過)' :
    fcount >= 5 ? '硬,點出他在燒錢,要他選一條路' :
    fcount >= 3 ? '中等,點出已拖很久,問是否卡住' :
                  '溫和但堅定,引導下一個動作';

  const sys = [
    '你是 LINE bot 的追殺訊息生成器。對方是拖延症 + 疑似 ADHD 的使用者,他自己排好任務 🔔 但拖著沒做。',
    '你的工作:每次生成不同角度的催促文字,逼他無法用「肌肉記憶」自動跳過。',
    '',
    '硬規則:',
    '1. 不要重複過往講過的角度、比喻、語氣(見「過往」清單)',
    '2. 每次要「要求他用不同的方式回應」,不要每次都「請回好」「按按鈕」 — 創意點:',
    '   - 寫下一個動作 / 給時間估計 / 列卡住點 / 罵自己一句 / 用一句話交代狀況 / 等',
    '3. 不要用 emoji(他不喜歡)。功能性符號 ✓✗ ⚠ 可以',
    '4. **極短:一句話、20~35 字以內、不要分行。使用者懶得看長訊息,寧可精簡有力、一句戳中,不要長篇大論**',
    '5. 不要寫「第 N 次追殺」開頭(系統會附加)',
    '6. 不要提「解決方式」清單(系統會附加)',
    '7. 強度:' + intensity,
    '8. 只回正文,不要前言/結尾',
  ].join('\n');

  const histPart = history.length > 0
    ? `過往這筆追殺講過(別重複角度/句型):\n${history.slice(-5).map((h, i) => `${i + 1}. ${h}`).join('\n')}`
    : '(這是第一次追殺,先溫和切入)';

  const usr = [
    `事項:${cleanText}`,
    `原訂時間:${startHHMM}`,
    `已過:${overMin} 分鐘`,
    `這是第 ${fcount} 次追殺`,
    '',
    histPart,
    '',
    '請生成這次的催促文字。',
  ].join('\n');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        system: sys,
        messages: [{ role: 'user', content: usr }],
      }),
    });
    if (!r.ok) {
      console.warn('[followup-gen] Haiku failed', r.status);
      return null;
    }
    const d: any = await r.json();
    // 記成本
    try {
      const u = d.usage || {};
      const cost = calculateClaudeCost(
        'claude-haiku-4-5',
        u.input_tokens ?? 0,
        u.output_tokens ?? 0,
        u.cache_read_input_tokens ?? 0,
        u.cache_creation_input_tokens ?? 0,
      );
      await logCost(env, {
        userId, service: 'anthropic', operation: 'followup-gen',
        model: 'claude-haiku-4-5',
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cachedTokens: u.cache_read_input_tokens ?? 0,
        costUsd: cost,
        taskContext: 'followup-gen',
      });
    } catch (e) { console.warn('[followup-gen] logCost failed', e); }
    const text = (d.content?.[0]?.text ?? '').trim();
    return text || null;
  } catch (e) {
    console.warn('[followup-gen] exception', e);
    return null;
  }
}

async function pushFollowupReminder(
  env: Env,
  userId: string,
  r: Reminder,
  nowMin: number
): Promise<string | null> {
  if (await isSilentNow(env, userId)) {
    console.log(`[reminder] 靜音中,跳過追殺:${r.text}`);
    return null;
  }

  const cleanText = r.text.replace(/🔔/g, '').trim();
  const overMin = nowMin - r.startTimeMin;
  const fcount = (r.followupCount ?? 0);
  const totalPushes = r.totalPushCount ?? 0;
  const totalCostNtd = (totalPushes * COST_PER_PUSH_NTD).toFixed(2);
  const thisCostNtd = COST_PER_PUSH_NTD.toFixed(2);
  const startHHMM = formatTime(r.startTimeMin);

  // v121: 訊息強度 — 兩條特殊情境保留模板,一般追殺改 Haiku 即時生成
  let strength: string | null = null;

  if (r.state === 'awaiting_reason') {
    // 跳過沒給原因 → 維持原本模板(這是「問原因」不是「催做」)
    strength = `第 ${fcount} 次問:「${cleanText}」為什麼跳過?\n你按了「跳過」但沒說原因。\n不講原因 = 不算誠實面對 = 我會一直問,直到你說為止。`;
  } else if (r.inProgressMarkedAt) {
    // 跨任務 check(legacy 路徑,v119 後新流程不會走這)
    const minsSinceInProgress = Math.floor((Date.now() - new Date(r.inProgressMarkedAt).getTime()) / 60000);
    strength = `你 ${minsSinceInProgress} 分鐘前說「在做了」,但 Notion 還沒勾。真的有做嗎?\n完成了打字告訴我「已完成」我幫你勾。\n還沒完成就打字告訴我新狀況。`;
  } else {
    // 一般追殺 → Haiku 即時生成(反肌肉記憶)
    strength = await generateFollowupStrength(
      env, userId, cleanText, startHHMM, overMin, fcount + 1,
      r.followupHistory ?? []
    );
    // Haiku 失敗 → fallback 到舊模板
    if (!strength) {
      strength =
        fcount >= 8 ? `已追殺 ${fcount + 1} 次,顯然你不想做。直說「跳過」+ 原因,或打「已完成」。` :
        fcount >= 5 ? `已追殺 ${fcount + 1} 次了。要嘛做,要嘛跳過給原因,別讓我繼續燒你錢追。` :
        fcount >= 3 ? `第 ${fcount + 1} 次追殺,這事情拖很久了。卡住了?需要幫忙?還是該跳過?` :
                      `第 ${fcount + 1} 次追殺。`;
    }
  }

  // v121: 把這次訊息存進 history(取前 80 字,給下次當「別重複」context)
  if (strength) {
    r.followupHistory = [...(r.followupHistory ?? []), strength.substring(0, 80)].slice(-10);
  }

  // v121: 圖示用簡單符號,不依 fcount 階梯(讓「不同」感由 Haiku 文字承載)
  const icon = '⚠';

  // v211: 追殺訊息精簡成 4 行 — 使用者反映舊版太長一串、懶得看。
  //   保留:事項 / 過期+第幾次+累計成本(壓一行) / Haiku 短句 / 一行回應指引。
  //   砍掉:分隔線、多行備用指令清單、兩行成本說明。
  const text = [
    `${icon} ${cleanText} 還沒做`,
    `原訂 ${startHHMM}・過 ${overMin} 分・第 ${fcount + 1} 催・累計 NT$${totalCostNtd}`,
    strength,
    '完成打「已完成」;要延後 / 跳過也直接跟我說',
  ].join('\n');

  return await pushLineMessage(env, userId, text);
}

async function pushSecondReminderBatch(
  env: Env,
  userId: string,
  reminders: Reminder[],
  nowMin: number
): Promise<string | null> {
  if (await isSilentNow(env, userId)) {
    console.log(`[reminder] 靜音中,跳過 ${reminders.length} 筆第二次提醒`);
    return null;
  }

  reminders.sort((a, b) => a.startTimeMin - b.startTimeMin);

  // 單筆 → 簡潔格式
  if (reminders.length === 1) {
    const r = reminders[0];
    const cleanText = r.text.replace(/🔔/g, '').trim();
    const overMin = nowMin - r.startTimeMin;
    const text = [
      `⏰ ${cleanText} 還沒動`,
      '━━━━━━━━━━━━',
      `預定 ${formatTime(r.startTimeMin)},已過 ${overMin} 分鐘`,
      '',
      '發生什麼事?直接打字跟我說。',
      '(這次沒有按鈕,請花一點時間真實回答 — 反拖延設計)',
    ].join('\n');
    return await pushLineMessage(env, userId, text);
  }

  // 多筆 → 合併成一則,但要求逐筆回答
  const lines: string[] = [
    `⏰ ${reminders.length} 件還沒動 — 請逐筆回答`,
    '━━━━━━━━━━━━',
  ];
  reminders.forEach((r, i) => {
    const cleanText = r.text.replace(/🔔/g, '').trim();
    const overMin = nowMin - r.startTimeMin;
    lines.push(`${i + 1}. ${cleanText}(預定 ${formatTime(r.startTimeMin)},已過 ${overMin} 分)`);
  });
  lines.push('━━━━━━━━━━━━');
  lines.push('請打字逐筆告訴我每件的真實狀況');
  lines.push('(不可一句「都在做」帶過,要分別回應 — 反拖延設計)');
  lines.push('');
  lines.push('範例回答:');
  lines.push('「1. 已開始 2. 改延後 30 分」');
  lines.push('「1. 卡住,需要查資料 2. 跳過,改下午再做」');

  return await pushLineMessage(env, userId, lines.join('\n'));
}

async function pushLineMessage(
  env: Env,
  userId: string,
  text: string,
  quickReply?: any
): Promise<string | null> {
  const message: any = { type: 'text', text };
  if (quickReply) message.quickReply = quickReply;
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Line-Retry-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ to: userId, messages: [message] }),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error(`[reminder] push to ${userId.substring(0, 8)} 失敗 status=${r.status}: ${errText.substring(0, 300)}`);
      return null;
    }
    const rawText = await r.text();
    let messageId: string | null = null;
    try {
      const data: any = JSON.parse(rawText);
      messageId = data?.sentMessages?.[0]?.id ?? null;
    } catch {}
    // 順手存原文 → 讓 LINE quote 反查能拿到完整內容
    if (messageId && env.CACHE) {
      try {
        await env.CACHE.put(`pushed-msg-text:${messageId}`, text.substring(0, 1500), {
          expirationTtl: 24 * 3600,
        });
      } catch {}
    }
    console.log(`[reminder] push to ${userId.substring(0, 8)} OK msgId=${messageId} (${text.substring(0, 30)})`);
    return messageId;
  } catch (e) {
    console.error('[reminder] push exception:', e);
    return null;
  }
}

// 存 messageId → reminderId 對照(讓 LINE quote 功能能反查)
async function rememberPushedMsg(
  env: Env,
  messageId: string | null,
  reminderId: string
): Promise<void> {
  if (!messageId || !env.CACHE) return;
  try {
    await env.CACHE.put(`pushed-msg:${messageId}`, reminderId, {
      expirationTtl: 36 * 3600, // 36 小時
    });
  } catch (e) {
    console.warn('[push-map] save failed:', e);
  }
}

/**
 * 晚安總結(每天台北 22:00)
 *
 * 升級版內容:
 * 1. 今日完成 vs 未完成(讀今日計畫 to_do)
 * 2. 今日 bot 動過的 Notion 寫入(沿用 v31)
 * 3. ⚠️ 晚安後是否還有提醒(關鍵安全網,避免人睡了還被吵)
 *    → 列出 22:00 後的提醒,問是否延後 / 取消
 */
// 推理今日 to_do 在哪 — 今日計畫頁優先,沒有就去工作記錄
async function collectTodayTodos(env: Env, userId: string): Promise<{ done: string[]; undone: string[] }> {
  // v220(3c): 今日計畫頁改走 per-user contract
  const TODAY_PAGE_ID = await getTodayPageId(env, userId);
  if (!TODAY_PAGE_ID) return { done: [], undone: [] };
  const now = new Date();
  const tpeDate = new Intl.DateTimeFormat('zh-TW', {
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const shortDay = tpeDate.replace(/^0/, '');

  // 1. 先讀今日計畫頁
  const result = await scanTodosInDateSection(env, TODAY_PAGE_ID, tpeDate, shortDay);
  if (result.found) return result.todos;

  // 2. 找不到 → 去工作記錄:YY/MM
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const workLogTitle = `工作記錄:${yy}/${mm}`;
  console.log(`[evening] 今日計畫沒今天區段,去 ${workLogTitle} 找`);

  // search_notion 找工作記錄頁
  const searchRes = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: workLogTitle,
      page_size: 5,
      filter: { property: 'object', value: 'page' },
    }),
  });
  if (!searchRes.ok) return { done: [], undone: [] };
  const searchData: any = await searchRes.json();
  const workLogPage = (searchData.results || []).find((p: any) => {
    const props = p.properties || {};
    for (const v of Object.values(props) as any[]) {
      if (v?.type === 'title' && v.title?.length > 0) {
        const title = v.title.map((t: any) => t.plain_text).join('');
        if (title.includes(yy + '/' + mm) || title.includes(mm)) return true;
      }
    }
    return false;
  });
  if (!workLogPage) {
    console.log(`[evening] 找不到 ${workLogTitle} 頁面`);
    return { done: [], undone: [] };
  }

  const result2 = await scanTodosInDateSection(env, workLogPage.id, tpeDate, shortDay);
  return result2.todos;
}

async function scanTodosInDateSection(
  env: Env,
  pageId: string,
  tpeDate: string,
  shortDay: string
): Promise<{ found: boolean; todos: { done: string[]; undone: string[] } }> {
  const todos = { done: [] as string[], undone: [] as string[] };
  // 分頁讀(工作記錄可能很長)
  let cursor: string | undefined;
  const all: any[] = [];
  for (let p = 0; p < 5; p++) {
    const url = new URL(`https://api.notion.com/v1/blocks/${pageId}/children`);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    });
    if (!r.ok) break;
    const d: any = await r.json();
    all.push(...(d.results || []));
    if (!d.has_more) break;
    cursor = d.next_cursor;
  }

  // 找今天 heading
  let todayIdx = -1;
  for (let i = 0; i < all.length; i++) {
    if (!all[i].type.startsWith('heading_')) continue;
    const t = (all[i][all[i].type]?.rich_text ?? []).map((x: any) => x.plain_text).join('');
    if (t.includes(tpeDate) || t.includes(shortDay)) { todayIdx = i; break; }
  }
  if (todayIdx === -1) return { found: false, todos };

  let endIdx = all.length;
  for (let i = todayIdx + 1; i < all.length; i++) {
    const b = all[i];
    if (b.type.startsWith('heading_') || b.type === 'child_page' || b.type === 'divider') {
      endIdx = i;
      break;
    }
  }
  for (let i = todayIdx + 1; i < endIdx; i++) {
    const b = all[i];
    if (b.type !== 'to_do') continue;
    const text = (b.to_do?.rich_text ?? []).map((x: any) => x.plain_text).join('').trim();
    if (!text) continue;
    if (b.to_do?.checked) todos.done.push(text);
    else todos.undone.push(text);
  }
  return { found: true, todos };
}

async function runEveningSummary(env: Env, userId: string): Promise<void> {
  console.log('[cron] evening summary v50 (per-user) start');

  // v220(3c): per-user — 只處理傳入的這個 user,不再內部撈全 users 對所有人推。
  //   修「外層 for u of users 又呼叫內層 for user of users」的雙重迴圈 N×N 重複推送 bug。
  const users: Array<{ id: string }> = [{ id: userId }];

  // 讀今日的 to_do 狀態(這個 user 自己的,走 contract)
  // 推理:今日計畫頁找今天 → 找不到就去「工作記錄:YY/MM」找
  let todoStatus = { done: [] as string[], undone: [] as string[] };
  try {
    todoStatus = await collectTodayTodos(env, userId);
  } catch (err) {
    console.warn('[evening] collectTodayTodos failed:', err);
  }

  const writes = await getTodayWrites(env);

  // 對每個 user 組訊息
  for (const user of users) {
    const reminders = await loadReminders(env, user.id);

    // 找「22:00 後還有」的提醒(未 resolved)
    const lateNight = reminders.filter(
      (r) => r.enabled && r.state !== 'resolved' && r.startTimeMin >= 22 * 60
    );

    const lines: string[] = ['🌙 晚安總結', '━━━━━━━━━━━━'];

    // 1. to_do 完成度
    if (todoStatus.done.length + todoStatus.undone.length > 0) {
      const total = todoStatus.done.length + todoStatus.undone.length;
      lines.push(`今日 to-do 完成 ${todoStatus.done.length}/${total}`);
      if (todoStatus.undone.length > 0 && todoStatus.undone.length <= 8) {
        lines.push('未完成:');
        for (const t of todoStatus.undone) lines.push(`  ☐ ${t.substring(0, 50)}`);
      }
      lines.push('');
    }

    // 2. bot 動過的 Notion 寫入
    if (writes.length > 0) {
      lines.push(`今日 bot 寫入 ${writes.length} 筆:`);
      writes.slice(0, 5).forEach((w) => {
        const time = new Date(w.at).toLocaleTimeString('zh-TW', {
          timeZone: env.TIMEZONE || 'Asia/Taipei',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        lines.push(`  • [${time}] ${w.text.substring(0, 40)}`);
      });
      if (writes.length > 5) lines.push(`  ... 共 ${writes.length} 筆,打「今日寫入」看完整`);
      lines.push('');
    }

    // 3. ⚠️ 晚安後是否還有提醒 — 安全網
    if (lateNight.length > 0) {
      lines.push('━━━━━━━━━━━━');
      lines.push('⚠️ 注意:今晚 22:00 後還有提醒');
      lateNight.forEach((r) => {
        const time = `${String(Math.floor(r.startTimeMin / 60)).padStart(2, '0')}:${String(r.startTimeMin % 60).padStart(2, '0')}`;
        const clean = r.text.replace(/🔔/g, '').trim();
        lines.push(`  • ${time} ${clean}`);
      });
      lines.push('');
      lines.push('要照常推?還是延到明天?');
      lines.push('• 「延晚」← 全部延到明天');
      lines.push('• 「靜音 8 小時」← 暫停');
      lines.push('• 不回 = 照常推(別怪我)');
    } else if (todoStatus.done.length === 0 && writes.length === 0) {
      lines.push('今天比較安靜。早點睡。');
    }

    const text = lines.join('\n');

    try {
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: user.id,
          messages: [{ type: 'text', text }],
        }),
      });
      console.log(`[cron] 已推晚安給 ${user.id.substring(0, 8)} (lateNight: ${lateNight.length})`);
    } catch (err) {
      console.error('[cron] push 失敗:', err);
    }
  }
}

// ============== v191: 出門提醒 — cron 掃描 ==============

async function runOutingChecks(env: Env): Promise<void> {
  // 撈所有 user
  let users: Array<{ id: string }> = [];
  try {
    const result = await env.DB.prepare(`SELECT id FROM users`).all<{ id: string }>();
    users = result.results || [];
  } catch (err) {
    console.error('[outing-cron] 撈 users 失敗:', err);
    return;
  }

  const nowMs = Date.now();
  const todayKey = new Date().toISOString().substring(0, 10);

  for (const u of users) {
    try {
      // (a) 清過期 / 已 fire 的 ad-hoc
      await cleanupExpiredAdhoc(env, u.id);

      // (b) 掃時間到的 ad-hoc → push
      const list = await getAdhocList(env, u.id);
      const due = findDueAdhocByTime(list, nowMs);
      for (const r of due) {
        // v223: 一般定時提醒(kind='general')→ 中性「🔔 提醒」卡,不併模板;
        //   帶東西/出門(kind='outing' 或舊資料無 kind)→ 維持「📦 要帶東西」卡。
        const isGeneral = r.kind === 'general';
        const templateItems = (!isGeneral && r.templateMerge) ? (await getTemplate(env, u.id, r.templateMerge)) || [] : [];
        const merged = Array.from(new Set([...r.items, ...templateItems]));
        const lines = [
          isGeneral ? '🔔 提醒' : '📦 要帶東西提醒',
          '━━━━━━━━━━━━',
          ...(r.note ? [r.note] : []),
          merged.map((s) => `• ${s}`).join('\n'),
        ];
        if (templateItems.length > 0) {
          lines.push('');
          lines.push(`(含「${r.templateMerge}」模板)`);
        }
        await pushLineTextOuting(env, u.id, lines.join('\n'));
        await markAdhocFired(env, u.id, r.id);
        console.log(`[outing-cron] ad-hoc fired ${u.id.substring(0, 8)} id=${r.id}`);
      }

      // (c) 承諾提醒
      const commitments = await getCommitments(env, u.id);
      const remindList = findCommitmentsToRemind(commitments, nowMs);
      for (const { type, c } of remindList) {
        const head = type === 'due_soon' ? '🤝 承諾即將到期' : '⚠️ 承諾已過期';
        const lines = [
          head,
          '━━━━━━━━━━━━',
          `對象:${c.person}`,
          `要帶:${c.item}`,
          ...(c.occasion ? [`場合:${c.occasion}`] : []),
          ...(c.dueBy ? [`Due:${c.dueBy}`] : []),
          '',
          type === 'due_soon' ? '記得帶喔。' : '要不要重排?還是已經給了?',
        ];
        await pushLineTextOuting(env, u.id, lines.join('\n'));
        await markCommitmentReminded(env, u.id, c.id);
        console.log(`[outing-cron] commitment fired ${u.id.substring(0, 8)} id=${c.id} (${type})`);
      }

      // (d) Phase 4:Notion 行事曆主動預判 — 接近 30 分內的 reminder → keyword match template → push 要帶啥
      await scanNotionRemindersForOuting(env, u.id, todayKey);
    } catch (err) {
      console.error(`[outing-cron] user ${u.id.substring(0, 8)} 處理失敗:`, err);
    }
  }
}

// Phase 4: 接近 30 分內的 reminder 用 keyword 對應到模板
async function scanNotionRemindersForOuting(env: Env, userId: string, todayKey: string): Promise<void> {
  try {
    const reminders = await loadReminders(env, userId);
    const now = new Date();
    const tpe = localWallClock(env, now.getTime());
    const nowMin = tpe.getUTCHours() * 60 + tpe.getUTCMinutes();

    // 找接下來 30 分內的 reminder
    const upcoming = reminders.filter((r) => {
      if (r.state === 'resolved' || r.state === 'started') return false;
      const diff = r.startTimeMin - nowMin;
      return diff > 0 && diff <= 30;
    });

    if (upcoming.length === 0) return;

    // v224(B)/v225: 出門語意判斷抽到 core/outing/classify.ts,跟 NFC 今日清單共用同一套。
    //   只在「明確出門訊號」才觸發(hasDepartureSignal),活動名詞由 matchTemplateName 對模板。

    for (const r of upcoming) {
      // v224(B): 沒有明確出門訊號 → 不猜(桌前工作不該觸發出門帶東西)
      if (!hasDepartureSignal(r.text)) continue;

      // dedup:同 reminder 同一天只 push 一次
      const dedupKey = `outing-prereminder:${userId}:${todayKey}:${r.blockId}`;
      if (env.CACHE) {
        const dup = await env.CACHE.get(dedupKey);
        if (dup) continue;
      }

      // 找符合的 template(共用 classify)
      const matched = matchTemplateName(r.text);
      if (!matched) continue;

      const items = await getTemplate(env, userId, matched);
      if (!items || items.length === 0) continue;

      const minStr = `${String(Math.floor(r.startTimeMin / 60)).padStart(2, '0')}:${String(r.startTimeMin % 60).padStart(2, '0')}`;
      const lines = [
        `📦 即將「${matched}」前提醒`,
        '━━━━━━━━━━━━',
        `${minStr} 的事項:${r.text.replace(/🔔/g, '').trim()}`,
        '',
        `預設要帶:`,
        items.map((s) => `• ${s}`).join('\n'),
        '',
        '需要加什麼臨時的嗎?直接跟我講「帶 X」即可。',
      ];
      await pushLineTextOuting(env, userId, lines.join('\n'));

      if (env.CACHE) {
        await env.CACHE.put(dedupKey, '1', { expirationTtl: 86400 }); // 1 day dedup
      }
      console.log(`[outing-cron] phase4 fired ${userId.substring(0, 8)} template=${matched} reminder=${r.blockId}`);
    }
  } catch (err) {
    console.error(`[outing-cron] phase4 scan failed:`, err);
  }
}

async function pushLineTextOuting(env: Env, userId: string, text: string): Promise<void> {
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
  } catch (err) {
    console.error('[outing-cron] push failed:', err);
  }
}
