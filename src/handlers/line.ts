/**
 * LINE Webhook Handler — v30:Loading Indicator + webhook dedup + 強化寫入告知
 */

import type { Context } from 'hono';
import type { Env } from '../core/types';
import type { ExecutionContext } from '@cloudflare/workers-types';
import { messagingApi, validateSignature, WebhookRequestBody } from '@line/bot-sdk';
import { chatWithTools } from '../core/ai/claude-with-tools';
import { chat } from '../core/ai/claude';
import { routeMessage } from '../core/router/route';
import { chatLight } from '../core/ai/light';
import { buildCoreIdentity } from '../core/ai/core-prompt';
import { loadSharedMemory } from '../core/memory/shared-memory';
import { getMonthlyCost } from '../core/safety/budget';
import {
  getTodayWrites,
  undoWrite,
  hasPendingBatch,
  executePendingBatch,
  cancelPendingBatch,
  getPendingBatch,
  formatPendingBatchMessage,
} from '../core/tools/notion-write-tools';
import { tryReminderCommand, checkFollowupResponse, markReminderStarted } from '../core/reminders/commands';
import { setSilenceTemp } from '../core/reminders/silence';
import { loadReminders, parseHeadingDate } from '../core/reminders/store';
import { polishTranscript } from '../core/voice/polish';
import { buildWhisperPrompt } from '../core/voice/vocabulary';
import { VERSION, DEPLOYED_AT } from '../version';
import { setUserPushoverKey, deleteUserPushoverKey, getUserPushoverKey, sendPushover, getPushoverAllUntil, setPushoverAllUntil, deletePushoverAllUntil } from '../adapters/pushover';
import { placeCall, isTwilioConfigured } from '../adapters/twilio';
import { getPreferences, setPreferences } from '../core/preferences/store';
import {
  getDistractionList,
  setDistractionList,
  addDistractionApp,
  removeDistractionApp,
  getWorkHours,
  setWorkHours,
  formatWorkHours,
  getProcrastinationLog,
  isInWorkHours,
  isInWorkTimeByNotion,
} from '../core/distraction/store';
import {
  getAdhocList as getOutingAdhoc,
  listPendingCommitments,
  getBaseKit,
  setBaseKit,
} from '../core/outing/store';
import { getContract, getTodayPageId, seedDefaultContract } from '../core/planning/contract';
import { isKnownFamilyMember, getChildrenOf, createInviteCode, listAssignedReminders, getParentsOf } from '../core/family/store';
import { isBindingCommand, tryFamilyBindCommand } from '../core/family/binding';
import { tryChildDoneTyped, completeChildReminder, snoozeChildReminder, formatSchedule } from '../core/family/delivery';
import { getChildPolicy, clampModelToPolicy, isModelAllowedByPolicy, checkChildChatGuard, type ChildPolicy } from '../core/family/child-policy';
import { buildMinorSystemPrompt, MINOR_TOOL_NAMES, detectCrisis, hasAlert, stripAlert } from '../core/ai/minor-coach';
import { overlayConfig, isOwner, getOwnerUserId, isInternalMode } from '../core/config/runtime-config';
import { getTomorrowReport } from '../core/planning/tomorrow';
import { scanFestivals, appendAIMarker } from '../core/planning/festival';
import { scanStuckTodos } from '../core/planning/stuck';
import { localWallClock, buildWeekDateTable } from '../core/util/time';

const { MessagingApiClient } = messagingApi;

// LINE Loading Indicator — 讓使用者看到「對方正在輸入中…」
async function startLoadingIndicator(userId: string, env: Env, seconds = 30): Promise<void> {
  try {
    await fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chatId: userId, loadingSeconds: seconds }),
    });
  } catch (err: any) {
    console.warn('[v30] loading indicator failed:', err.message ?? err);
  }
}

// Quick Reply 5 種模式(v112: 新增 'confirm' — 對應「請確認」情境)
type ButtonMode = 'none' | 'default' | 'write' | 'pending' | 'confirm';

function buildQuickReply(mode: ButtonMode) {
  switch (mode) {
    case 'none':
      return undefined;
    case 'pending':
      // 等使用者確認批次 → 確認 / 取消
      return {
        items: [
          { type: 'action', action: { type: 'message', label: '✓ 確認', text: '確認' } },
          { type: 'action', action: { type: 'message', label: '✗ 取消', text: '取消' } },
          { type: 'action', action: { type: 'message', label: '說明', text: '/help' } },
        ],
      };
    case 'confirm':
      // v112: bot 問 yes/no 確認(常見:時間推測對嗎?是否要寫到明天?)
      // 「重打」讓使用者另起描述,反肌肉記憶 — 不只 yes/no
      return {
        items: [
          { type: 'action', action: { type: 'message', label: '✓ 是', text: '是' } },
          { type: 'action', action: { type: 'message', label: '✗ 不是', text: '不是' } },
          { type: 'action', action: { type: 'message', label: '重打', text: '我要重講' } },
          { type: 'action', action: { type: 'message', label: '取消', text: '取消' } },
        ],
      };
    case 'write':
    case 'default':
    default:
      // v211: 日常 / 寫入後的快速鍵移除(撤回剛才 / 今日寫入 / 額度 / 說明 / 提醒) —
      //        已有 Rich Menu 涵蓋,這些只是洗版。確認類(confirm/pending)保留。
      return undefined;
  }
}

// v112: 偵測 Claude 回應裡的確認 marker,回傳「去掉 marker 的乾淨文字」+「是否要切 confirm mode」
// v114: 加啟發式 fallback — 若 Claude 沒加 marker 但結尾是 yes/no 問句 → 也切 confirm
function detectConfirmAsk(text: string): { cleanText: string; isAsk: boolean } {
  // marker 形式:[ASK_YES_NO] 或 [ASK_CONFIRM](放在最後一行)
  const re = /\s*\[(ASK_YES_NO|ASK_CONFIRM)\]\s*$/m;
  if (re.test(text)) {
    return { cleanText: text.replace(re, '').trimEnd(), isAsk: true };
  }
  // 啟發式 fallback:訊息結尾是「嗎?」「嗎?」「對嗎?」等 yes/no 問句
  // 限制:訊息不能太長(<400 字)、含時間方括號【】或常見確認詞,降低 false positive
  const trimmed = text.trim();
  if (trimmed.length > 0 && trimmed.length < 400) {
    const tail = trimmed.split('\n').filter((l) => l.trim()).slice(-2).join(' ');
    const endsWithYesNo = /(嗎\??|對嗎\??|是嗎\??|對不對\??|是不是\??)[\s?。!]*$/.test(tail);
    const hasHint = /【.+】|確認一下|你是指|要寫到|要不要|是這|是不是/.test(tail);
    if (endsWithYesNo && hasHint) {
      return { cleanText: text, isAsk: true };
    }
  }
  return { cleanText: text, isAsk: false };
}

// v193: 對話 reply 結尾自動附「未寫進 Notion 的 pending 待辦」footer
// 條件:24h 內 due 的 ad-hoc 或有 pending commitment 才附;全空 → 不附
// 最多 3 條細節 + 承諾總數,避免訊息暴增
async function buildPendingFooter(env: Env, userId: string): Promise<string> {
  try {
    const nowMs = Date.now();
    const adhoc = await getOutingAdhoc(env, userId);
    console.log(`[pending-footer] userId=${userId.substring(0, 8)} adhoc_total=${adhoc.length} sample=${JSON.stringify(adhoc[0] || null).substring(0, 200)}`);
    const soon = adhoc.filter((r) => {
      if (r.firedAt) return false;
      if ((r as any).expiresAt && new Date((r as any).expiresAt).getTime() < nowMs) return false;
      // v211: footer 只放「24h 內到時間」的 time-type;事件型(靠「出門了」等關鍵字觸發、沒時間)
      //   不進 footer — 否則會每則訊息都掛著洗版、且不會自己消失。事件型照樣靠關鍵字觸發,不受影響。
      if (r.trigger.type === 'time' && r.trigger.timeISO) {
        const t = new Date(r.trigger.timeISO).getTime();
        return t - nowMs > 0 && t - nowMs <= 24 * 3600 * 1000;
      }
      return false;
    }).sort((a, b) => {
      const ta = a.trigger.timeISO ? new Date(a.trigger.timeISO).getTime() : 0;
      const tb = b.trigger.timeISO ? new Date(b.trigger.timeISO).getTime() : 0;
      return ta - tb;
    });

    const commitments = await listPendingCommitments(env, userId);
    console.log(`[pending-footer] soon=${soon.length} commitments=${commitments.length}`);

    if (soon.length === 0 && commitments.length === 0) return '';

    const lines: string[] = ['', '━━━', '📌 記著:'];
    for (const r of soon.slice(0, 3)) {
      let head = '';
      if (r.trigger.type === 'time' && r.trigger.timeISO) {
        const t = new Date(r.trigger.timeISO);
        const tpe = localWallClock(env, t.getTime());
        const hh = String(tpe.getUTCHours()).padStart(2, '0');
        const mm = String(tpe.getUTCMinutes()).padStart(2, '0');
        // v211: 加日期標示(今天/明天/MM/DD),讓使用者知道這筆是哪天的
        const nowTpe = localWallClock(env, nowMs);
        const dayDiff = Math.floor(Date.UTC(tpe.getUTCFullYear(), tpe.getUTCMonth(), tpe.getUTCDate()) / 86400000)
          - Math.floor(Date.UTC(nowTpe.getUTCFullYear(), nowTpe.getUTCMonth(), nowTpe.getUTCDate()) / 86400000);
        const dayLabel = dayDiff === 0 ? '今天' : dayDiff === 1 ? '明天'
          : `${String(tpe.getUTCMonth() + 1).padStart(2, '0')}/${String(tpe.getUTCDate()).padStart(2, '0')}`;
        head = `${dayLabel} ${hh}:${mm}`;
      } else {
        head = `[${r.trigger.eventKeyword || '事件'}]`;
      }
      const tail = r.templateMerge ? ` (含${r.templateMerge}模板)` : '';
      lines.push(`• ${head} ${r.items.slice(0, 4).join(' ')}${r.items.length > 4 ? '...' : ''}${tail}`);
    }
    if (soon.length > 3) {
      lines.push(`• ...還有 ${soon.length - 3} 件臨時提醒`);
    }
    if (commitments.length > 0) {
      lines.push(`• 待兌現承諾:${commitments.length} 件`);
    }
    return lines.join('\n');
  } catch (err) {
    console.warn('[pending-footer] failed:', err);
    return '';
  }
}

// v193: LINE 純文字不 render markdown,server 端 strip 掉(避免 Claude 沒乖乖照 prompt)
// 處理:**bold** / __bold__ / `code` / ### heading / [text](url)
// 不處理:* item(避免誤傷項目符號),_italic_(怕誤傷檔名/ID)
function stripMarkdownForLine(text: string): string {
  if (!text) return text;
  let s = text;
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '$1');           // **bold**
  s = s.replace(/__([^_\n]+?)__/g, '$1');                // __bold__
  s = s.replace(/`([^`\n]+?)`/g, '$1');                  // `code`
  s = s.replace(/^#{1,6}\s+/gm, '');                     // ### heading at line start
  s = s.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, '$1 $2');  // [text](url) → text url
  return s;
}

// 組一則含/不含 Quick Reply 的訊息
// v179: 加 customButtons 參數 — Claude 用 [QUICK_REPLY: a, b, c] marker 觸發,優先於 mode
function buildMessage(text: string, mode: ButtonMode = 'none', quoteToken?: string, customButtons?: string[] | null) {
  const cleanText = stripMarkdownForLine(text);
  const msg: any = { type: 'text', text: cleanText };
  let qr;
  if (customButtons && customButtons.length > 0) {
    qr = {
      items: customButtons.slice(0, 13).map((label) => ({
        type: 'action',
        action: {
          type: 'message',
          label: label.substring(0, 20),
          text: label,
        },
      })),
    };
  } else {
    qr = buildQuickReply(mode);
  }
  if (qr) msg.quickReply = qr;
  if (quoteToken) msg.quoteToken = quoteToken;
  return msg;
}

// v179: 偵測 Claude 回應裡的 [QUICK_REPLY: btn1, btn2, ...] marker
//        回傳「去掉 marker 的乾淨文字」+「自訂按鈕陣列 or null」
function detectCustomQuickReply(text: string): { cleanText: string; buttons: string[] | null } {
  const re = /\s*\[QUICK_REPLY:\s*([^\]]+)\]\s*$/m;
  const m = text.match(re);
  if (!m) return { cleanText: text, buttons: null };
  // 用逗號 / 中文逗號分隔
  const buttons = m[1]
    .split(/[,,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4); // 最多 4 顆,避免畫面爆
  if (buttons.length === 0) {
    return { cleanText: text.replace(re, '').trimEnd(), buttons: null };
  }
  return { cleanText: text.replace(re, '').trimEnd(), buttons };
}

// 手動觸發「給我按鈕」的關鍵字
const SHOW_BUTTONS_KEYWORDS = new Set([
  '按鈕', '按鈕呢', '給我按鈕', 'menu', '/menu', 'buttons', 'show', '常用',
]);

function isShowButtonsQuery(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  return SHOW_BUTTONS_KEYWORDS.has(t);
}

// 把 reply / push 的訊息 id 存進 KV,讓 LINE quote 能反查到 reminder
async function rememberSentMsg(env: Env, messageId: string | null | undefined, reminderId: string): Promise<void> {
  if (!messageId || !env.CACHE) return;
  try {
    await env.CACHE.put(`pushed-msg:${messageId}`, reminderId, { expirationTtl: 36 * 3600 });
  } catch (e) {
    console.warn('[remember] save failed:', e);
  }
}

// 用 fetch 自己送 reply(可拿到 sentMessages 回傳 — SDK 版本不一定 expose)
async function rawReply(env: Env, replyToken: string, message: any): Promise<string | null> {
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ replyToken, messages: [message] }),
    });
    if (!r.ok) {
      console.warn('[rawReply] failed', r.status, (await r.text()).substring(0, 200));
      return null;
    }
    const rawText = await r.text();
    let messageId: string | null = null;
    try {
      const data: any = JSON.parse(rawText);
      messageId = data?.sentMessages?.[0]?.id ?? null;
    } catch {}
    // 順手存原文 → 讓 LINE quote 反查能拿到完整內容
    if (messageId && env.CACHE && message?.text) {
      try {
        await env.CACHE.put(`pushed-msg-text:${messageId}`, String(message.text).substring(0, 1500), {
          expirationTtl: 24 * 3600,
        });
      } catch {}
    }
    console.log(`[rawReply] OK msgId=${messageId}`);
    return messageId;
  } catch (e) {
    console.error('[rawReply] exception:', e);
    return null;
  }
}

// ============== v226 固定必帶(base kit)快捷指令(deterministic) ==============
// 回饋圈建議「固定必帶加 X」要真的能用 — 走 deterministic,不靠 Claude。
function parseBaseKitCommand(text: string):
  | { action: 'show' }
  | { action: 'add' | 'remove'; items: string[] }
  | null {
  const t = text.trim();
  if (/^(固定必帶|看固定必帶|我的固定必帶|固定必帶清單|base ?kit)$/i.test(t)) return { action: 'show' };
  const splitItems = (s: string) => s.split(/[、,，\s/]+/).map((x) => x.trim()).filter(Boolean);
  // v226 修(Phase2 審查):動詞後要求「至少一個空格」,避免「固定必帶加錯了怎麼辦」這種問句
  //   被貪婪 .+ 當指令、把「錯了/怎麼辦」加進清單。按鈕與建議都用「加 X」(帶空格),命中正常。
  let m = t.match(/^固定必帶\s*(?:加|新增|加入)\s+(.+)$/);
  if (m) return { action: 'add', items: splitItems(m[1]) };
  m = t.match(/^固定必帶\s*(?:拿掉|移除|刪除|刪掉|刪|去掉|不要)\s+(.+)$/);
  if (m) return { action: 'remove', items: splitItems(m[1]) };
  return null;
}

async function tryBaseKitCommand(
  env: Env,
  userId: string,
  text: string
): Promise<{ matched: boolean; reply?: string }> {
  const cmd = parseBaseKitCommand(text);
  if (!cmd) return { matched: false };
  if (cmd.action === 'show') {
    const kit = await getBaseKit(env, userId);
    return {
      matched: true,
      reply: kit.length
        ? `🎒 固定必帶(無論去哪都帶):\n${kit.map((s) => `• ${s}`).join('\n')}\n\n調整:「固定必帶加 X」/「固定必帶拿掉 X」`
        : '🎒 你的固定必帶目前是空的。加一個:「固定必帶加 鑰匙」',
    };
  }
  const cur = await getBaseKit(env, userId);
  if (cmd.action === 'add') {
    const next = await setBaseKit(env, userId, [...cur, ...cmd.items]);
    return { matched: true, reply: `✓ 已加進固定必帶:${cmd.items.join('、')}\n現在固定必帶:${next.join('、')}` };
  }
  // remove
  const rm = new Set(cmd.items);
  const next = await setBaseKit(env, userId, cur.filter((x) => !rm.has(x)));
  return { matched: true, reply: `✓ 已從固定必帶拿掉:${cmd.items.join('、')}\n現在固定必帶:${next.join('、') || '(空)'}` };
}

// v226 回饋圈:「都帶了」一句便宜 ack(quick reply 按鈕送來的),不過 Claude。
function tryBringDoneCommand(text: string): { matched: boolean; reply?: string } {
  const t = text.trim();
  // v226 修(Phase2 審查):拔掉過短的「帶齊」「齊了」— 可能是對 Claude 其他問題的自然回答,會誤攔。
  if (/^(都帶了|帶齊了|都帶齊了|帶好了|都有帶)$/.test(t)) {
    return { matched: true, reply: '👍 讚,出門順利!路上小心。' };
  }
  return { matched: false };
}

// ============== v210 排工作 fast-path(跳過 Claude,deterministic 輸出) ==============

// v211: 解析排計畫請求 + 判斷今天/明天。offset:0=今天 / 1=明天 / null=自動(由時段決定)
function parsePlanningRequest(text: string): { match: boolean; offset: number | null } {
  const t = text.trim();
  if (/^(排今天|排今日|看今天|今天工作|今天的事|排今日工作|今天計畫|今天計劃)$/.test(t)) return { match: true, offset: 0 };
  if (/^(排明天|排明日|看明天|明日工作|規劃明日|明日清單|明天的事|明天計畫|明天計劃)$/.test(t)) return { match: true, offset: 1 };
  if (/^(排工作|排計畫|排計劃|排一下|重新排|重新排一次|再排一次|看節日|節日提醒|卡很久|待辦檢查|看待辦)$/.test(t)) return { match: true, offset: null };

  // v213: 口語多字 fast-path — 需「計畫動作詞」+「日期詞」共現才觸發,
  // 避免「今天天氣如何」這種純查詢誤觸發排計畫。修「我要排今天的工作」被排成明天的 bug。
  if (/排|規劃|安排|計畫|計劃|清單/.test(t)) {
    if (/後天/.test(t)) return { match: true, offset: 2 };
    if (/明天|明日/.test(t)) return { match: true, offset: 1 };
    if (/今天|今日|本日/.test(t)) return { match: true, offset: 0 };
  }
  return { match: false, offset: null };
}

function estimateAdvanceDays(text: string): number {
  // v211: 使用者要求節日/生日一律至少提前 2 週(14 天);報稅之類可更久
  if (text.includes('報稅') || text.includes('繳費')) return 21;
  return 14;
}

async function runPlanningFastPath(env: Env, userId: string, offsetDays: number = 1): Promise<string> {
  // internal 模式(不接 Notion):排工作 fast-path 繞過工具表/planning guard,要在這裡自己擋,
  //   否則 owner 殘留 contract 或 seedDefaultContract 會直接打 Notion(getTomorrowReport 等)。
  if (isInternalMode(env)) {
    return '目前是「內建模式(internal)」— 不接 Notion,沒有「今日計畫 / 排工作」功能。' +
      '要用排工作,到 /setup 把儲存模式改成 notion-new 或 notion-existing 即可。';
  }
  const dayWord = offsetDays === 0 ? '今天' : offsetDays === 1 ? '明天' : `${offsetDays} 天後`;
  let c = await getContract(env, userId);
  if (!c) {
    // 缺契約:owner 有「設定提供的預設契約」才 seed;否則(含買家)回「請先設定」,絕不 fallback 別人的值。
    if (await isOwner(env, userId)) {
      try {
        c = await seedDefaultContract(env, userId);
      } catch (e: any) {
        return `(排工作)契約 seed 失敗:${e?.message ?? e}`;
      }
    }
    if (!c) {
      return '還沒設定你的「今日計畫」Notion 頁,沒辦法排工作。請先完成安裝設定把你的 Notion 結構接上,設好就能排了。';
    }
  }

  const [tomorrow, festivalResult, stuckItems] = await Promise.all([
    getTomorrowReport(env, {
      todayPagePageId: c.todayPlanPageId,
      futurePlanBlockId: c.futurePlanBlockId,
      dailyFixedBlockId: c.dailyFixedBlockId,
      monthlyFixedBlockId: c.monthlyFixedBlockId,
      recurringBlockId: c.recurringBlockId,
      offsetDays,
    }),
    c.festivalBlockId
      ? scanFestivals(env, { todayPagePageId: c.todayPlanPageId, festivalBlockId: c.festivalBlockId })
      : Promise.resolve({ itemsToRemind: [], itemsNeedingMarker: [], allItems: [] }),
    c.todoListBlockId
      ? scanStuckTodos(env, { pageId: c.todayPlanPageId, todoListAnchorId: c.todoListBlockId })
      : Promise.resolve([]),
  ]);

  // 自動寫回 [AI:提前 N 天] for needingMarker
  for (const item of festivalResult.itemsNeedingMarker) {
    try {
      const days = estimateAdvanceDays(item.rawText);
      await appendAIMarker(env, item.blockId, days);
      item.advanceDays = days;
      item.markerByAI = true;
    } catch (e) {
      console.warn('[planning-fast] marker write failed', e);
    }
  }

  // ===== v211 混合層:規則抓乾淨的候選 → 丟 Claude 判斷「明天實際該做什麼」 =====
  //   規則(tomorrow.ts)負責「定位來源 + 日期/星期/月份過濾 + 不漏條列/inline 日期」
  //   Claude 負責語意判斷:濾備註、拆多行、決定每天生活習慣要不要列。失敗則退回下面 deterministic 格式。
  try {
    const allItems = [...tomorrow.byTime, ...tomorrow.noTime];
    const bySrc: Record<string, typeof allItems> = { future_plan: [], daily_fixed: [], monthly_fixed: [], recurring: [] };
    for (const it of allItems) (bySrc[it.source] ??= []).push(it);

    const raw: string[] = [`${dayWord}日期:${tomorrow.mmdd}(星期${tomorrow.weekday})`];
    const grp = (title: string, items: typeof allItems) => {
      if (!items || items.length === 0) return;
      raw.push(`\n【${title}】`);
      for (const it of items) raw.push(`- ${it.text}`);
    };
    grp('未來計畫(明天那天寫的)', bySrc.future_plan);
    grp(`每天固定(星期${tomorrow.weekday})`, bySrc.daily_fixed);
    grp('每月固定(符合今天日期的)', bySrc.monthly_fixed);
    grp('週期性(本月該做的)', bySrc.recurring);
    if (festivalResult.itemsToRemind.length > 0) {
      raw.push('\n【節日提前提醒(該準備了)】');
      for (const f of festivalResult.itemsToRemind) raw.push(`- ${f.rawText}`);
    }
    if (stuckItems.length > 0) {
      raw.push('\n【卡很久待辦】');
      for (const s of stuckItems) raw.push(`- ${s.rawText}（${s.reason === 'due_passed' ? `過期 ${s.daysOverdue} 天` : `${s.daysOld} 天沒進度`}）`);
    }

    console.log(`[planning] offset=${offsetDays} fut=${bySrc.future_plan.length} daily=${bySrc.daily_fixed.length} monthly=${bySrc.monthly_fixed.length} recurring=${bySrc.recurring.length} festival=${festivalResult.itemsToRemind.length} stuck=${stuckItems.length}`);

    const system = [
      `你是排程助理。使用者問「${dayWord}要做什麼」。下面是我從他 Notion 各來源抓到、關於${dayWord}的原始文字,可能含備註、每天生活習慣、一行擠多件事、條列。`,
      `請整理成一份乾淨好讀的「${dayWord}工作建議」,規則:`,
      `1. 列出「${dayWord}實際要做的工作/事項」,包含每天固定的例行事項。`,
      '2. 「每天固定」的事項**要列出來**(它是當天的例行安排,使用者想看到)。若內容是多行(起床/早上/傍晚/晚上 各一段)→ **拆成分行逐項呈現,不要擠成一坨**。有時間的(例「傍晚 19:30 幫小孩洗澡」)照常排進有時間區。',
      '3. 看起來是備註/紀錄/聯絡資訊/已完成的(例:含「已給」「下次是」「email」「@」「參考」),不要當待辦;頂多在最後用一行「備註:」帶過。',
      '4. 一行擠多件事(用頓號、換行分隔)→ 拆成多筆。',
      '5. 有具體時間的排前面、照時間排序;沒時間的列後面。',
      '6. 一律繁體中文台灣用語,簡潔,不要客套開場白。',
      '7. **只能根據我提供的原文,絕對不可自己發明事項**。若某來源沒東西就不提那段。',
      '8. 節日提前提醒、卡很久待辦,如果有,各自獨立一小段列在最後。',
      `輸出格式建議:開頭一行「${dayWord} MM/DD(星期X)要做:」,然後分「有時間」「沒時間」兩區(各自有才列),最後視情況加節日/卡很久/備註。`,
    ].join('\n');

    const res = await chat(env, {
      taskContext: '排計畫精煉',
      userId,
      taskType: 'normal',
      maxTokens: 1200,
      system,
      messages: [{ role: 'user', content: raw.join('\n') }],
    });

    if (res && res.text.trim()) {
      return res.text.trim() + '\n\n━━━━━━\n需要的內容自己複製貼到今日計畫,我不主動動 Notion。';
    }
    console.warn('[planning-hybrid] chat 回空,退回 deterministic 格式');
  } catch (e: any) {
    console.warn('[planning-hybrid] chat 失敗,退回 deterministic 格式:', e?.message ?? e);
  }

  // ===== Format reply(deterministic fallback) =====
  const lines: string[] = [];
  lines.push(`📋 ${dayWord} ${tomorrow.mmdd}(${tomorrow.weekday}) 要做 (${tomorrow.totalCount} 筆)`);
  lines.push('');

  if (tomorrow.byTime.length > 0) {
    lines.push('🕐 有時間的(複製貼回今日計畫):');
    for (const t of tomorrow.byTime) {
      lines.push(`  ${t.text}`);
    }
    lines.push('');
  }

  if (tomorrow.noTime.length > 0) {
    lines.push('📝 沒時間的(隨機處理):');
    for (const t of tomorrow.noTime) {
      lines.push(`  - ${t.text}`);
    }
    lines.push('');
  }

  if (tomorrow.totalCount === 0) {
    lines.push('(沒抓到任何明日 todos — 可能契約沒設好或 Notion 真的沒寫東西)');
    lines.push('');
  }

  // 節日(提前提醒 already due)
  if (festivalResult.itemsToRemind.length > 0) {
    lines.push('🎉 節日提前提醒(該準備了):');
    for (const f of festivalResult.itemsToRemind) {
      lines.push(`  - ${f.rawText}`);
    }
    lines.push('');
  }

  // 節日(新估的 marker)
  if (festivalResult.itemsNeedingMarker.length > 0) {
    lines.push(`🎂 已為節日估提前天數(寫回 Notion 標 [AI:...]):`);
    for (const f of festivalResult.itemsNeedingMarker) {
      lines.push(`  - ${f.rawText.substring(0, 50)} → [AI:提前 ${f.advanceDays} 天]`);
    }
    lines.push('  (不準的話到 Notion 改數字 + 去掉 AI: 表示親自確認)');
    lines.push('');
  }

  // 卡很久
  if (stuckItems.length > 0) {
    lines.push('⚠️ 卡很久待辦:');
    for (const s of stuckItems) {
      const meta = s.reason === 'due_passed' ? `過期 ${s.daysOverdue} 天` : `${s.daysOld} 天沒進度`;
      lines.push(`  - ${s.rawText.substring(0, 50)} (${meta})`);
    }
    lines.push('');
  }

  if (
    tomorrow.totalCount === 0 &&
    festivalResult.itemsToRemind.length === 0 &&
    festivalResult.itemsNeedingMarker.length === 0 &&
    stuckItems.length === 0
  ) {
    lines.push('━━━━━━');
    lines.push('完全沒事 ✓ 自由日!');
  } else {
    lines.push('━━━━━━');
    lines.push('需要的內容自己複製貼到今日計畫,我不主動動 Notion。');
  }

  return lines.join('\n');
}

// 直接 push 訊息(不靠 SDK,精準控制)
async function pushText(userId: string, text: string, env: Env, withQuickReply = true): Promise<void> {
  try {
    const cleanText = stripMarkdownForLine(text); // v193: 同步 strip markdown
    const message: any = { type: 'text', text: cleanText };
    if (withQuickReply) message.quickReply = buildQuickReply('default');
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: userId, messages: [message] }),
    });
  } catch (e) {
    console.warn('[v41] pushText failed:', e);
  }
}

// /help 指令關鍵字
const HELP_KEYWORDS = new Set([
  '/help', 'help', '/說明', '說明', '指令', '/指令', '/?', '?',
]);

function isHelpQuery(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  if (HELP_KEYWORDS.has(t)) return true;
  // v180: 寬鬆自然語言匹配「列指令 / 查功能」類請求 — 避免被路由到 Claude 然後 Claude 自由發揮
  // 例:「我想知道妳有哪些指令可以用」「指令有哪些」「介紹一下功能」
  const trim = text.trim();
  if (trim.length > 200) return false; // 太長一般不是純 help 請求
  if (/(有哪些|哪些|有什麼|什麼|介紹|看看|列|顯示).{0,10}(指令|命令|功能|可以用)/.test(trim)) return true;
  if (/(指令|命令|功能).{0,10}(有哪些|哪些|有什麼|什麼|可以用|清單|列表|介紹)/.test(trim)) return true;
  return false;
}

// v188: 最簡 iOS Shortcuts 教學 — 只 2 個動作 / 1.5 分鐘完成
// v189: 拆成 3 則訊息 — URL 獨立一則,手機長按整則就能複製
function buildDistractionSetupGuideParts(env: Env, userId: string): string[] {
  const token = (env as any).USAGE_WEBHOOK_TOKEN as string | undefined;
  // worker 對外網址改從設定來(擁有者放自己 wrangler.toml;範本不帶 → 提示去設定)
  const workerUrl = env.WORKER_PUBLIC_URL || '<請先在設定填入你的-worker-網址>';
  const tokenStr = token || '<未設,找開發者>';
  const urlForShortcut = `${workerUrl}/api/usage?token=${tokenStr}&user_id=${userId}&app=mixed`;

  // v211: 對齊 iOS 26 正確做法(URL 直接內嵌進自動化,不用另建捷徑;舊版「執行捷徑呼叫」在 iOS 26 會靜默失敗)
  const part1 = [
    '🐢 拖延偵測 — iOS 捷徑設定(簡化版:URL 內嵌)',
    '━━━━━━━━━━━━',
    '只要 2 步驟,約 3 分鐘,建 1 次涵蓋所有分心 app。',
    '',
    '【Step 1】複製下面這段你的專屬 URL',
    '↓ 長按下一則(整段)→ 複製,Step 2 要貼',
  ].join('\n');

  const part2 = urlForShortcut; // 純 URL 獨立一則,好長按複製

  const part3 = [
    '【Step 2】建 iOS 自動化(把 URL 直接內嵌)',
    '',
    '1. 打開「捷徑」app(主畫面右滑到底、上方搜「捷徑」)',
    '2. 切到底部「自動化」分頁',
    '3. 點「新增自動化操作」(空白頁就點中間藍色按鈕)',
    '4. 搜「App」→ 選第 1 個「App」(藍灰 ↗ 圖示,不是 Apple Watch 那個)',
    '5. 點「選擇」→ 一次勾起所有要監測的分心 app',
    '   (IG / FB / YouTube / Threads / 漫畫人...)→ 右上 ✓',
    '6. ⚠ 下方選「立即執行」+「已開啟」打勾',
    '   (千萬別選「確認後執行」— 否則每次彈窗,拖延當下你只會點取消逃避,等於沒用)→ 右上「下一步」',
    '7. 點「開始使用 → 新增捷徑」(空白模板)',
    '8. 進編輯畫面後,底部「搜尋動作」打「URL」',
    '9. 選「取得 URL 內容」(綠色 ↓ 圖示)',
    '   ⚠ 不要選「打開 URL」/「展開 URL」— 那兩個不會發 webhook,白做',
    '10. 點藍色「URL」變數 → 貼上 Step 1 複製的 URL → 完成(自動存檔)',
    '',
    '━━━━━━━━━━━━',
    '【測試】工作時段內開 IG 滑 10 秒 → 等 1~2 分鐘(iOS 26 有 lag)→ LINE 跳「🐢 偵測到拖延!」',
    '沒反應?① 不在工作時段(打「工作時段」確認)② 等不夠久 ③ 動作選錯(要「取得 URL 內容」)',
    '',
    '【加新分心 app】回「自動化」編輯把新 app 勾起來;同時對我講「分心 加 <app>」加進名單。',
    '【常用】分心(看名單) / 工作時段(看模式) / 拖延(今日帳本)',
  ].join('\n');

  return [part1, part2, part3];
}

// v211: 反拖延偵測「圖文 SOP」教學 — Rich Menu 擴充功能 → 反拖延偵測 觸發
//   給完整 PDF SOP 連結(LINE 對 URL 純文字會自動轉成可點擊),並提醒版本差異
const ANTIPROCRAST_SOP_PDF_URL = 'https://drive.google.com/file/d/1zIXF8I3kx2QWQl30Dl2KxuxQnZbmde_f/view?usp=sharing';
function buildAntiProcrastGuideParts(): string[] {
  const part1 = [
    '🐢 反拖延偵測 — 設定教學',
    '━━━━━━━━━━━━',
    '完整圖文 SOP(手機版,點下面連結看):',
  ].join('\n');

  const part2 = ANTIPROCRAST_SOP_PDF_URL; // 純 URL 獨立一則,手機好點 / 好複製

  const part3 = [
    '⚠ 注意:iOS／各 App 介面會隨版本更新,可能跟教學畫面有一點點不一樣。',
    '',
    '如果照著做卻發現畫面跟 SOP 對不上 —',
    '最快的方法是「直接截圖,問你自己的 AI」,',
    '它會看著你當下的畫面,教你下一步怎麼點,比死記步驟快很多。',
    '',
    '━━━━━━━━━━━━',
    '設定完之後:',
    '・打「分心 教學」→ 看文字版步驟',
    '・打「分心 名單」→ 管理要監測的 app',
    '・打「工作時段」→ 看偵測在哪些時段生效',
  ].join('\n');

  return [part1, part2, part3];
}

function buildHelpText(): string {
  return [
    'bot 指令清單',
    '━━━━━━━━━━━━',
    '【提醒運作 — 自動】',
    '在 Notion 事項前加 🔔  → 自動納入提醒系統',
    'T-5(時間到前 5 分):第一次提醒(帶「▶ 開始做了」+「⏰ 延後」按鈕)',
    'T+0(時間到):第二次「現在開始」提醒(同按鈕)',
    '之後每分鐘追殺,直到「完成 / 跳過 / 勾 Notion」',
    '',
    '【提醒互動】',
    '提醒  → 看所有提醒設定',
    '正在做 / 在做了 / 已開始 14:00  → 停追殺(等你做完)',
    '延長 30 分 / 延長 1 小時  → 「正在做」狀態下延長休止期',
    '已完成 / 完成 14:00  → 標記完成 + 自動勾 Notion',
    '延後 14:00 15 分 / 延後到 15:00  → 延後並改 Notion 時間',
    '跳過 14:00 原因  → 跳過該任務(必須給原因)',
    '靜音 2 小時 / 靜音 23:00~7:30  → 暫時 / 每天固定不打擾',
    '取消靜音  → 解除',
    '',
    '【追殺等級】',
    '追殺等級  → 看當前等級 + 詳細參數(追殺方式 / 次數 / Emergency 起點)',
    '追殺等級 off / lite / standard / aggressive  → 切換等級',
    '',
    '【Pushover(突破靜音 / 鎖屏)】',
    'pushover  → 看 Pushover 狀態(啟用 / 模式)',
    'pushover <key>  → 啟用,輸入 user key',
    'pushover 測試  → 送一則測試響鈴(驗證 iOS Critical Alerts 設定)',
    'pushover 全開 今天 / N小時 / N天 / 永久  → 限時所有提醒從第一次推送就走 Pushover',
    'pushover 全開 關  → 停用全開模式',
    'pushover 關  → 完全停用 Pushover',
    '',
    '【拖延偵測(iOS Shortcuts 連動)】',
    '分心 / 我的分心名單  → 看當前監測的 app',
    '分心 加 Instagram FB YouTube  → 加進名單',
    '分心 刪 Instagram  → 從名單移除',
    '分心 清空  → 清空整個名單',
    '分心 教學  → iOS Shortcuts 一次性設定教學',
    '工作時段  → 看當前工作時段',
    '工作時段 9-12, 14-18  → 設工作時段(此時段內偵測拖延才警告)',
    '拖延 / 我的拖延帳本  → 看今日拖延總次數 + 分項',
    '',
    '【模型切換】',
    '模型 (或 /模型)  → 選 Haiku/Sonnet/Sonnet+思考/Opus',
    '使用 Sonnet 思考  → 直接切到 Sonnet+思考模式',
    '',
    '【查看額度】',
    '額度 (或狀態/用量)  → 本月 LINE push、API 用量、當前模型、版本',
    '',
    '【看 bot 動過什麼】',
    '今日寫入  → 列出今天 bot 動過的 Notion + 位置',
    'sync / 同步  → 直接讀 Notion 後端,看實際狀態(繞過 Notion app cache)',
    '撤回剛才那筆  → 撤掉最後一筆寫入',
    '撤回第 N 筆  → 撤倒數第 N 筆',
    '',
    '【批次操作】',
    '「全部延 30 分」/「下午所有延半小時」這類 → 走「請確認」按鈕,你按 ✓ 才真改',
    '取消  → 取消尚未確認的批次',
    '確認  → 執行尚未確認的批次',
    '',
    '【其他】',
    '說明 / /help  → 看這份清單',
    '━━━━━━━━━━━━',
    '其他訊息我會用 Claude 思考並回應(用你目前選的模型)',
    '所有指令都可用語音說',
  ].join('\n');
}

// /額度 指令的關鍵字(v110: 「狀態」改名「額度」,舊關鍵字保留 alias 不破壞肌肉記憶)
const STATUS_KEYWORDS = new Set([
  '額度', '/額度',
  '狀態', '健康', '用量', '/狀態', '/健康', '/用量',
  'status', 'health', 'quota', '/status', '/health', '/quota',
]);

function isStatusQuery(text: string): boolean {
  let t = text.trim().toLowerCase().replace(/\s+/g, '');
  if (STATUS_KEYWORDS.has(t)) return true;
  // v181: 接「我的 / 目前 / 現在 + 額度 / 用量 / 狀態 + 呢 / ?」變體
  t = t.replace(/^(?:我的|目前|現在|查看?|顯示|看一下|告訴我)/, '');
  t = t.replace(/[?。!]+$/, '').replace(/(?:呢|多少|是多少|是什麼|多少呢)$/, '');
  return STATUS_KEYWORDS.has(t);
}

// v115: 模型切換指令 — 觸發詞
const MODEL_MENU_KEYWORDS = new Set([
  '模型', '換模型', '切模型', '/模型', '/model', 'model',
]);
function isModelMenuQuery(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  return MODEL_MENU_KEYWORDS.has(t);
}

// v117: per-user 處理模式(KV);mode 比 model 多一個維度 — 含 thinking 開關
type UserMode = 'haiku' | 'sonnet' | 'sonnet-thinking' | 'opus';
const MODE_LABELS: Record<UserMode, string> = {
  haiku: 'Haiku 4.5 (快/便宜)',
  sonnet: 'Sonnet 4.6 (平衡 — 預設)',
  'sonnet-thinking': 'Sonnet 4.6 + 思考 (慢/貴/推理深)',
  opus: 'Opus 4.7 (最聰明)',
};
const THINKING_BUDGET_DEFAULT = 4096; // sonnet-thinking 用,夠應付一般推理

function modeToModel(mode: UserMode): 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7' {
  if (mode === 'haiku') return 'claude-haiku-4-5';
  if (mode === 'opus') return 'claude-opus-4-7';
  return 'claude-sonnet-4-6'; // sonnet 或 sonnet-thinking
}
function modeToThinkingBudget(mode: UserMode): number {
  return mode === 'sonnet-thinking' ? THINKING_BUDGET_DEFAULT : 0;
}

async function getUserMode(env: Env, userId: string): Promise<UserMode> {
  if (!env.CACHE) return 'sonnet';
  try {
    const raw = await env.CACHE.get(`user-mode:${userId}`);
    if (raw === 'haiku' || raw === 'sonnet' || raw === 'sonnet-thinking' || raw === 'opus') {
      return raw;
    }
    // v115 向後相容:讀舊 key user-model
    const legacy = await env.CACHE.get(`user-model:${userId}`);
    if (legacy === 'claude-haiku-4-5') return 'haiku';
    if (legacy === 'claude-opus-4-7') return 'opus';
    if (legacy === 'claude-sonnet-4-6') return 'sonnet';
  } catch {}
  return 'sonnet';
}
async function setUserMode(env: Env, userId: string, mode: UserMode): Promise<void> {
  if (!env.CACHE) return;
  await env.CACHE.put(`user-mode:${userId}`, mode);
}

// v117: 偵測「使用 Haiku/Sonnet/Sonnet 思考/Opus」按下按鈕後的訊息
function parseSetModeCommand(text: string): UserMode | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  if (t === '使用haiku' || t === '用haiku' || t === 'haiku') return 'haiku';
  if (t === '使用sonnet' || t === '用sonnet' || t === 'sonnet') return 'sonnet';
  if (t === '使用sonnet思考' || t === 'sonnet思考' || t === 'sonnet+思考' || t === 'sonnetthinking') return 'sonnet-thinking';
  if (t === '使用opus' || t === '用opus' || t === 'opus') return 'opus';
  return null;
}

// v117: 模型選單 Quick Reply(4 模式)
function buildModelQuickReply() {
  return {
    items: [
      { type: 'action', action: { type: 'message', label: 'Haiku 快', text: '使用 Haiku' } },
      { type: 'action', action: { type: 'message', label: 'Sonnet 預設', text: '使用 Sonnet' } },
      { type: 'action', action: { type: 'message', label: 'Sonnet 思考', text: 'Sonnet 思考' } },
      { type: 'action', action: { type: 'message', label: 'Opus 聰明', text: '使用 Opus' } },
    ],
  };
}

// v110: 查 LINE 官方本月 push 額度與用量(LINE 平台級的真實計數)
async function fetchLineQuota(env: Env): Promise<{ used: number | null; limit: number | null }> {
  const headers = { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  let used: number | null = null;
  let limit: number | null = null;
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/quota', { headers });
    if (r.ok) {
      const d: any = await r.json();
      // type=limited → value 是上限;type=none → 不限(個人 plan 才會是 limited)
      limit = d?.type === 'limited' ? Number(d.value ?? 0) : null;
    }
  } catch (e) {
    console.warn('[quota] fetch limit failed:', e);
  }
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers });
    if (r.ok) {
      const d: any = await r.json();
      used = Number(d?.totalUsage ?? 0);
    }
  } catch (e) {
    console.warn('[quota] fetch consumption failed:', e);
  }
  return { used, limit };
}

// 撤回指令解析:回傳要撤的「倒數第幾筆」,null 表示不是撤回指令
function parseUndoCommand(text: string): number | null {
  const t = text.trim();
  // 「撤回剛才那筆」「撤回最後一筆」「撤回上一筆」「撤回」
  if (/^撤回(剛才那?筆|最後一?筆|上一?筆)?$/.test(t)) return 1;
  // 「撤回第 N 筆」/ 「撤回倒數第 N 筆」 — N 從 1 開始
  const m = t.match(/^撤回(?:倒數)?第\s*(\d+)\s*筆$/);
  if (m) {
    const n = parseInt(m[1], 10);
    return n > 0 ? n : null;
  }
  return null;
}

// 列出今日寫入(給「列出今日寫入」「最近寫了什麼」用)
const LIST_WRITES_KEYWORDS = new Set([
  '列出今日寫入', '今日寫入', '最近寫了什麼', '今天寫了什麼', '寫入清單',
]);

function isListWritesQuery(text: string): boolean {
  const t = text.trim();
  return LIST_WRITES_KEYWORDS.has(t);
}

// v141: 「Pushover 教學」文字指令(電腦版 LINE 無 Rich Menu,改打字觸發)
const PUSHOVER_SETUP_KEYWORDS = new Set([
  'pushover 教學', 'pushover教學', '設定 pushover', '設定pushover',
  'pushover 設定', 'pushover設定', 'pushover help', 'pushover 說明',
]);
function isPushoverSetupQuery(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  return ['pushover教學', '設定pushover', 'pushover設定', 'pushoverhelp', 'pushover說明'].includes(t);
}

// v151: 追殺等級指令解析
// v181: 接受口語變體(我的 / 目前 / 現在 / 查 / 看 + 追殺等級 + 呢 / ?)— 不再 exact match
function parseFollowupLevelCommand(text: string): { matched: boolean; level?: 'off' | 'lite' | 'standard' | 'aggressive'; showOnly?: boolean } {
  let t = text.trim().toLowerCase().replace(/\s+/g, '');
  // 去掉常見前綴 + 後綴(查詢用法)
  t = t.replace(/^(?:我的|目前|現在|查看?|顯示|看一下|告訴我)/, '');
  t = t.replace(/[?。!]+$/, '').replace(/(?:呢|多少|是多少|是什麼|多少呢|是?啥)$/, '');
  if (t === '追殺等級') return { matched: true, showOnly: true };
  const m = t.match(/^追殺等級(off|lite|standard|aggressive|關|輕|標準|激進)$/);
  if (!m) return { matched: false };
  const map: Record<string, 'off' | 'lite' | 'standard' | 'aggressive'> = {
    'off': 'off', '關': 'off',
    'lite': 'lite', '輕': 'lite',
    'standard': 'standard', '標準': 'standard',
    'aggressive': 'aggressive', '激進': 'aggressive',
  };
  return { matched: true, level: map[m[1]] };
}

// v211: 提醒時序設定解析 — 提前多久 / 當下是否再提醒 / 開始後多久檢測
type ReminderTimingCmd =
  | { matched: true; action: 'show' }
  | { matched: true; action: 'lead'; value: number }
  | { matched: true; action: 'startNotify'; value: boolean }
  | { matched: true; action: 'checkAfter'; value: number }
  | { matched: false };
function parseReminderTimingCommand(text: string): ReminderTimingCmd {
  const t = text.trim().replace(/[?？。!]+$/, '');
  // 總覽
  if (/^(我的|目前|現在|查看?|看一下)?提醒設定$/.test(t)) return { matched: true, action: 'show' };
  // 提前多久提醒:「提前提醒 10」「提前 10 分」「提前 10 分鐘提醒」
  let m = t.match(/^(?:工作)?(?:開始前)?提前(?:提醒)?\s*(\d{1,3})\s*分?鐘?(?:提醒)?$/);
  if (m) return { matched: true, action: 'lead', value: parseInt(m[1], 10) };
  // 當下(到點)是否再提醒:「當下提醒 開/關」「到點提醒 關」
  m = t.match(/^(?:當下|到點|準時)\s*(?:再?提醒)?\s*(開|關|開啟|關閉|on|off)$/i);
  if (m) return { matched: true, action: 'startNotify', value: /開|on/i.test(m[1]) };
  // 開始後多久檢測:「開始檢測 20」「開始後 20 分檢測」「開始後檢測 20」
  m = t.match(/^開始(?:後)?\s*(?:檢測|檢查)\s*(\d{1,3})\s*分?鐘?$/)
    || t.match(/^開始(?:後)?\s*(\d{1,3})\s*分?鐘?(?:檢測|檢查)$/);
  if (m) return { matched: true, action: 'checkAfter', value: parseInt(m[1], 10) };
  return { matched: false };
}

// v211: 提醒時序設定 — 回 2 則:總覽 + 可長按複製的範本(已填現值,改數字後傳回)
function buildReminderTimingReply(prefs: any): any[] {
  const lead = prefs.reminderLeadMin ?? 5;
  const startOn = prefs.reminderStartNotify !== false;
  const checkAfter = prefs.reminderCheckAfterMin ?? 15;
  const overview = [
    '⏰ 提醒時序設定(目前)',
    '━━━━━━━━━━━━',
    `1. 工作開始前提醒:${lead === 0 ? '不提前(到點才提醒)' : `提前 ${lead} 分`}`,
    `2. 到點(當下)再提醒一次:${startOn ? '🟢 開' : '⚪ 關'}`,
    `3. 開始後檢測:${checkAfter === 0 ? '不檢測(不追殺)' : `${checkAfter} 分後`}`,
    '━━━━━━━━━━━━',
    '要改 → 用下面那則的「📋 一鍵複製範本」(手機)或直接選取複製(電腦),改數字後傳回給我即可。',
    '（提前/檢測 寫分鐘數,0=關掉該項;當下 寫 開 或 關）',
  ].join('\n');
  // 範本獨立一則 + 一鍵複製按鈕(LINE clipboard action,點一下直接進剪貼簿)
  const template = [
    `提前：${lead}`,
    `當下：${startOn ? '開' : '關'}`,
    `檢測：${checkAfter}`,
  ].join('\n');
  return [
    { type: 'text', text: overview },
    {
      type: 'text',
      text: `${template}\n\n手機:點下面「📋 一鍵複製範本」→ 貼上 → 改數字 → 傳回\n電腦版:直接選取上面三行複製(或自己打),改數字後傳回`,
      quickReply: {
        items: [
          { type: 'action', action: { type: 'clipboard', label: '📋 一鍵複製範本', clipboardText: template } },
        ],
      },
    },
  ];
}

// v211: 解析「提醒設定範本」— 多行(提前 N / 當下 開|關 / 檢測 N),也吃單行單項。
//   嚴格:每行都要是已知欄位(行首是 提前/當下/到點/開始/檢測),避免一般對話誤觸發。
function parseReminderForm(text: string):
  | { matched: true; lead?: number; startNotify?: boolean; checkAfter?: number }
  | { matched: false } {
  const lines = text.trim().split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return { matched: false };
  let lead: number | undefined;
  let startNotify: boolean | undefined;
  let checkAfter: number | undefined;
  let recognized = 0;
  for (const ln of lines) {
    // 取冒號後的「答案」判斷(避免 label 如「(開／關)」「(寫幾分鐘)」干擾);無冒號就用整行
    const ans = /[：:]/.test(ln) ? (ln.split(/[：:]/).pop() || '').trim() : ln;
    if (/^(開始|檢測|檢查)/.test(ln) && /檢/.test(ln)) {
      const m = ans.match(/(\d{1,3})/);
      if (m) { checkAfter = parseInt(m[1], 10); recognized++; continue; }
      return { matched: false };
    }
    if (/^提前/.test(ln)) {
      const m = ans.match(/(\d{1,3})/);
      if (m) { lead = parseInt(m[1], 10); recognized++; continue; }
      return { matched: false };
    }
    if (/^(當下|到點|準時)/.test(ln)) {
      if (/關|off/i.test(ans)) { startNotify = false; recognized++; continue; }
      if (/開|on/i.test(ans)) { startNotify = true; recognized++; continue; }
      return { matched: false };
    }
    return { matched: false }; // 有不認識的行 → 不是設定範本
  }
  if (recognized === 0) return { matched: false };
  return { matched: true, lead, startNotify, checkAfter };
}

// v212: 早安/晚安推播設定 — 回 2 則:總覽 + 可長按複製的範本(只填時間,改完傳回自動開啟)
function buildMorningNightReply(prefs: any): any[] {
  const mOn = prefs.morningBriefEnabled !== false;
  const mTime = prefs.morningBriefHHMM ?? '08:30';
  const nOn = prefs.eveningSummaryEnabled !== false;
  const nTime = prefs.eveningSummaryHHMM ?? '22:00';
  const overview = [
    '🌅 早安 / 晚安推播設定(目前)',
    '━━━━━━━━━━━━',
    `1. 早安推播:${mOn ? `🟢 開,每天 ${mTime}` : '⚪ 關'}`,
    `2. 晚安總結:${nOn ? `🟢 開,每天 ${nTime}` : '⚪ 關'}`,
    '━━━━━━━━━━━━',
    '點下面按鈕,滑動選時間 → 選好自動套用、自動開啟。',
    '要關掉打「關早安推播」或「關晚間總結」。',
    '(電腦版若選不動,直接打「早安:07:00」也能改)',
  ].join('\n');
  return [
    {
      type: 'text',
      text: overview,
      quickReply: {
        items: [
          { type: 'action', action: { type: 'datetimepicker', label: '🌅 選早安時間', data: 'rm:cmd=set-morning-time', mode: 'time', initial: mTime } },
          { type: 'action', action: { type: 'datetimepicker', label: '🌙 選晚安時間', data: 'rm:cmd=set-evening-time', mode: 'time', initial: nTime } },
        ],
      },
    },
  ];
}

// v212: 解析「早晚安設定範本」— 多行(早安 HH:MM / 晚安 HH:MM),也吃單行單項。
//   嚴格:每行行首要是 早安/早報/morning 或 晚安/晚間/evening,且要有合法 HH:MM,避免一般道早晚安誤觸發。
function parseMorningNightForm(text: string):
  | { matched: true; morningHHMM?: string; eveningHHMM?: string }
  | { matched: false } {
  const lines = text.trim().split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return { matched: false };
  let morningHHMM: string | undefined;
  let eveningHHMM: string | undefined;
  let recognized = 0;
  const grabTime = (s: string): string | null => {
    const m = s.match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh > 23 || mm > 59) return null;
    return `${String(hh).padStart(2, '0')}:${m[2]}`;
  };
  for (const ln of lines) {
    const ans = /[：:]/.test(ln) ? (ln.split(/[：:]/).pop() || '').trim() : ln;
    if (/^(早安推播|早安|早報|morning)/i.test(ln)) {
      const tm = grabTime(ans);
      if (tm) { morningHHMM = tm; recognized++; continue; }
      return { matched: false };
    }
    if (/^(晚安總結|晚間總結|晚安|晚間|evening)/i.test(ln)) {
      const tm = grabTime(ans);
      if (tm) { eveningHHMM = tm; recognized++; continue; }
      return { matched: false };
    }
    return { matched: false }; // 有不認識的行 → 不是設定範本
  }
  if (recognized === 0) return { matched: false };
  return { matched: true, morningHHMM, eveningHHMM };
}

// v151: 不打擾時段指令解析
// v181: 接受口語變體(我的不打擾時段 / 目前不打擾 + ? / 呢)
function parseQuietHoursCommand(text: string): { matched: boolean; action?: 'show' | 'set' | 'off' | 'on'; start?: string; end?: string } {
  let t = text.trim();
  // 設定 / 改變類保留 strict 比對(下方 regex)
  // 查詢類(show)放寬:strip 前綴/後綴 / 後面接「時段 / 設定」
  let tQuery = t.replace(/^(?:我的|目前|現在|查看?|顯示|看一下|告訴我)/, '');
  tQuery = tQuery.replace(/[?。!]+$/, '').replace(/(?:時段|設定|呢|是什麼|是多少)$/, '');
  if (tQuery === '不打擾') return { matched: true, action: 'show' };
  if (t === '不打擾') return { matched: true, action: 'show' };
  if (/^不打擾\s*關$/.test(t)) return { matched: true, action: 'off' };
  if (/^不打擾\s*開$/.test(t)) return { matched: true, action: 'on' };
  // 「不打擾 23:00-07:00」或「不打擾 23:00~07:00」
  const m = t.match(/^不打擾\s+(\d{1,2}):(\d{2})\s*[-~到]\s*(\d{1,2}):(\d{2})$/);
  if (m) {
    const start = `${m[1].padStart(2, '0')}:${m[2]}`;
    const end = `${m[3].padStart(2, '0')}:${m[4]}`;
    return { matched: true, action: 'set', start, end };
  }
  return { matched: false };
}

// v142: 偵測 user 直接貼 user key(沒加 pushover 前綴) — Pushover key 標準是 30 字元純英數
function isCandidatePushoverKey(text: string): boolean {
  const t = text.trim();
  // 純英數 + 28-32 字元範圍(Pushover 規格 30 字元,寬鬆容錯)
  if (!/^[a-zA-Z0-9]{28,32}$/.test(t)) return false;
  // 已含 pushover 前綴就不算(那條走正式指令 path)
  if (/pushover/i.test(t)) return false;
  return true;
}

// v126: 「sync 確認 / 查後端」指令 — 直接打 Notion API 顯示後端真實狀態
// 解 user 痛點:Notion app 偶發 stale,但 bot 能即時 read API 給 ground truth
const SYNC_CHECK_KEYWORDS = new Set([
  'sync', 'sync確認', '同步', '同步確認', '後端', 'notion後端', '查notion', '查後端',
  '真實狀態', '/sync', '/同步',
]);
function isSyncCheckQuery(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  return SYNC_CHECK_KEYWORDS.has(t);
}

// 直接打 Notion API 取「今日計畫」頁今日區段內所有 to_do(不靠 KV,不靠 Notion app)
// v222: 今日計畫頁改走 per-user contract(取代寫死 id);缺契約回友善訊息,不碰開發者 Notion。
async function buildSyncCheckReport(env: Env, userId: string): Promise<string> {
  if (isInternalMode(env)) {
    return '目前是「內建模式(internal)」— 不接 Notion,沒有今日計畫同步狀態可查。';
  }
  const TODAY_PAGE_ID = await getTodayPageId(env, userId);
  if (!TODAY_PAGE_ID) {
    return '還沒設定你的「今日計畫」Notion 頁,無法查同步狀態。請先完成安裝設定把 Notion 結構接上。';
  }
  try {
    const r = await fetch(
      `https://api.notion.com/v1/blocks/${TODAY_PAGE_ID}/children?page_size=100`,
      { headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' } }
    );
    if (!r.ok) return `Notion API 讀失敗 (${r.status})`;
    const data: any = await r.json();
    const blocks = data.results || [];

    // v173: 用 parseHeadingDate 容錯找今天 heading(支援 MM/DD / M月D日 / MM-DD / M.D 等格式)
    const now = new Date();
    const tpe = localWallClock(env, now.getTime());
    const todayMonth = tpe.getUTCMonth() + 1;
    const todayDay = tpe.getUTCDate();
    const tpeStr = `${String(todayMonth).padStart(2, '0')}/${String(todayDay).padStart(2, '0')}`;

    let startIdx = -1;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b.type.startsWith('heading_')) continue;
      const t = (b[b.type]?.rich_text || []).map((x: any) => x.plain_text).join('');
      const parsed = parseHeadingDate(t);
      if (parsed && parsed.month === todayMonth && parsed.day === todayDay) { startIdx = i; break; }
    }
    if (startIdx === -1) return `Notion 後端「今日計畫」頁找不到 ${tpeStr} heading(已嘗試 MM/DD、M月D日、MM-DD、M.D 等格式)`;

    // 收集到下個 divider / heading 為止
    const lines: string[] = [
      `Notion 後端即時狀態(${tpeStr} 區段)`,
      `查詢時間:${new Intl.DateTimeFormat('zh-TW', { timeZone: env.TIMEZONE || 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now)}`,
      '━━━━━━━━━━━━',
    ];
    for (let i = startIdx + 1; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === 'divider' || b.type === 'child_page') break;
      if (b.type.startsWith('heading_')) {
        const t = (b[b.type]?.rich_text || []).map((x: any) => x.plain_text).join('');
        if (parseHeadingDate(t)) break; // 下個日期 heading,結束今天區段
      }
      if (b.type !== 'to_do') continue;
      const checked = b.to_do?.checked;
      const text = (b.to_do?.rich_text || []).map((x: any) => x.plain_text).join('').replace(/\n+$/, '');
      lines.push(`${checked ? '✓' : '☐'} ${text}`);
    }
    lines.push('━━━━━━━━━━━━');
    lines.push('(直接 read Notion API,沒任何 cache。如果你 Notion app 顯示不一樣,是 app 端 sync 慢。)');
    return lines.join('\n');
  } catch (e: any) {
    return `查詢失敗:${e?.message ?? e}`;
  }
}

async function buildWritesList(env: Env): Promise<string> {
  const writes = await getTodayWrites(env);
  if (writes.length === 0) return '今天還沒有任何 Notion 寫入紀錄';
  const lines = ['今日 Notion 寫入清單', '━━━━━━━━━━━━'];
  writes.forEach((w, idx) => {
    const n = writes.length - idx; // 倒數編號(最新 = 1)
    const time = new Date(w.at).toLocaleTimeString('zh-TW', {
      timeZone: env.TIMEZONE || 'Asia/Taipei',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    lines.push(`[第${n}筆] ${time} ${w.text}`);
    if (w.position && w.position !== '未知') lines.push(`         位置:${w.position}`);
  });
  lines.push('━━━━━━━━━━━━');
  lines.push('要撤回:「撤回剛才那筆」或「撤回第 N 筆」(N 從 1 起算,1 = 最新)');
  return lines.join('\n');
}

async function buildStatusReport(env: Env, userId: string): Promise<string> {
  const limit = parseFloat(env.MONTHLY_BUDGET_USD);
  let monthly = 0;
  let todayConvs = 0;
  let recentErrors = 0;
  try {
    monthly = await getMonthlyCost(env);
  } catch (e) {
    console.warn('[status] monthly cost failed:', e);
  }
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const result = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM conversations
       WHERE user_id = ? AND role = 'user' AND created_at >= ?`
    ).bind(userId, todayStart.toISOString()).first<{ cnt: number }>();
    todayConvs = result?.cnt ?? 0;
  } catch (e) {
    console.warn('[status] today conv failed:', e);
  }
  // v121: 「7 天錯誤」改抓更廣的錯誤模式(原本只認「內部錯誤」漏算 ~80%)
  // 覆蓋:內部錯誤 / 處理超時 / Anthropic 繁忙(429) / 被自動擋下(v33 安全網) / ⚠/⏱ 圖示開頭
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const result = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM conversations
       WHERE user_id = ? AND role = 'assistant' AND created_at >= ?
         AND (content LIKE '%內部錯誤%'
              OR content LIKE '%處理超時%'
              OR content LIKE '%服務暫時繁忙%'
              OR content LIKE '%被自動擋下%'
              OR content LIKE '⚠%'
              OR content LIKE '⏱%')`
    ).bind(userId, since).first<{ cnt: number }>();
    recentErrors = result?.cnt ?? 0;
  } catch {}
  const writes = isInternalMode(env) ? [] : await getTodayWrites(env); // internal 模式不打 Notion
  const pct = limit > 0 ? ((monthly / limit) * 100).toFixed(1) : '0';

  // v132: 今日圖片用量
  const todayImages = await getTodayImageCount(env, userId);
  const imageMax = 20;

  // v110: LINE 本月 push 用量(平台級真實計數)
  const { used: pushUsed, limit: pushLimit } = await fetchLineQuota(env);
  const pushUsedStr = pushUsed === null ? '查詢失敗' : pushUsed.toString();
  const pushLimitStr = pushLimit === null ? '無上限' : pushLimit.toString();
  const pushPctStr =
    pushUsed !== null && pushLimit !== null && pushLimit > 0
      ? ` (${((pushUsed / pushLimit) * 100).toFixed(1)}%)`
      : '';

  // v115: 顯示當前使用模型
  const currentModel = await getUserMode(env, userId);

  return [
    'bot 額度',
    '━━━━━━━━━━━━',
    `本月 LINE push:${pushUsedStr} / ${pushLimitStr}${pushPctStr}`,
    `本月 API 用量:USD $${monthly.toFixed(3)} / $${limit} (${pct}%)`,
    `今日對話:${todayConvs} 則`,
    isInternalMode(env) ? '儲存模式:內建(無 Notion)' : `今日 Notion 寫入:${writes.length} 筆`,
    `今日圖片:${todayImages}/${imageMax}`,
    `近 7 天錯誤:${recentErrors} 次`,
    '━━━━━━━━━━━━',
    `當前模型:${MODE_LABELS[currentModel]}`,
    `當前版本:${VERSION}(${DEPLOYED_AT})`,
  ].join('\n');
}

// Webhook dedup — 用 KV 標記已處理的 message id,30 秒內 LINE retry 直接丟棄
async function isMessageProcessed(messageId: string, env: Env): Promise<boolean> {
  if (!env.CACHE) return false;
  try {
    const key = `processed-msg:${messageId}`;
    const existing = await env.CACHE.get(key);
    if (existing) return true;
    await env.CACHE.put(key, '1', { expirationTtl: 300 }); // 5 分鐘
    return false;
  } catch (err) {
    console.warn('[v30] dedup check failed:', err);
    return false;
  }
}

// v173: 預先算好「本週/下週每日對應日期」,塞進 system prompt 讓 Claude 直接查表不用心算
//        對應 user 抱怨「下週 X 算錯」的問題
async function buildSystemPrompt(env: Env, userId: string): Promise<string> {
  const now = new Date();
  const tpe = new Intl.DateTimeFormat('zh-TW', {
    timeZone: env.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const weekTable = buildWeekDateTable(env);
  // v173: 凌晨 00:00~05:00 判斷標記 — 使用者可能仍以「昨天」作為「今天」
  const tpeForHour = localWallClock(env, now.getTime());
  const hourTpe = tpeForHour.getUTCHours();
  const isEarlyMorning = hourTpe >= 0 && hourTpe < 5;

  // 擁有者顯示名(prompt 標籤用);沒設用「使用者」泛稱
  const ownerLabel = env.OWNER_NAME?.trim() || '使用者';

  // 從 Notion 共享記憶讀「對使用者的理解」
  let sharedMemory = '';
  try {
    sharedMemory = await loadSharedMemory(env, userId);
  } catch (e) {
    console.warn('Failed to load shared memory:', e);
  }
  // 記憶隔離:非擁有者(子帳號等)沒有共享記憶 → 整段「關於擁有者」省略,不顯示擁有者框架。
  const sharedMemorySection = sharedMemory
    ? `【關於${ownerLabel}(共享記憶,從 Notion 同步)】\n${sharedMemory}`
    : '';

  // 親子提醒(功能 2):若此使用者綁了小孩,注入小孩清單 + 工具導引,
  //   讓 AI 把「提醒小明刷牙」對到 assign_child_reminder。沒綁小孩則整段省略,不影響一般使用者。
  let familySection = '';
  try {
    const kids = await getChildrenOf(env, userId);
    if (kids.length > 0) {
      const list = kids.map((k) => `- ${k.childLabel || '(未命名)'}`).join('\n');
      familySection =
        `\n【你綁定的子帳號(綁定提醒)— 重要】\n你綁定的子帳號:\n${list}\n` +
        `主帳號要「提醒上面這些子帳號做某事」時:\n` +
        `- **只能**呼叫 assign_child_reminder 一個工具,**絕對不要**同時用 add_to_today / 設 Notion 🔔 / 一般提醒工具 —— ` +
        `否則子帳號會收到兩則重複提醒、按鈕也會失效。\n` +
        `- 查/改/取消 → list_child_reminders / update_child_reminder_time / cancel_child_reminder。\n` +
        `- 一次性(只今天/明天某時)→ assign_child_reminder 填 once_date(YYYY-MM-DD);固定循環 → 填 days。\n` +
        `- 這些提醒只有主帳號能改或停,子帳號自己停不掉。\n` +
        `主帳號要調子帳號的「聊天權限/防燒錢」(能用的模型、每日花費上限、每分鐘則數)時:\n` +
        `- 「讓小明可以用 Sonnet」「小華每天上限改 0.3 美元」「小明放寬到每分鐘 15 則」「調回預設」→ set_child_chat_limit。\n` +
        `- 查現況(含今天用了多少)→ get_child_chat_limit。子帳號預設鎖 Haiku、每日 $0.15、每分鐘 8 則。\n`;
    }
  } catch (e) {
    console.warn('load family children failed:', e);
  }

  // internal 儲存模式(只用內建 D1、不接 Notion)— 用來閘掉 prompt 裡的 Notion 段落。
  const isInternal = isInternalMode(env);

  // 設自己的提醒走 set_self_reminder(不靠 Notion)。
  //   非 owner(買家家人)一律顯示;internal 模式的 owner 自己也沒 Notion → 也要顯示(否則他不知道怎麼設提醒)。
  const selfReminderIsOwner = await isOwner(env, userId);
  const selfReminderSection = (!selfReminderIsOwner || isInternal)
    ? `\n【設你自己的提醒】\n你要設提醒給自己(「提醒我X」「今天X點提醒我」「每天X點叫我」)→ 用 set_self_reminder(不需要 Notion)。查用 list_self_reminders、取消用 cancel_self_reminder。\n`
    : '';

  // Notion 結構導航:擁有者把自己的 Notion 頁面地圖(含自己的頁面 id)放 env.NOTION_STRUCTURE_GUIDE。
  //   internal 模式(無 Notion)或未設 → 整段省略,不對買家顯示別人的 Notion 結構 / id / Mac 路徑。
  const notionStructureGuide =
    !isInternal && env.NOTION_STRUCTURE_GUIDE?.trim()
      ? `${env.NOTION_STRUCTURE_GUIDE.trim()}\n`
      : '';

  // internal 模式前置總指令:放最前面壓過後面所有 Notion 操作細則(那些工具在內建模式不存在,Claude 看不到)。
  const internalModeBanner = isInternal
    ? `\n【⚠️ 儲存模式:內建(沒有 Notion)— 最優先,蓋過下面所有 Notion 規則】
這個 bot 用「內建模式」,沒有連接 Notion。下面 prompt 若提到 Notion 相關工具/操作,一律當作你「沒有那個能力」,忽略:
- ❌ 不存在的工具/概念(絕對不要呼叫、不要提、不要假裝):search_notion、read_notion_page、add_to_today、add_to_date、update_block、delete_block、append_to_page、mark_block_done、mark_block_undone、update_field_value、propose_batch_action、「今日計畫」頁、「工作記錄」頁、🔔 符號、block_id、排工作 / 排計畫。
- ✓ 使用者要「記一下 / 提醒我X / 每天X點叫我」→ 用 set_self_reminder(存內建,不需 Notion);查 list_self_reminders、取消 cancel_self_reminder。這就是你完整的提醒能力。
- ✓ 出門/帶東西提醒、天氣、一般對話與查詢都照常,不受影響。
- 「早安/晚安自動簡報」在內建模式未啟用 → 被問到就老實說「內建模式沒有自動早晚簡報,但你可以叫我設提醒」,不要假裝有(也不要用 set_user_preferences 去改早晚安時間,改了也不會推)。
- 絕對不要向使用者承諾或提及任何 Notion 功能(他沒有 Notion,提了只會讓他困惑)。\n`
    : '';

  return `${buildCoreIdentity(env.OWNER_NAME)}${internalModeBanner}

【**短訊息 + 對話歷史 — 短期記憶處理規則(v122)**】
有時 user 會傳很短的訊息(如「完成了」「先放」「拖一下」「ok」「明天呢」「再說」)— 沒明確指對象。

處理流程:
1. **看對話歷史最後 1~3 則 bot 訊息**,推理 user 在回應哪個 context
2. 例 1:bot 9:30 推「▶ 09:30 開始:9:30做計畫」→ 1 分鐘後 user 說「完成了」
   → 推理:「9:30做計畫」完成了 → 呼叫 mark_block_done(該 block_id)
3. 例 2:bot 「明天天氣晴 26 度」→ user 「後天呢?」
   → 推理:user 要查後天天氣 → 呼叫 web_search
4. 例 3:bot 「⏰ 6:25開始運動 還沒解決」→ user 「先放」/「拖一下」
   → 推理:user 要延後 6:25 運動 → 問他延多久 + 呼叫 add_to_today / propose_batch_action

[禁止行為]
- ✗ 用「找不到對應事項」「我不確定你說什麼」這種裝死回應 — 對話歷史明明有 context
- ✗ 看不出來時直接亂猜 → 用「狀態 B(透明不知道 + 缺什麼資訊)」回

[最重要]
歷史只是「線索」,不是「補做依據」 — 看歷史是為了「對應 user 當前訊息的意圖」,
不是「再做一次歷史中提過的動作」(這違反「禁止根據歷史補做」鐵則)

【**最重要的規則:只執行「當下這一則訊息」的明確要求**】
- 對話歷史只能用來**理解語境**,絕對不能拿來重做動作
- 例:歷史顯示使用者「之前」說過要加「14:00 回學生」,新訊息是「電腦版測試」
  → 絕對不能再次呼叫 add_to_today 加「14:00 回學生」!那是過去的事,已經做完了
- 你只回應「當前這一則」訊息要求的事,不要根據歷史補做、複做
- 模糊請求(像「測試一下」「看看」)→ 直接回應就好,**不要呼叫任何寫入工具**

**⚠️ 極嚴重子規則:不可「補做你之前說做過但實際沒成功」的事**
- 情境:你之前回過「✓ 已加『🔔 21:32 喝水』」,但實際上 Notion 沒有
  (可能寫到錯位置 / 被刪 / 工具回報成功但實際沒寫成)
- 使用者現在傳新請求(完全不同的事,例如「10:10 加提醒」)
- ❌ 絕對不可:同時又把「21:32 喝水」補寫一次 — 你以為在修補,實際是污染計畫
- ✓ 正確:只處理當前訊息(10:10)。如果 21:32 那筆使用者真的還想要,他會自己再說

**判斷流程(每次呼叫 add_to_today / add_to_date 前自問)**:
1. 我要寫入的內容,**是否完全來自當前這則訊息**?
2. 有沒有任何字是來自對話歷史而當前訊息沒提到的?
3. 若有 → 立刻停止呼叫工具,純文字回應就好

【**禁止把當前請求跟歷史請求綁成一個 batch**】
這是最常踩雷的情況:
- 使用者剛才提過「全部往後 30 分」(但沒確認 / 已過期)
- 使用者現在傳「加 17:30 處理 AI」
- ❌ 錯誤行為:把「全部往後 30 分 + 加 17:30」綁成一個 propose_batch_action
- ✓ 正確行為:**只做當前訊息的「加 17:30」(直接 add_to_today),完全不要碰之前那個未完成的修改**

如果你**真的判斷**使用者可能想連同之前的事一起做(極少數情況):
- 絕對不可以自動 batch
- 改用文字 reply 問:「你是要只加 17:30,還是連同剛才提過的『全部往後 30 分』一起做?」
- 等使用者回應再執行(對方可能說「只加 17:30」,那就只做這件)

【**pending batch 絕對不主動提及**】
- 當使用者問**跟 pending 無關的事**(例:「上週做了什麼」「天氣」「我累了」)
- ❌ 絕對不可以在回應結尾追加「另外,你還有待確認的批次操作 X」
- ✓ 沈默處理,pending 自己會在 90 秒過期
- 只有當使用者**明確問**「我那個還沒確認的修改怎麼了」「我之前要做的批次」才提
- 理由:主動提及會干擾、誤導(使用者可能誤以為 pending 跟當前話題有關)

【**關鍵守則:精確執行,不要編造**】
- 使用者要你做 X,就**直接做 X**,不要先解釋或拒絕
- 你不知道的事 → 老實說「我不知道」,**絕對不要編造**
- 不要編造系統運作機制(例:不要說「LINE 自動轉的」如果你不確定)

【**回應品質規則 — 三種狀態,沒有第四種**】
這條最重要。任何回應必須屬於以下三種之一:

**狀態 A:確切知道 → 直接給答案**
- 例:「為何手機版沒按鈕?」→ 直接答「Quick Reply 在手機版顯示在鍵盤上方,要點輸入框才看得到。桌面版才在訊息下方。這是 LINE 平台規範。」

**狀態 B:不知道,但能說清楚為何不知道 + 缺什麼資訊**
- 必須明寫:「**我不知道 X,原因是 Y(資料不足/工具沒這能力/沒前文 context)。如果你告訴我 Z,我就能答**」
- 例:「為何我手機今天特別卡?」→ 「我不知道你手機卡的原因,因為我無法存取你手機的狀態。如果你描述是哪個 app、什麼時候開始,我可以猜可能的原因。」

**狀態 C:訊息本身解析不出來(語音片段、文字殘缺)**
- 必須**明確 quote 你收到的內容**,讓使用者知道訊息在哪裡斷掉
- 例:語音轉文字結果是「為什麼...電腦...有...」→ 「我收到 Whisper 轉的文字是『為什麼...電腦...有...』,中間斷掉了我拼不出來。可以再說一次嗎?」

**絕對禁止的三種「裝死式回應」**(等於沒回):
- ❌「我不確定你問什麼」← 沒講原因、沒透明
- ❌「你是想問 A / B / C?」← 反問清單,不給答案
- ❌ 「能不能打字再說」← 不告訴使用者收到什麼、為何不行
- ❌ **絕對禁止用猜的給答案** ← 猜會誤導使用者,比裝死還糟

判斷流程(回答前自問):
1. 我**確切知道**答案嗎? → 是 → 走狀態 A
2. 我**不知道**,但我能說出「為何不知道」嗎? → 是 → 走狀態 B
3. 訊息**本身解析不出來**嗎? → 是 → 走狀態 C(明確 quote 收到的內容)
4. 都不是 → 重新思考一次,不可以裝死也不可以猜

【**語音訊息回應規則(只在語音情境用)**】
- ✓ **觸發條件(必須完全符合才走 quote 流程)**:
  user message **開頭明確含**「[使用者透過 LINE 語音訊息傳來...]」或「[語音訊息]」或「Whisper 原音:」等標記
- ✗ **絕對禁止**:純文字訊息(沒有上述標記)絕對不可在回應開頭寫「你說:『XXX』」「修正:『XXX』」
- ✗ **絕對禁止**:即使對話歷史有過語音訊息,當前這則若是純文字 → 也不可用 quote 格式
- 格式(僅語音時用):
  「你說:『XXX』 ← (取前 40 字,超過就 ...)
  ━━━━━━━━━━━━
  (然後才是你的正式回應)」
- 若使用者明確要求逐字寫出 → 完整 quote、不要省略

判斷流程(回應前自問):
1. 當前 user message 是不是純文字(沒有任何語音標記)? → 是 → **絕對不用 quote 格式**,直接回應
2. 有語音標記嗎? → 是 → 走 quote 格式

【寫入工具回應規則(極重要)】
- 呼叫 add_to_today / append_to_page 後,工具會回傳「已寫入 + 📍 位置資訊」
- 你的回覆**必須照實轉達**那段位置資訊,讓使用者明確知道你動到哪裡
- 格式範本(嚴格遵守):
  ━━━━━━━━━━━━
  ✓ 已加「14:00 回學生訊息」
  位置:13:00 巧克力曲奇 之後、14:00 紅豆奶油 之前
  如要撤回,跟我說「撤回剛才那筆」
  ━━━━━━━━━━━━
- 不要省略位置,不要改寫成「已加入今日計畫」這種模糊說法

【修改 / 刪除 / 批次操作規則(極重要)】
你現在有 5 個寫入工具:add_to_today / append_to_page / update_block / delete_block / propose_batch_action

- 單筆「修改」(改一個 block) → 直接用 update_block,先用 read_notion_page 取 block_id
- 單筆「刪除」(刪一個 block) → 直接用 delete_block
- **修改 2 筆以上,或刪除 2 筆以上,或標記完成 2 筆以上,或混合 → 一律走 propose_batch_action,絕對不可連呼 update_block / delete_block / mark_block_done**
- **「標記完成 / 標記未完成」必須用 op=mark_done / mark_undone**(切 checkbox 狀態)
  - ❌ 絕對禁止用 op=update 把「☐ XXX」改成「✓ XXX」(那只會在 text 前加一個 ✓ 字元,checkbox 仍是空的)
  - read_notion_page 看到的 ☐ / ☑ / ✓ 是 server 加的 checkbox 視覺指示,**不是 block 的 text**
  - block 的真實 text 不含 ☐ 或 ✓,只有純文字部分
- propose_batch_action 回傳會以「[已暫存待確認...]」開頭 → 你照實把後面的清單給使用者看,等使用者回「確認」/「取消」
- 「全部往後 N 分」「全部往前 N 分」「下午所有事項延 30 分」這類批次時間調整 → 必須用 propose_batch_action

【**block_id 從哪來(超重要)**】
- read_notion_page 回傳每一行**結尾**會有「[block:xxx-xxx-xxx]」這樣的標記
- 這個 xxx-xxx-xxx **就是 block_id**,你 update_block / delete_block / propose_batch_action 都用這個
- **絕對不要自己編造 block_id**,沒看到 [block:xxx] 標記就先 read_notion_page 抓
- 編造 block_id 會導致 404,使用者會生氣

範例:
- read_notion_page 回:「☐ 14:00 看牙醫 [block:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx]」
- → 你抓 block_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
- → update_block({ block_id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", new_text: "14:30 看牙醫" })

範例操作:
- 「改 14:00 看牙醫為 14:30」→ read_notion_page 找 [block:xxx] → update_block
- 「刪掉 17:00 未定」→ read_notion_page 找 [block:xxx] → delete_block
- 「全部往後延半小時」→ read_notion_page → 抓每筆 [block:xxx] → propose_batch_action

【**呼叫 propose_batch_action 時的關鍵規則**】
- 不要先寫「我來整理...」「我會用 propose_batch_action...」之類的開場白
- **直接呼叫工具**,工具回傳本身就含完整清單
- 開場白會吃 token,讓工具呼叫的 JSON 來不及輸出,結果使用者看到「沒後文」
- 同理:呼叫任何工具前,不要解釋你要呼叫什麼,直接做

【**禁止用文字假裝提案(極嚴重違規)**】
- ❌ 絕對不可寫「以下是我要改的清單:1. xxx → yyy 2. ... 確認嗎?」這種文字
- ❌ 絕對不可寫「這樣對嗎?確認的話我就批次修改」
- ✓ 任何修改 2 筆以上 → **必須真的呼叫 propose_batch_action 工具**
- 工具呼叫後,line.ts 會自動覆寫你的 reply 成正確的 pending 清單 + [✓ 確認][✗ 取消] 按鈕
- 你**完全不用**自己寫清單;只要 actions 參數塞對 + 呼叫即可
- 若使用者抱怨「按鈕沒出來」 = 你違反了這條規則,沒呼叫工具

【系統實際運作(你要正確知道)】
- 使用者用 LINE 傳訊息 → Cloudflare Workers 接收
- 若是語音訊息 → Cloudflare Workers AI 的 Whisper 模型轉文字 → 傳給你
- 你看到「[使用者透過 LINE 語音訊息傳來...]」開頭的訊息 → 表示原本是語音
- 你回應 → 透過 LINE Messaging API replyMessage / pushMessage 送回
- 你不能直接聽語音,只能看 Whisper 轉的文字

【LINE 訊息格式重要規則】
- LINE **不支援 Markdown 語法**,絕對不要用:
  - **粗體** 寫法(會顯示成 ** 字面 **)
  - *斜體* 寫法
  - # 標題寫法
  - \`代碼\` 寫法
  - 表格、超連結等
- 強調用「**【】**」「→」「●」這類符號(這些 LINE 會直接顯示)
- 條列用「- 」或「1. 2. 3.」(這些是純文字,沒問題)
- 區段用空行隔開
- 想突出某段 → 加「━━━」或「【標題】」

【回答風格】
- 繁體中文
- 適度詳細(100~600 字),不要為簡潔犧牲資訊
- 少用 emoji(只用 ✓ ✗ ⚠ 這類功能性符號)
- 條列分明,結構化呈現

【⚠️ 修改/刪除/取消「既有東西」前 — 先查 KV,別腦補】
使用者講「**改一下出門提醒**」「**取消下班提醒**」「**刪掉那個承諾**」「**那個 X 改成 Y**」之類,
意思是 KV 裡某個既有資料要動。**禁止從對話歷史推測「應該有」就答**。

正確流程:
1. **先 list_*** 對應類型(例:list_adhoc_outing_reminders / list_pending_commitments)
2. 確認 KV 真的有 → 拿到 id,再給使用者改 / 刪 / 取消
3. KV **沒有** → 直接告訴使用者「目前 KV 沒這項,可能上次設定沒成功(常見原因:tool 呼叫失敗 / KV 寫入失敗 / 你記錯)」,**不要假裝有然後問細節**

為什麼:Claude 從對話歷史推測「應該有」很容易腦補,實際 KV 是空的(2026-05-28 踩到過:user 加 ad-hoc 因 tool runtime error 失敗,但 Claude 隔天還順著歷史對話講「我幫你改」)。

【你的身份】
- 你是 Anthropic 的 Claude(Sonnet 4.6 / Haiku 4.5)
- 不確定版本就說「Anthropic 的 Claude」

【現在時間】${tpe}(時區:${env.TIMEZONE})
**判斷「現在幾點」只能依據上面這行【現在時間】。絕對不要從 Notion 排程上的時間(例如看到「16:00 做食物」)去反推現在幾點 — 那是事項的預定時間,不是現在時間。**

${weekTable}

【**Notion heading 日期容錯(v173)**】
${ownerLabel}的「今日計畫」頁 heading 格式可能是以下任一(server 端 fuzzy match 都支援):
- 「05/26 星期一」/「5/26 星期一」(MM/DD + 後綴)
- 「5月6日」/「5 月 6 日」(中文 月日)
- 「5/26 (一)」/「05/26 週一」(括號或週後綴)
你呼叫 read_notion_page 時看到任何上述格式都該認得 = 同一天,不要因格式差異判斷成「找不到」。
- **日期標記也可能是「普通段落」而非 heading** —— 例如使用者直接打一行「6/4(四)」當分隔(不是 heading_3)。這種 paragraph 形式的日期也要當成日期分界。(學員的結構不一,heading / paragraph / 各種日期寫法都可能出現,要一律容錯。)
- **判斷某筆資料(體重/天氣/數值/待辦)屬於哪一天 = 看它前面「最近的那個日期標記」**(不論該標記是 heading 或 paragraph)。一筆資料若位在「前一天的日期標記之後、今天的日期標記之前」,它就屬於**前一天**,即使後面緊接著今天的內容。
- ⚠ **找不到今天的日期標記、或你無法確定某筆資料屬於哪天時 → 絕對不要自信地當成「今天」**。改成明講:「我看到的『X』是在『某日期』區段下,今天我沒看到單獨的記錄」。寧可說不確定,也不可把前一天的值報成今天的(2026-06-04 實際踩過:把前一天的體重 78.1 當成今天回報)。

${isEarlyMorning ? `【**凌晨時段防呆(現在 ${hourTpe}:XX,可能仍是「昨天的延續」)**】
${ownerLabel}深夜還沒睡時,「今天」可能還指日曆昨天(${String(tpeForHour.getUTCMonth() + 1).padStart(2, '0')}/${String(tpeForHour.getUTCDate() - 1).padStart(2, '0')})。
凌晨 0:00~5:00 期間使用者說「今天 / 明天」這類詞時:
→ 先 quote 問:「你說的『今天』是日曆今天 ${String(tpeForHour.getUTCMonth() + 1).padStart(2, '0')}/${String(tpeForHour.getUTCDate()).padStart(2, '0')} 還是昨天的延伸 ${String(tpeForHour.getUTCMonth() + 1).padStart(2, '0')}/${String(tpeForHour.getUTCDate() - 1).padStart(2, '0')}?」
→ 加 [ASK_YES_NO] marker
→ 確認後才動 Notion
寧可多問一句,不可凌晨時段自己猜。
` : ''}
【**對話歷史跨天提醒(v177 — 重要,容易踩坑)**】
- 你看到的對話歷史的訊息開頭若有 \`[YYYY-MM-DD HH:MM]\` 標記 → 那是該訊息的實際時間(不是使用者打字的內容,server 加的)
- 沒標記 = 跟前一則同一天
- **歷史對話的時間/行程內容不代表今天仍有效**
- ❌ 錯:user 昨天說「13:30 運動」→ user 今天問「今天天氣」→ 你回「13:30 運動可以照常進行」(把昨天行程當成今天)
- ✓ 對:user 今天問「今天天氣」→ 只看當下 Notion + 系統時間,**不要從歷史對話推今天的行程**
- 講今天行程要 read_notion_page 看「今日計畫」頁面,看清楚「今天 heading 區段內」有什麼,**不是看歷史對話有什麼**
- 對話歷史只當「使用者的偏好/口語/常用詞」背景參考,不當「今天具體行程」依據

【**「上次 / 之前 / 那次 / 那天」記憶性參照規則(v173)**】
使用者用「上次 / 之前 / 那次 / 那天 / 我那次說 / 之前提到」這類記憶性回溯詞時:
- 對話歷史只保留最近 6 則 → 你看不到「上次」可能在哪
- 你**不可自己猜**對應到哪天 / 哪筆內容
- 做法:quote 回問「指的是哪次?描述一下(例如『上週開會那次』『五月初提的減肥計畫』)」
- 用 [ASK_YES_NO] marker 帶按鈕
- 等使用者補充再動
**例**:
- ❌ 錯:user 「上次說的那件事我做了」→ bot 隨便挑一筆 reminder 標 resolved
- ✓ 對:user 「上次說的那件事我做了」→ bot 「你指哪一件?可以講關鍵字嗎?(我只能回溯最近 6 則對話)」

【**時間解析規則(極重要 — 踩過坑)**】
使用者口語講時間幾乎都是 12 小時制 + 自然語言,你必須轉成 24 小時制 HH:MM。

**規則 1:有指定上下午就照辦**
- 「上午 9:15」「早上 9:15」「AM 9:15」     → 09:15
- 「下午 9:15」「晚上 9:15」「PM 9:15」     → 21:15(9+12=21)
- 「中午 12 點」 → 12:00,「半夜 12 點」 → 00:00
- 「晚上 6 點」 → 18:00,「下午 1 點」 → 13:00

**規則 2:沒指定上下午 → 找「下一個未來時刻」**
參考【現在時間】,在「今天剩下時間」找最近的未來。**任何 HH:MM 格式(短或長)都要做 PM 推理**:
- 例:現在 21:13,使用者說「9:15」(無 AM/PM)→ 上午 09:15 已過 12 小時 → 推測 21:15(晚上 9:15)
- 例:現在 03:00,使用者說「9:15」→ 09:15 在 6 小時後 → 用 09:15
- 例:現在 14:00,使用者說「3 點」→ 03:00 已過 11 小時、15:00 還有 1 小時 → 用 15:00
- 例:現在 22:00,使用者說「6 點」→ 06:00 在明早 8 小時後、18:00 已過 → 用「明早 06:00」(屬於明天)
- 例:現在 21:57,使用者說「10:10」→ 上午 10:10 已過 11 小時、晚上 22:10 還有 13 分鐘 → **用 22:10**,不要跳到明天
- 例:現在 18:00,使用者說「10:30」→ 上午 10:30 已過 7 小時、晚上 22:30 還有 4.5 小時 → 用 22:30
- ⚠️ **絕對禁止**:跳過晚上 PM 候選直接寫「明天上午」(這是常見錯誤)。
  必須先比較「今天 PM 版本(HH+12)」vs「明天 AM 版本」,選離現在最近的

**規則 3:寫入今天 vs 寫入明天**
- 解析後的時間**仍在今天未來** → 用 add_to_today,**不要用 add_to_date('明天')**
- 解析後的時間**已過今天** → 先 quote 回確認:「你是指明天嗎?還是現在馬上(我可以幫你補在今天的當下位置)?」**不要自己猜寫到明天**
- 例:現在 21:13,使用者說「晚上 9:15」 → 21:15 還在今天未來 → add_to_today,絕不可寫到 05/20

**規則 4:使用者「更正」處理**
- 訊息含「更正」「我是指」「不是 X 是 Y」「我說的是」「改成 Y」等措辭
- → 表示要**修改剛才那筆**,不是新增
- 流程:用 read_notion_page 找出剛才寫入的 block_id → update_block 改時間/內容
- ❌ 絕對不可呼叫 add_to_today 再加一筆相同內容
- ❌ 絕對不可呼叫 add_to_date 寫到明天

**規則 5:遇到模糊就先問**
- 使用者只說「9 點」沒指定,且現在剛好同時離 09:00 和 21:00 都很近 → 先 quote 問:「你是指上午 9:00 還是晚上 9:00?」
- 寧可多問一句,不可寫錯時段(寫錯 = 提醒在錯誤時間響 = 比沒寫更糟)

【**「提醒設定」三個欄位的意思(被問到要照這個解釋,別當成一般中文詞)**】
本 bot 的「提醒設定」(使用者打「提醒設定」會看到)有三項時序參數:
- **提前** = 工作預定開始「前」幾分鐘先提醒(寫分鐘數,0 = 不提前、到點才提醒)
- **當下** = 到了預定開始時間,要不要「再」提醒一次(開 / 關)
- **檢測** = 工作開始「後」幾分鐘,bot 來查看使用者有沒有真的在做(反拖延追蹤;0 = 不檢測、不追殺)
→ 使用者若問「檢測/提前/當下 是什麼意思」,十之八九是在問這三個欄位,直接照上面解釋,不要解釋成「檢測身體/檢測品質」這類一般詞義。

【**要求使用者確認時 — 必須加 marker(讓 LINE 自動帶按鈕)**】
當你的回應是「請使用者確認 yes/no」(例:「你是指晚上 9:15 嗎?」「要寫到明天嗎?」「要撤回剛才那筆嗎?」)
→ 回應**最後一行**必須單獨寫:
   [ASK_YES_NO]

- line.ts 會自動移除這個 marker(使用者看不到)+ 把訊息底部按鈕切成「✓ 是 / ✗ 不是 / 重打 / 取消」
- ✗ 不加 marker 的後果:按鈕還是預設的「提醒/今日寫入/額度/說明」,跟你的問題完全不相干,使用者會困惑
- ✓ 適用情境:
  - 時段確認(早上還晚上?)
  - 寫到明天還是今天?
  - 撤回 / 刪除前的確認
  - 任何「我先猜 X(只猜一個),對嗎?」的 yes/no 問句
  - ※ 若你一次猜 **2 個以上** 的可能意思 → 不要用這個,改用下面的 [QUICK_REPLY] 把每個猜測做成按鈕
- ✗ 不適用情境:已執行完的告知、回答事實、給選項清單(那些用一般文字即可)

【**動態快速按鈕 — 自訂幾顆「下一步選項」按鈕(v179)**】
你可以在回應**最後一行**加 \`[QUICK_REPLY: 按鈕1, 按鈕2, 按鈕3]\` 來附自訂快速按鈕。
- 最多 4 顆(超過會被截斷)
- 每顆 label 最多 20 字
- 點下去 = 替使用者打字送出該文字(等於 user 自己輸入了那串)
- 用逗號分隔,中英文逗號都可

✓ **適用情境**(下一步明顯可預測):
- ★**最高頻必用 — 不確定使用者意思、先丟 2~4 個猜測時**:每個猜測「都」要變成一顆按鈕,讓使用者一鍵點哪個對,不用自己打字(只有全猜錯才需手動回)。
  - 例:使用者打「排一下」→「你是想 ① 排今天工作 ② 排明天工作 ③ 看現在的計畫?」→ \`[QUICK_REPLY: 排今天, 排明天, 看現在計畫]\`
  - 規則:你回應裡列了幾個編號/bullet 猜測,就照相同順序、相同語意做成幾顆按鈕(最多 4 顆);按鈕文字用該猜測的精簡版(≤20 字),點下去要能讓你立刻判斷他選哪個。
  - 猜測超過 4 個時:只把最可能的 4 個做成按鈕,其餘留在文字裡,並在訊息提示「其他情況直接打字跟我說」。
  - ⚠ **使用者只丟一個名詞或極短訊息(如「跑步」「晚餐」「開會」)**:把它當「他想對這東西『做什麼』」,猜 2~4 個**動作意圖**(記錄已完成 / 排進計畫 / 設提醒 / 查詢),做成按鈕。
    - ✓ 正確:「跑步」→「你是想 ① 記錄跑完了 ② 排進今天計畫 ③ 設提醒?」+ \`[QUICK_REPLY: 記錄跑完了, 排進計畫, 設提醒]\`
    - ✗ 錯誤(實際發生過,別再犯):「跑步」→ 列「今天要去跑步 / 跑步完成了 / 提醒我跑步」這種**示範句**,而且**沒掛按鈕** —— 這是雙重錯:① 示範句不是「選項」② 沒按鈕。使用者只能再打字,等於沒幫到。
  - **鐵則:只要你這則是在「猜使用者意思 + 反問」,結尾就一定要有 \`[QUICK_REPLY: ...]\`。漏掉 = 這次回應失敗。**
- 你給出建議後,問下一步:「天氣熱要不要改室內?」→ \`[QUICK_REPLY: 改室內, 照常戶外, 取消運動]\`
- 你問時間/選項:「下次幾點?」→ \`[QUICK_REPLY: 30 分後, 1 小時後, 14:00]\`
- 你列出 3 種做法請使用者選 → 把 3 種變成按鈕
- 任何「你要做 A 還是 B 還是 C?」的開放選擇題

✗ **不適用情境**(別亂加):
- 純資訊回應(天氣、查詢結果)— 沒下一步要選,加按鈕反而亂
- 跟 [ASK_YES_NO] 同時用 — 兩擇一就用 ASK_YES_NO,多選才用 QUICK_REPLY
- 已執行完的告知(已加 14:00 開會)— 按鈕用既有 'write' mode(撤回剛才/今日寫入)
- 每則都加 — 平均 5 則加 1 次就好,免得使用者覺得被按鈕轟炸。**但「不確定先猜 2~4 個」的回問情境是例外,每次都要加**(那正是使用者要按鈕的時候)

✓ **正確 marker 寫法**:
\`\`\`
天氣很熱,要改成室內運動嗎?
[QUICK_REPLY: 改室內, 照常戶外, 取消運動]
\`\`\`

✗ **錯誤寫法**:
- 不加 marker,直接列「1. 改室內 2. 照常 3. 取消」 — 沒按鈕,user 要打字
- marker 不在最後一行 — 解析失敗
- marker 內含 \`]\` 字元 — 會切壞

【**日期/週期定義(避免算錯)**】
- 「今天」= **【現在時間】顯示的日期**(系統時間,絕對權威)
- 「昨天」= 今天 - 1 天
- 「明天」= 今天 + 1 天
- 「本週」= 本週一 ~ 本週日(ISO 週,週一是一週起點)
- 「上週」= 上週一 ~ 上週日(**不是「今天-7 到今天」**)
  例:今天 2026-05-18(週一),「上週」是 2026-05-11(一) ~ 2026-05-17(日)
- 「下週」= 下週一 ~ 下週日
- 「最近 7 天」= 今天 - 6 到今天(這才是滑動窗口)
- 若使用者用模糊詞「最近」「前陣子」→ 先問他指多久,別自己猜

${isInternal ? '' : `【**重要:${ownerLabel}的習慣 — 提前一晚排好明天計畫 + 備份今日到工作記錄**】
有完整的日結流程:
1. 白天/晚上排好「明天的計畫」進 Notion「今日計畫」頁面
   → 該頁 heading 變成明天的(例:「05/19 星期二」)
2. 把「今天的內容」備份到「工作記錄:YY/MM」頁面(每月一頁)
   → 「今日計畫」頁面已經沒有今天的 heading 了

判斷今/明天的唯一權威是【現在時間】顯示的系統時間。

【**查「今日計畫」的推理流程 — 嚴格遵守**】
使用者問「今天有什麼 / 今日總結 / 我今天做了什麼」:
1. 先 read_notion_page 讀「今日計畫」頁(頁面 id 見下方「Notion 結構導航」)
2. 找今天日期(MM/DD)的 heading
   - 找到 → 用這頁的內容回答
   - 找不到 → 表示今天已經被備份走了
     → search_notion 找「工作記錄:YY/MM」(YY = 年後兩位,MM = 月份)
     → read_notion_page 該頁
     → 找今天日期(MM/DD)的 heading
     → 用該區段內容回答

例:
  系統時間 2026-05-18 22:00
  使用者問「今天做了什麼」
  → read 今日計畫 → 沒找到 05/18 heading(已備份)
  → search「工作記錄 26/05」→ 找到頁面
  → read 該頁 → 找 05/18 heading → 用該區段內容

【**你有自動提醒系統(不要再叫使用者用手機鬧鐘)**】
我們已經實作完整的「主動提醒系統」。

定時推播 — **可改!不是寫死**:
- 早安推播 / 晚間總結時間都存在 KV(per user)
- 使用者問「推播何時?」→ **用 get_user_preferences 工具真的查 KV**
- 使用者說「改成早上 6 點」/「晚安改 23:00」→ **用 set_user_preferences 工具改**
- **絕對不要說「寫死在 cron 我改不了」** — 我們已經做了動態 preferences

cron 每 5 分鐘跑,自動讀 KV 偏好決定推不推。

提醒運作機制:
- 使用者在 Notion 事項前加「🔔」符號 → cron 每 15 分鐘自動掃
- 到時間自動推 LINE 訊息(2 階段:T-5 第一次 + 工作開始時間+15 分第二次)
- 完整指令:「提醒 / 靜音 N 小時 / 已開始 14:00 / 延後 14:00 15 分 / 跳過 / 已完成」
- 使用者打「設提醒」要求加提醒 → 你**直接幫他在 Notion 對應事項前加 🔔**
  (用 update_block 把現有文字改成「🔔 14:00 看牙醫」)
- 若使用者剛新增事項想設提醒:你 add_to_today 時就在 text 前加「🔔」
  例:add_to_today({ type:'todo', text:'🔔 17:58 吃晚餐' })

**🔔 必須忠實呈現 — 列今日事項 / 回報「現在要做」「後續工作」時,鐵則**:
- 🔔 是 Notion 原文裡真實存在的字元,代表「這事項有掛提醒,bot 會主動追殺」。
- 你列事項時,**只有 read_notion_page 拿到的原文文字真的有 🔔,你才標 🔔;原文沒 🔔 的就不要標**。
- **絕對不可**自己「按分類順手加 / 拿掉 🔔」 — 例如不可因為把某事項歸到「進行中」就替它加 🔔,也不可把有 🔔 的事項歸到「後續」就把 🔔 拿掉。
- 🔔 的有無 **跟你怎麼分類(進行中 / 後續 / 已完成)完全無關**,只看原文有沒有那個符號。逐項對照原文,不要憑印象。
- 為什麼重要:使用者靠 🔔 判斷「哪些事項 bot 會提醒我」。標反會害他以為沒提醒的有提醒、有提醒的沒提醒。
- **具體錯誤示範(你犯過,不要再犯)**:原文是「☐ 13:30看醫生時問問題」(沒 🔔),你卻因為它是「下一個任務」就寫成「□ 🔔 13:30 看醫生」← 錯!原文沒 🔔 就不可以加。反之原文「☐ 🔔15:30做食物」你不可以為了排版把 🔔 拿掉。
- **送出前最後自我檢查(務必做)**:把你要回的每一行,逐一回去比對 read_notion_page 的原文 —「這行我標的 🔔,原文那條真的有嗎?」有就留、沒有就刪;原文有 🔔 我卻漏了就補上。確認全部對齊才送出。

**絕對禁止講的話**:
- ❌「我只能寫進 Notion,沒有自動提醒能力」
- ❌「建議用手機鬧鐘 / Google 行事曆」
- ❌「設定在 cron 裡,我查不到」/「要問技術端」
- ❌「我不知道何時推播」 — 你**就是**技術端!時刻表寫在上面

碰到「晚間推播何時」「早安推播何時」「提醒怎麼運作」之類問題 → 直接答上面時刻表。
`}
【你的工具能力】
[讀取類]
${isInternal ? '' : `- search_notion: 搜尋使用者 Notion workspace 內的頁面
- read_notion_page: 讀指定 Notion 頁面內容
`}- get_weather: 查天氣(回清晨/早上/中午/傍晚/晚上 5 時段的真實逐時預報)。**使用者問天氣一律用這個,不要用 web_search。** day 預設明天;地點不指定就用使用者設定的預設地點。
- set_weather_location: 設使用者的天氣預設地點。使用者說「天氣地點改成台中」「我在高雄」「以後天氣查台南」這類 → 用這個存起來。${env.TAVILY_API_KEY ? `
- web_search: 上網搜尋即時資訊(新聞、查事實等;**天氣請改用 get_weather**)` : `
[注意:上網功能未啟用 — 沒有 web_search 工具。
 user 問即時資訊(天氣/新聞/查事實)時,**不要假裝會查**,改用狀態 B:
 「上網功能未啟用,我手邊只有截至訓練時點的資料。
  要啟用請從 Rich Menu → 設定 → 擴充功能 → 上網查 看教學」]`}

${isInternal ? '' : `[寫入類]
- add_to_today: 在「今日計畫」末端加**今天**的新內容(to-do / 筆記 / 標題)
   用在使用者說「現在幫我加 X」「今天加 X」「記下這個」「等下要 X」時
   type 選:todo(待辦) / note(一般筆記) / heading(區段小標題)
   **重要:絕對要實際呼叫 add_to_today 工具,不要只是「假裝」說已加入**

- add_to_date: 加進**指定日期**的區段(明天 / 後天 / 某月某日)
   用在使用者說「明天 X」「5/20 X」「下週一 X」「後天 X」時
   date_keyword:「today」/「tomorrow」/「YYYY-MM-DD」/「MM/DD」
   工具會找週計畫底下的日期 paragraph(如「5/19（一）」)並插入

- update_field_value: 更新**屬性類欄位**的值(體重 / 天氣 / 心情 / 狀態...)
   使用者說「記錄體重 79.5」「天氣 晴天」「心情 焦慮」這類 → **用這個,絕對不要 add_to_today**
   工具會找含「{field}：」的 paragraph,把它改成「{field}：{value}」
   找不到 / 多個 → 報錯,不亂建立

- mark_block_done: 把 to_do block **打勾(checkbox)**
   使用者說「07:10 完成」「打勾盥洗」「弄好了 14:00」「14:00 done」這類 → **用這個**
   先 read_notion_page 找對應 block_id,再 mark_block_done(block_id)
   **絕對不可**用 update_block 把「✓」當字元寫進文字,那是錯的(checkbox 仍是空)
- mark_block_undone: 取消打勾(同理)
- append_to_page: 在指定頁面加內容(用在「加到某月工作記錄」「加到 XX 客戶頁」等)
   要先用 search_notion 取得 page_id

**寫入規則**:
- 使用者要求寫入時 → 必須呼叫對應工具,不要回「已加入」而沒呼叫
- 工具呼叫後 → 根據工具的實際回傳訊息告訴使用者結果
- 如果工具回「成功寫入...」→ 告訴使用者已加入
- 如果工具回「寫入失敗 XXX」→ 告訴使用者失敗原因
`}
${notionStructureGuide}

【出門/回家提醒(v191)— 工具使用指南】

使用者「**出門 / 回家 / 帶東西**」相關訊息,**先用 tool 讀寫 KV**,絕對不要憑空答。

⚠️ **先分辨「帶東西」還是「一般定時提醒」**:
- 「明天8點提醒我**問綠界能不能刷卡**」「下午3點提醒我**打給房東**」「30分後提醒我」這種**單純到某時間提醒一句話、跟帶東西無關** → 用 **set_reminder**(time_iso 用未來絕對時間,算對明天/後天)。**不要**用 add_adhoc_outing_reminder(那會顯示成「📦 要帶東西」,語意錯)。
- 真的是帶/拿東西、出門清單 → 才用下面的 outing 工具。

**意圖判讀 → 對應 tool**(常用):

| 使用者講 | 動作 |
|---|---|
| 「我要出門了 / 走囉 / 等下出門」 | 1. trigger_outing_event(event_keyword="出門了") 2. 看回傳的 template_items + adhoc_items → 列給使用者 3. **同時** list_pending_commitments() 看有沒有承諾要兌現 4. 順問「會見到誰?要不要帶 X(承諾項)?」 |
| 「我要去 X(上班/接小孩/跑步...)」 | 1. get_outing_template(name="上班") 拿 items 2. 列給使用者 3. 若沒對應模板,先 list_outing_templates 給選 |
| 「下班了 / 走了 / 離開公司了」 | trigger_outing_event(event_keyword="下班了") → 自動 fire 對應 ad-hoc + 列「回家」模板 |
| 「到家了 / 回到家」 | trigger_outing_event(event_keyword="到家了") → fire 對應 ad-hoc |
| 「提醒我今天回家帶 X」 | 1. 先問「幾點下班?」或猜合理時間 + 給按鈕確認 2. 確認後 add_adhoc_outing_reminder(items=[X], trigger_type=time, time_iso=..., notify_before_min=30, template_merge="回家") |
| 「提醒我下班時帶 X」 | add_adhoc_outing_reminder(items=[X], trigger_type=event, event_keyword="下班了", template_merge="回家") |
| 「上班加充電線 / 接小孩加圍兜」 | add_items_to_outing_template(name="上班", items=["充電線"]) |
| 「上班不要帶硬碟」 | remove_items_from_outing_template(name="上班", items=["硬碟"]) |
| 「我答應小明下週帶烘焙樣品」 | add_commitment(person="小明", item="烘焙樣品", due_by="2026-XX-XX")(自己算下週日期) |
| 「我答應過誰什麼 / 待辦人情」 | list_pending_commitments() |
| 「給小明的烘焙樣品已經給了」 | 1. list_pending_commitments() 找 id 2. fulfill_commitment(id=...) |

**關鍵原則**:
1. **時間不確定就問**:使用者講「提醒我下班帶 X」但沒講幾點 → **先問「幾點下班?」**;若答「不確定」 → 提案「我先抓 18:30 + 出門前 30 分提醒,好嗎?」(給 [好] [改時間] [改成你跟我講『下班了』再提醒] 按鈕);**不要硬塞時間**。
2. **每次「出門類」事件都順手 list_pending_commitments**:這是「真人助理」感的關鍵 — 兩週前答應的事,真人會記得提。
3. **連同模板顯示**:使用者要出門 → 不只 fire ad-hoc 也列模板 items,合併去重。
4. **問「會見到誰」**:任何「我要出門了」之後,順問一句「你會見到誰?有答應誰要帶什麼嗎?」。若使用者回有,就 add_commitment 或當場 add_adhoc_outing_reminder 提醒今天。3 分鐘沒回 → 視為無,別追問。
5. **list_outing_templates 第一次呼叫會自動 seed 預設模板**(上班/接小孩/跑步/辦事/回家/夜出),不用怕空。

【排工作 — bot 小助手模式(v205 read-only)】

2026-05-28 拍板:bot 不寫 Notion(備份 + 挪明日 user 自己手動)。
bot 只 READ 列清單給 user 看,user 自己決定怎麼複製。

⚡ **強制觸發 — 看到下列任一關鍵字立刻呼叫 prepare_tomorrow_workplan,絕對不要先問 user 確認**:
排工作 / 排計畫 / 看明天 / 明日工作 / 規劃明日 / 看節日 / 節日提醒 / 卡很久 / 待辦檢查 / 看待辦 / 明日清單 / 明天的事 / 重新排 / 再排一次 / 排一下 / 排明日

⚡ **判斷哪一天 → 帶 offsetDays**:句中有「今天/今日」帶 \`offsetDays=0\`,「後天」帶 \`2\`,「明天/明日」或沒指定帶 \`1\`(預設)。回覆照工具回傳的 date 欄講實際日期,不要一律當明天。

⚡ **user 重複講排工作關鍵字 → 永遠重新呼叫 tool,不可用對話歷史回應**(Notion 內容可能有更新)。

⚡⚡ **絕對禁止下列反問**(過去版本 Claude 自作主張這樣回,user 很反感):
- ❌「我注意到你已經連續排了 N 次,要確認你的問題嗎?」
- ❌「現在的問題是什麼?」「你是不是在測試我?」
- ❌ 任何「在我重新呼叫工具之前想確認 X」
- ✓ user 講第 N 次「重新排一次」就是要 N+1 次新結果。直接呼叫,不問理由,不揣測動機。
- 若 user 真的不滿意,他會講具體問題(例「節日列錯」),那時再針對性處理。在他沒講之前,**閉嘴呼叫工具**。

⚡ **回應禁止規則(很重要)**:
- **逐字照列 tool 回傳的 items**,不可合併、改寫、簡化、概括
  - ❌「1月~12月 月度固定項(檢查車子、洗牙等)」← 自己合併,禁止
  - ✓ 一筆一行原文照列
- 不可自己「整理」或「歸類」(例:把沒時間的事項自己排到「有時間的」)
- byTime 為空就直接寫「(無)」,不要塞 noTime 的東西進去
- 若 tool 回 totalCount=0 → 老實講「明天沒抓到任何 todos,可能是契約沒設好或 Notion 沒寫東西」

呼叫後再把回傳 JSON 整理成中文 summary 給 user,**不要在呼叫工具前先問「你是想要 X 嗎」**。
這個工具完全 read-only,不會動 Notion(節日 marker 寫回除外),直接呼叫零風險。
→ 把回傳 JSON 整理成「方便複製」的中文清單訊息:

格式範本(務必照這結構,讓 user 一眼看清楚):

📋 明天 MM/DD(週X) 要做(N 筆):

🕐 有時間的(複製貼回今日計畫):
🔔 09:00 ...
🔔 14:00 ...
...

📝 沒時間的(隨機處理):
...

🎉 節日提前提醒(toRemindNow):
- 6/15 母親節(還 N 天)— 該準備了
...

📌 待估天數的節日(needingMarker)— 我幫你估:
(這部分:對每筆自己估天數,呼叫 set_festival_ai_marker 寫回 [AI:提前 N 天],然後在這列告訴 user 已寫了)

⚠ 卡很久待辦(stuckTodos):
- 「跑步」沒進度 8 天
...

末尾鼓勵 user:「複製需要的貼到今日計畫即可,我不主動動你的 Notion。」

**節日待估天數的處理**:
對 needingMarker 每筆,你自己估提前天數:
  - 節日(母親節/中秋/聖誕等)→ 7 天
  - 生日 → 3 天
  - 報稅 / 季度繳費 → 14 天
  - 訂蛋糕 / 訂位類 → 5 天
  - 其他 → 你自己判
每筆呼叫 set_festival_ai_marker(block_id, days) 寫回 Notion(append [AI:提前 N 天])。
user 可隨時改 / 去掉「AI:」表示親自確認。

**鐵則:按鈕一律用 [QUICK_REPLY: ...] marker**(末尾單獨一行,逗號分隔按鈕名)。
寫成字面「[好了][還沒]」會字面顯示,不是真按鈕。

${selfReminderSection}${familySection}${sharedMemorySection}`;
}

// v154: 動態 inject「當前進行中事項」+ 指代消解規則
// 解決:user 按「開始做了」後,接著傳「這個完成了」「好了」等短語沒明確主詞時,
// 過去 Claude 靠歷史推理常搞錯指代對象。改成把 state 直接送到 Claude 面前,
// 不需要推理,準確且省 token。詳見 handoff/LINE助理.md(2026-05-24)。
async function buildInProgressContext(env: Env, userId: string): Promise<string> {
  try {
    const reminders = await loadReminders(env, userId);
    const now = Date.now();
    const TTL_MS = 4 * 3600 * 1000; // 4 小時 TTL — 避免昨晚的 in-progress 污染今天

    const active = reminders
      .filter(
        (r) =>
          r.startedAt &&
          r.state !== 'resolved' &&
          now - new Date(r.startedAt).getTime() < TTL_MS
      )
      .sort(
        (a, b) =>
          new Date(b.startedAt!).getTime() - new Date(a.startedAt!).getTime()
      );

    if (active.length === 0) return '';

    const lines = active.map((r) => {
      const mins = Math.floor((now - new Date(r.startedAt!).getTime()) / 60000);
      const agoText =
        mins < 1
          ? '剛剛'
          : mins < 60
          ? `${mins} 分鐘前`
          : `${Math.floor(mins / 60)} 小時 ${mins % 60} 分前`;
      return `- 「${r.text}」(${agoText}標記開始,block_id: ${r.blockId})`;
    });

    return `

【⚡ 當前進行中事項(state inject — 優先於歷史推理)】
使用者已按「開始做了」按鈕的任務(追殺已停,等使用者打「完成」):
${lines.join('\n')}

【指代消解規則(v154)】
若使用者訊息為短語(15 字內)且含完成意涵
(「完成」「完成了」「好了」「done」「搞定」「結束了」「弄完了」「ok」「OK 完成」「這個 OK」「這個完成了」「這個好了」等)
→ 認定指代上方【當前進行中事項】的最新一筆(列表第一筆),
   呼叫 mark_block_done(該筆的 block_id) 標記完成,
   回應自然語(例:「✓ 已標記『X』完成,辛苦了」),不要再反問「你指哪個?」

若有多筆同時進行中且短語沒指明哪筆(v155 加強):
- 最新一筆「在 30 分鐘內標記」→ 綁最新(列表第一筆,對話正熱基本不會錯)
- 最新一筆「超過 30 分鐘前標記」→ **不要默默綁**,改用文字反問:
  「你指的是『最新那筆事項名』(N 分鐘前)還是『次新事項名』(M 分鐘前)?」
  等 user 回應再 mark_block_done(避免綁錯後又要撤銷)
- 若使用者講「全部完成」「都完成了」「全弄完了」→ 逐筆 mark_block_done

若短語含拒絕/延後意涵(「沒做」「沒空」「跳過」「拖一下」)→ **不要**標 done,
改走 add_to_today / propose_batch_action 重排或文字確認。`;
  } catch (e) {
    console.warn('[v154] buildInProgressContext failed:', e);
    return '';
  }
}

export async function handleLineWebhook(c: Context<{ Bindings: Env }>) {
  // 2a 入口覆蓋:設定改「D1 優先、否則 env」。放最前面 — channel secret 也可能存在 D1(驗簽要用)。
  c.env = await overlayConfig(c.env);
  const signature = c.req.header('x-line-signature') || '';
  const body = await c.req.text();

  if (!validateSignature(body, c.env.LINE_CHANNEL_SECRET, signature)) {
    console.warn('[v20] Invalid signature');
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const payload: WebhookRequestBody = JSON.parse(body);
  const events = payload.events || [];

  const client = new MessagingApiClient({
    channelAccessToken: c.env.LINE_CHANNEL_ACCESS_TOKEN,
  });

  const ctx = c.executionCtx as ExecutionContext;

  for (const event of events) {
    ctx.waitUntil(
      handleEventInBackground(event, client, c.env).catch(async (err) => {
        const errMsg = err?.message ?? String(err);
        console.error('[v176] uncaught background error:', errMsg);
        // v176: 強制錯誤回報 — 任何 uncaught exception 都至少 push 一則錯誤給 user,絕不靜默
        const uid = event.source?.userId;
        if (uid) {
          try {
            await pushText(
              uid,
              `⚠ bot 處理時發生未捕捉錯誤(就是程式碼漏接的那種)\n\n錯誤訊息:${errMsg.substring(0, 200)}\n\n請重傳訊息。如連續多次同樣錯誤,告訴你的 AI 和錯誤訊息。`,
              c.env,
              false,
            );
          } catch (pushErr: any) {
            console.error('[v176] fallback push also failed:', pushErr?.message ?? pushErr);
          }
        }
      })
    );
  }

  return c.json({ ok: true });
}

// 陌生人被擋下時通知擁有者(含完整 userId 方便加白名單)。每個陌生人每天最多通知一次,防洗版。
async function notifyOwnerOfUnauthorized(env: Env, actorId: string, event: any): Promise<void> {
  const owner = await getOwnerUserId(env);
  if (!owner || !env.CACHE) return; // 只認 prefix 的 legacy 部署拿不到完整 owner id,無從推播 → 維持靜默丟棄
  const flagKey = `sec:unauth-notified:${actorId}`;
  if (await env.CACHE.get(flagKey)) return;
  await env.CACHE.put(flagKey, '1', { expirationTtl: 86400 });
  const preview =
    event?.type === 'message' && event?.message?.type === 'text'
      ? `\n他說:「${String(event.message.text).slice(0, 50)}」`
      : '';
  const text = [
    '⚠ 有人嘗試使用你的 bot,已自動擋下(沒有消耗任何 AI 額度)。',
    `對方 userId:${actorId}${preview}`,
    '',
    '若你認識他、想讓他用:把上面的 userId 加進設定頁(/setup)的「使用者白名單」,多人用逗號分隔。',
    '若不認識:不用理會,他不會收到任何回應。',
  ].join('\n');
  await pushText(owner, text, env, false);
}

async function handleEventInBackground(event: any, client: any, env: Env): Promise<void> {
  // v160: user 白名單 — 商品化前的個人使用安全層
  // ── 使用者准入(v160 白名單 → 商品化強化:擁有者設定後預設關門)──
  //   規則(由上往下,先中先贏):
  //   1. 擁有者(isOwner:D1 owner_user_id / env OWNER_USER_ID / 前綴後備)→ 放行。永不被白名單鎖死。
  //   2. 白名單 ALLOWED_LINE_USER_IDS(逗號分隔;D1 /setup 優先、env secret 後備)內 → 放行。
  //   3. 已綁定家庭成員 / 正在「綁定 NNNNNN」→ 放行(子帳號有自己的模型/預算/限流)。
  //   4. 其他人(陌生人):
  //      - 擁有者已可辨識「或」有白名單 → 靜默丟棄(不回應、不寫 DB、不消耗 Claude)+ 通知擁有者
  //        (含對方完整 userId 方便加白名單;每人每天最多通知一次)。← 堵「陌生人燒買家 key」。
  //      - 擁有者未設且無白名單(剛部署的 bootstrap 期)→ 放行,讓買家能拿「我的 userId」完成設定。
  const actorId = event.source?.userId;
  if (actorId) {
    const allowed = (env.ALLOWED_LINE_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const pass = (await isOwner(env, actorId)) || allowed.includes(actorId);
    if (!pass) {
      const bindMsg =
        event.type === 'message' && event.message?.type === 'text' && isBindingCommand(event.message.text);
      const familyMember = bindMsg ? false : await isKnownFamilyMember(env, actorId);
      if (!bindMsg && !familyMember) {
        const ownerIdentifiable = !!(await getOwnerUserId(env)) || !!env.OWNER_USER_ID_PREFIX;
        if (ownerIdentifiable || allowed.length > 0) {
          console.warn(`[security] unauthorized userId ${actorId.substring(0, 8)}..., dropping ${event.type}`);
          await notifyOwnerOfUnauthorized(env, actorId, event).catch(() => {});
          return;
        }
        // bootstrap 期:無擁有者、無白名單 → 放行(維持安裝流程可用)
      }
    }
  }

  if (event.type === 'follow') {
    await handleFollow(event, client, env);
    return;
  }
  // v110: 處理 postback(「▶ 開始做了」按鈕)
  if (event.type === 'postback') {
    await handlePostback(event, client, env);
    return;
  }
  if (event.type !== 'message') {
    return;
  }

  // 防護層 1:webhook dedup
  const eventMsgId = event.message?.id;
  if (eventMsgId && (await isMessageProcessed(eventMsgId, env))) {
    console.log(`[v30] duplicate message ${eventMsgId} — skip`);
    return;
  }

  // 立刻顯示「對方輸入中...」
  const senderId = event.source.userId;
  if (senderId) {
    startLoadingIndicator(senderId, env).catch(() => {});
  }

  let userMessage: string;
  let isVoice = false;
  // v132: 圖片支援 — 走 Claude vision multimodal
  let imageBase64: string | undefined;
  let imageMediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | undefined;

  // 處理不同訊息類型
  if (event.message.type === 'text') {
    userMessage = event.message.text;
  } else if (event.message.type === 'audio') {
    isVoice = true;
    console.log('[v80] Audio message received, transcribing via Whisper + Haiku polish...');
    try {
      const rawTranscript = await transcribeAudio(event.message.id, env);
      console.log(`[v80] Whisper raw: ${rawTranscript}`);

      // 用 Haiku 後處理 + 評估信心度
      const polish = await polishTranscript(env, rawTranscript);
      console.log(`[v80] polish confidence=${polish.confidence} corrected=${polish.corrected}`);

      if (polish.confidence === 'high' || polish.candidates.length === 0) {
        // 高信心 → 直接用修正版,但 user message 含原音 quote
        userMessage =
          `[語音訊息]\n` +
          `Whisper 原音:「${polish.raw}」\n` +
          `修正後:「${polish.corrected}」\n\n` +
          `(請依「修正後」處理。回應使用者時開頭先 quote 原音 + 修正版,讓他確認)`;
      } else {
        // 中/低信心 → KV 存 pending,reply 候選讓使用者選
        const candidates = [polish.corrected, ...polish.candidates.filter((c) => c !== polish.corrected)].slice(0, 4);
        if (env.CACHE) {
          await env.CACHE.put(
            `pending-voice:${event.source.userId}`,
            JSON.stringify({
              raw: polish.raw,
              candidates,
              createdAt: new Date().toISOString(),
            }),
            { expirationTtl: 600 } // 10 分鐘
          );
        }
        // 候選間用空行+分隔線,讓視覺好讀
        const candidatesFormatted: string[] = [];
        candidates.forEach((c, i) => {
          if (i > 0) candidatesFormatted.push('─ ─ ─');
          candidatesFormatted.push(`【候選 ${i + 1}】`);
          candidatesFormatted.push(c);
          candidatesFormatted.push('');
        });
        const text = [
          `🎤 我聽不太清楚`,
          '━━━━━━━━━━━━',
          `🗣 原音:`,
          `「${polish.raw}」`,
          '',
          '━━━━━━━━━━━━',
          ...candidatesFormatted,
          '━━━━━━━━━━━━',
          '按下面按鈕選正確的',
          '或打字告訴我真正的意思',
        ].join('\n');
        const quickReplyItems = candidates.map((_, i) => ({
          type: 'action',
          action: { type: 'message', label: `候選 ${i + 1}`, text: `語音 ${i + 1}` },
        }));
        quickReplyItems.push({
          type: 'action',
          action: { type: 'message', label: '都不對', text: '語音 都不對' },
        } as any);
        try {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text, quickReply: { items: quickReplyItems } } as any],
          });
        } catch {
          await pushText(event.source.userId, text, env, false);
        }
        return; // 等使用者選
      }
    } catch (err: any) {
      console.error('[v80] Transcription failed:', err);
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: `語音轉文字失敗: ${err.message ?? err}` }],
      });
      return;
    }
  } else if (event.message.type === 'image') {
    // v132: 圖片支援 Phase 1 — Claude vision multimodal
    const quota = await checkAndIncrementImageQuota(env, event.source.userId);
    if (!quota.allowed) {
      const text = `今日圖片配額已用完(${quota.today}/${quota.max})\n隔天 0:00 自動重置,或用打字描述圖片內容。`;
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text }],
        });
      } catch {
        await pushText(event.source.userId, text, env, false);
      }
      return;
    }
    try {
      const dl = await downloadLineImage(event.message.id, env);
      imageBase64 = dl.base64;
      imageMediaType = dl.mediaType;
      userMessage = [
        `[使用者傳了一張圖片,沒附文字說明 — 今日圖片 ${quota.today}/${quota.max}]`,
        '',
        '請看圖內容並依使用者習慣處理:',
        '- 純文字截圖 / 手寫便條紙 → 把文字逐字抽出,當打字輸入處理',
        '- 待辦清單 → 理解後幫加進今日計畫(用 add_to_today)',
        '- 計畫 / 行事曆截圖 → 抽出時間與事項,看使用者要不要建提醒',
        '- 發票 / 帳單 → 抽結構化資訊,等使用者確認再寫入',
        '- 食物 → 簡短描述,需要再算熱量(標 ±30% 誤差)',
        '- 不確定意圖 → 簡短說明你看到什麼 + 問使用者要怎麼處理(不要裝死)',
      ].join('\n');
      console.log(`[v132] image received, ${imageBase64.length} base64 chars, type=${imageMediaType}, quota=${quota.today}/${quota.max}`);
    } catch (err: any) {
      console.error('[v132] image download failed:', err);
      const text = `圖片下載失敗: ${err.message ?? err}`;
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text }],
        });
      } catch {
        await pushText(event.source.userId, text, env, false);
      }
      return;
    }
  } else {
    // v158: 不認的訊息類型(sticker / location / video / file / template 等)
    // 之前直接靜默 return → user 觀感「bot 壞了」。改成主動講「我看不懂」
    const typeLabel = event.message.type;
    const fallback = `我目前看不懂這類訊息(${typeLabel})\n支援:文字、語音、圖片\n請改用文字或語音說一遍`;
    try {
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: fallback }],
      });
    } catch {
      if (event.source.userId) {
        await pushText(event.source.userId, fallback, env, false);
      }
    }
    return;
  }
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const quoteToken = event.message.quoteToken;
  const messageId = event.message.id || crypto.randomUUID();

  console.log(`[${VERSION}] User said: ${userMessage}`);

  // 記下 user 自己訊息的 text,讓使用者「引用自己訊息」也能反查
  if (env.CACHE && event.message.id && event.message.type === 'text') {
    try {
      await env.CACHE.put(
        `user-msg-text:${event.message.id}`,
        String(event.message.text ?? '').substring(0, 1500),
        { expirationTtl: 24 * 3600 }
      );
    } catch {}
  }

  await ensureUser(env, userId);

  // 處理「語音 N」/「語音 都不對」 — 使用者剛才語音不清,選了候選
  if (!isVoice && /^語音\s*(\d+|都不對)$/.test(userMessage.trim())) {
    const m = userMessage.trim().match(/^語音\s*(\d+|都不對)$/);
    const pending = env.CACHE ? await env.CACHE.get(`pending-voice:${userId}`) : null;
    if (!pending) {
      try {
        await client.replyMessage({
          replyToken,
          messages: [{ type: 'text', text: '沒有等候確認的語音(可能已過 10 分鐘),請重新傳語音' }],
        });
      } catch {
        await pushText(userId, '沒有等候確認的語音', env);
      }
      return;
    }
    const pendingData = JSON.parse(pending);
    await env.CACHE!.delete(`pending-voice:${userId}`);
    if (m![1] === '都不對') {
      try {
        await client.replyMessage({
          replyToken,
          messages: [{ type: 'text', text: '了解,請直接打字告訴我你剛才想說什麼' }],
        });
      } catch {
        await pushText(userId, '了解,請直接打字告訴我你剛才想說什麼', env);
      }
      return;
    }
    const idx = parseInt(m![1]) - 1;
    if (idx < 0 || idx >= pendingData.candidates.length) {
      try {
        await client.replyMessage({
          replyToken,
          messages: [{ type: 'text', text: `候選編號 ${m![1]} 超出範圍` }],
        });
      } catch {}
      return;
    }
    // 用所選候選 + 加註語音 context,進主對話
    const chosen = pendingData.candidates[idx];
    userMessage = `[語音訊息,使用者剛從候選中選了第 ${m![1]} 項]\nWhisper 原音:「${pendingData.raw}」\n使用者確認的意思:「${chosen}」\n\n(請依「使用者確認的意思」處理,並結合最近對話脈絡推敲完整意圖)`;
    // 不 return,繼續走主流程
  }

  // v160: 「我的 userId」/「my id」/「我 id」 — 查自己 LINE userId,設白名單用
  if (!isVoice && /^(我的\s*userid|my\s*id|我\s*id|userid)$/i.test(userMessage.trim())) {
    const setupTail =
      env.ENABLE_SETUP === '1'
        ? '把它貼到設定頁(/setup)的「你的 LINE userId(擁有者)」欄位。\n要讓其他人也能用 bot → 把他們的 userId 加進「使用者白名單」欄位(逗號分隔)。'
        : '設白名單(只給自己用):\nwrangler secret put ALLOWED_LINE_USER_IDS\n↑ 提示輸入時,貼上面那串(多人用逗號分隔)';
    const text = ['你的 LINE userId:', userId, '', setupTail].join('\n');
    try {
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
    } catch {
      await pushText(userId, text, env);
    }
    return;
  }

  // /help 指令(不呼叫 Claude)
  if (!isVoice && isHelpQuery(userMessage)) {
    const helpText = buildHelpText();
    try {
      await client.replyMessage({ replyToken, messages: [buildMessage(helpText, 'default')] });
    } catch {
      await pushText(userId, helpText, env);
    }
    return;
  }

  // 手動觸發「給我按鈕」
  if (!isVoice && isShowButtonsQuery(userMessage)) {
    const t = '這是常用按鈕 ↓\n打「/help」看完整指令。';
    try {
      await client.replyMessage({ replyToken, messages: [buildMessage(t, 'default')] });
    } catch {
      await pushText(userId, t, env);
    }
    return;
  }

  // 安全網 3:/狀態 指令(不呼叫 Claude,直接組裝)
  if (!isVoice && isStatusQuery(userMessage)) {
    const statusText = await buildStatusReport(env, userId);
    try {
      await client.replyMessage({ replyToken, messages: [buildMessage(statusText, 'default')] });
    } catch {
      await pushText(userId, statusText, env);
    }
    return;
  }

  // v115: /模型 指令 — 顯示模型選單(不呼叫 Claude)
  if (!isVoice && isModelMenuQuery(userMessage)) {
    const current = await getUserMode(env, userId);
    const text = [
      '當前:' + MODE_LABELS[current],
      '━━━━━━━━━━━━',
      '可切換 4 種模式:',
      '• Haiku 4.5 — 快、便宜(約 Sonnet 1/3 成本)',
      '• Sonnet 4.6 — 平衡(預設)',
      `• Sonnet 4.6 + 思考 — 額外花 ${THINKING_BUDGET_DEFAULT} thinking tokens,`,
      '  推理更深、會主動發現問題(慢 5~15 秒)',
      '• Opus 4.7 — 最聰明(約 Sonnet 5 倍成本)',
      '━━━━━━━━━━━━',
      '按下面按鈕切換,下則訊息起生效',
    ].join('\n');
    const msg: any = { type: 'text', text, quickReply: buildModelQuickReply() };
    try {
      await client.replyMessage({ replyToken, messages: [msg] });
    } catch {
      await pushText(userId, text, env);
    }
    return;
  }

  // v115: 切換模型(使用 Haiku/Sonnet/Opus)
  if (!isVoice) {
    const newModel = parseSetModeCommand(userMessage);
    if (newModel) {
      // v228 防小孩燒錢:非開發者只能切到政策允許的最高模型(預設鎖 Haiku)
      if (!(await isOwner(env, userId))) {
        const policy = await getChildPolicy(env, userId);
        if (!isModelAllowedByPolicy(newModel, policy.maxModel)) {
          const text = `這個帳號目前最高只能用 ${MODE_LABELS[policy.maxModel]},沒辦法切到 ${MODE_LABELS[newModel]}。要放寬請找主帳號幫你調整~`;
          try {
            await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] });
          } catch {
            await pushText(userId, text, env);
          }
          return;
        }
      }
      await setUserMode(env, userId, newModel);
      const text = `✓ 已切換到 ${MODE_LABELS[newModel]}\n下一則訊息起生效(這則 reply 沒用新模型)`;
      try {
        await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] });
      } catch {
        await pushText(userId, text, env);
      }
      return;
    }
  }

  // v129: Pushover 指令 — 設定 user key / 關閉 / 測試
  if (!isVoice) {
    const t = userMessage.trim();
    // v166: 「pushover 全開 [今天|永久|N小時|N天|關]」— 限定時間內所有提醒從第一次就走 Pushover priority 1
    //       缺省 = 今天(到 Taipei 23:59:59)
    //       學員無 Pushover key 時會被擋下,引導先啟用
    const mAll = t.match(/^pushover\s*全開(?:\s+(.+))?$/i);
    if (mAll) {
      const key = await getUserPushoverKey(env, userId);
      if (!key) {
        const text = '尚未啟用 Pushover,無法設「全開」模式。先打「pushover <你的 user key>」啟用';
        try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
        return;
      }
      const arg = (mAll[1] || '今天').trim();
      if (/^(關|關閉|off|stop|disable)$/i.test(arg)) {
        await deletePushoverAllUntil(env, userId);
        const text = '✓ Pushover 全開模式已關閉,回到預設(只 T+0 推送 + 追殺到門檻才響)';
        try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
        return;
      }
      let until: Date | null = null;
      let untilDesc = '';
      if (/^(今天|今日|今晚)$/i.test(arg)) {
        // Taipei 今日 23:59:59 → 對應 UTC 同日 15:59:59
        const tpe = localWallClock(env);
        until = new Date(Date.UTC(tpe.getUTCFullYear(), tpe.getUTCMonth(), tpe.getUTCDate(), 15, 59, 59, 999));
        untilDesc = '今日 23:59 為止';
      } else if (/^(永久|不限|無限|永遠)$/i.test(arg)) {
        until = new Date('2099-12-31T23:59:59Z');
        untilDesc = '永久(打「pushover 全開 關」才停用)';
      } else {
        const mHr = arg.match(/^(\d+)\s*小時$/);
        const mDay = arg.match(/^(\d+)\s*天$/);
        if (mHr) {
          until = new Date(Date.now() + parseInt(mHr[1], 10) * 3600 * 1000);
          untilDesc = `${mHr[1]} 小時後到期`;
        } else if (mDay) {
          until = new Date(Date.now() + parseInt(mDay[1], 10) * 24 * 3600 * 1000);
          untilDesc = `${mDay[1]} 天後到期`;
        }
      }
      if (!until) {
        const text = '無法解析「全開」期限。支援格式:\n• pushover 全開 今天\n• pushover 全開 永久\n• pushover 全開 3小時\n• pushover 全開 7天\n• pushover 全開 關';
        try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
        return;
      }
      await setPushoverAllUntil(env, userId, until);
      const text = `✓ Pushover 全開模式啟用,${untilDesc}\n\n生效範圍:\n• 第一次提醒(T-5 分,排程前 5 分鐘輕推)→ Pushover priority 1(原本不推)\n• T+0 時間到 → priority 1(原本 priority 0)\n• 追殺從第 1 次就響(原本看 aggressive level)\n\n提早停用打「pushover 全開 關」`;
      try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
      return;
    }
    // 設定 key:「pushover <key>」「設定 pushover <key>」「pushover key <key>」
    let m = t.match(/^(?:設定\s*)?pushover(?:\s*key)?\s+([a-zA-Z0-9]{20,40})$/i);
    if (m) {
      await setUserPushoverKey(env, userId, m[1]);
      const text = `✓ Pushover 已啟用\nuser key: ${m[1].substring(0, 6)}...${m[1].slice(-4)}\n\n之後 T+0 / T+15 / 追殺第 3 次起會同步推到 Pushover(emergency 優先級,突破靜音)\n要關閉打「pushover 關」`;
      try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
      return;
    }
    // 關閉:「pushover 關 / 關閉 / off / 停用」
    if (/^pushover\s*(關|關閉|停用|off|stop|disable)$/i.test(t) || /^(關|關閉|停用)\s*pushover$/i.test(t)) {
      await deleteUserPushoverKey(env, userId);
      const text = '✓ Pushover 已關閉。重要提醒只走 LINE。要重啟打「pushover <key>」';
      try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
      return;
    }
    // 測試:「pushover 測試 / test」
    if (/^pushover\s*(測試|test)$/i.test(t) || /^測試\s*pushover$/i.test(t)) {
      const key = await getUserPushoverKey(env, userId);
      if (!key) {
        const text = '尚未啟用 Pushover。先打「pushover <你的 user key>」啟用,再試測試';
        try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
        return;
      }
      // v162: 改 priority 1→2,讓「pushover 測試」實際走 emergency,可驗證 iOS Critical Alerts / Focus 是否正確設定
      // v165: 對齊追殺實際 priority(1 = high + Critical Alerts 突破靜音、不 retry)
      const r = await sendPushover(env, key, '🚨 高優先測試', '應響鈴 1 次 — 沒響表示 iOS「Critical Alerts for high-priority」沒開 / Pushover Quiet Hours 擋下', 1);
      const text = r.ok
        ? '✓ 已送 Pushover 測試訊息,看你 Pushover app 收到沒'
        : `✗ Pushover 送失敗: ${r.reason}(可能 user key 錯,或開發者沒設 APP_TOKEN)`;
      try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
      return;
    }
    // 狀態:「pushover」單獨打或「pushover 狀態」
    if (/^pushover(\s*狀態)?$/i.test(t)) {
      const key = await getUserPushoverKey(env, userId);
      let text: string;
      if (key) {
        // v166: 顯示全開模式狀態 + 剩餘時間
        const allUntil = await getPushoverAllUntil(env, userId);
        let modeLine = '\n模式:預設(只 T+0 + 追殺到門檻才推)';
        if (allUntil && allUntil.getTime() > Date.now()) {
          const remainMs = allUntil.getTime() - Date.now();
          const remainHr = Math.floor(remainMs / 3600 / 1000);
          const remainMin = Math.floor((remainMs % (3600 * 1000)) / 60 / 1000);
          const tpeStr = localWallClock(env, allUntil.getTime()).toISOString().replace('T', ' ').substring(0, 16);
          modeLine = `\n模式:🔔 全開中(至 ${tpeStr} Taipei,剩 ${remainHr}h${remainMin}m)`;
        }
        text = `Pushover 狀態:✓ 啟用中\nuser key: ${key.substring(0, 6)}...${key.slice(-4)}${modeLine}\n\n指令:\n• pushover 測試 → 送一則測試\n• pushover 全開 今天 / 永久 / N小時 / N天 → 限定時間內所有提醒走 Pushover\n• pushover 全開 關 → 關全開\n• pushover 關 → 完全停用 Pushover`;
      } else {
        text = 'Pushover 狀態:✗ 未啟用\n\n啟用方式:\n1. App Store / Play 下載 Pushover\n2. 註冊帳號,取 user key(主畫面正中間那串 30 字)\n3. 傳「pushover <key>」給我啟用';
      }
      try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
      return;
    }

    // v183: 分心名單 / 工作時段 指令 — 對 iOS Shortcuts 偵測拖延的設定介面
    // 「分心」/「分心 名單」/「我的分心名單」→ 列當前
    if (/^(我的)?分心(\s*名單|\s*列表)?$/.test(t)) {
      const list = await getDistractionList(env, userId);
      const lines = ['🐢 分心 app 名單'];
      lines.push('━━━━━━━━━━━━');
      if (list.length === 0) {
        lines.push('(尚未設定)');
      } else {
        list.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
      }
      lines.push('━━━━━━━━━━━━');
      lines.push('• 加:「分心 加 Instagram」');
      lines.push('• 刪:「分心 刪 Instagram」');
      lines.push('• 清空:「分心 清空」');
      lines.push('• iOS Shortcuts 設定教學:「分心 教學」');
      const text = lines.join('\n');
      try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
      return;
    }
    // v184: 先處理 reserved 關鍵字
    if (/^分心\s*(清空|全部清除|reset)$/.test(t)) {
      await setDistractionList(env, userId, []);
      const text = '✓ 已清空分心名單';
      try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
      return;
    }
    // v211: 反拖延偵測 圖文 SOP(Rich Menu 擴充功能 → 反拖延偵測;也吃文字觸發)
    if (/^反拖延(偵測)?\s*(教學|setup|sop|說明)?$/i.test(t)) {
      const parts = buildAntiProcrastGuideParts();
      const messages = parts.map((p) => ({ type: 'text' as const, text: p }));
      try {
        await client.replyMessage({ replyToken, messages });
      } catch {
        for (const p of parts) await pushText(userId, p, env);
      }
      return;
    }
    if (/^分心\s*(教學|setup|設定)$/.test(t)) {
      // v189: 拆 3 則訊息,URL 獨立一則方便手機長按複製
      const parts = buildDistractionSetupGuideParts(env, userId);
      const messages = parts.map((p) => ({ type: 'text' as const, text: p }));
      try {
        await client.replyMessage({ replyToken, messages });
      } catch {
        for (const p of parts) await pushText(userId, p, env);
      }
      return;
    }
    // 刪除
    let mRm = t.match(/^分心\s*[刪移除\-]+\s*[:,\s]?\s*(.+)$/);
    if (mRm) {
      const apps = mRm[1].split(/[,,\s]+/).map((s) => s.trim()).filter(Boolean);
      let last: string[] = [];
      for (const a of apps) last = await removeDistractionApp(env, userId, a);
      const text = `✓ 已從分心名單移除:${apps.join(', ')}\n當前共 ${last.length} 個`;
      try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
      return;
    }
    // v184: 加 — 兩種寫法都吃
    //   (a) 顯式:「分心 加 X Y Z」/「分心 + X Y Z」
    //   (b) 隱式:「分心 X Y Z」(沒「加」字也視為加,前提是後面接的不是 reserved keyword)
    let mAdd = t.match(/^分心\s*[加+]?\s*[:,\s]?\s*(.+)$/);
    if (mAdd && mAdd[1] && !/^(名單|列表|清空|全部清除|reset|教學|setup|設定|刪|移除)/.test(mAdd[1].trim())) {
      const apps = mAdd[1].split(/[,,\s]+/).map((s) => s.trim()).filter(Boolean);
      if (apps.length > 0) {
        let last: string[] = [];
        for (const a of apps) last = await addDistractionApp(env, userId, a);
        const text = `✓ 已加入分心名單:${apps.join(', ')}\n當前共 ${last.length} 個:${last.join(', ')}`;
        try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
        return;
      }
    }
    // 工作時段 — v185: 預設跟 Notion,KV 是 override
    if (/^(我的|目前|現在)?工作時段$/.test(t)) {
      const periods = await getWorkHours(env, userId);
      const text = periods.length === 0
        ? '工作時段:🟢 自動跟 Notion(預設)\n\n判定:當下有未完成事項、其時間窗涵蓋現在 → 算工作中\n窗怎麼算:\n1. 事項有範圍(🔔09:00~12:00)→ 完全照範圍\n2. 沒範圍 + 後面有下個事項 + 間隔 ≤ 90 分 → 算到下個事項開始\n3. 沒範圍 + 間隔 > 90 分 / 最後一個 → 預設 60 分鐘窗\n4. 你按過「開始做了」→ 從實際開始時間算 + 事項時長(不再整天)\n已勾掉的事項自動不算\n\n要強制固定時段(蓋過 Notion):「工作時段 9-12, 14-18」'
        : `工作時段(手動 override):${formatWorkHours(periods)}\n\n當前模式蓋過 Notion 動態判斷。\n回到 Notion 自動:「工作時段 清除」\n改時段:「工作時段 <新時段>」例:「工作時段 9-12, 14-18」`;
      try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
      return;
    }
    // v211: 問句「現在是工作時段嗎」這類查詢 → 即時用真實狀態回答,
    //       不要讓 LLM 亂猜公司上班時間(舊 bug:對話路徑會 LLM 腦補上班時間)
    const asksIfWorkNow =
      /(現在|目前|此刻|當下)/.test(t) &&
      /(工作時段|工作時間|工作中|算工作|在工作|該工作|要工作|上班)/.test(t) &&
      /(嗎|呢|沒|是不是|算不算|該不該|是否|是|\?|？)/.test(t);
    if (asksIfWorkNow) {
      const periods = await getWorkHours(env, userId);
      const nowDate = new Date();
      const tpe = localWallClock(env, nowDate.getTime());
      const nowMin = tpe.getUTCHours() * 60 + tpe.getUTCMinutes();
      let inWork = false;
      let matched = '';
      if (periods.length > 0) {
        inWork = isInWorkHours(periods, nowMin);
      } else {
        const r = await isInWorkTimeByNotion(env, userId, nowMin);
        inWork = r.inWork;
        matched = r.matchedReminder?.text || '';
      }
      const src = periods.length > 0 ? `手動時段 ${formatWorkHours(periods)}` : '自動跟 Notion 事項';
      const text = inWork
        ? [
            '🟢 現在算工作時段',
            matched ? `正在做的事項:${matched.replace(/🔔/g, '').trim()}` : '',
            `(判定來源:${src})`,
            '此時開分心 app 會觸發拖延警告。',
          ].filter(Boolean).join('\n')
        : [
            '⚪ 現在不算工作時段',
            periods.length > 0
              ? '(現在不在你設的手動工作時段內)'
              : '(目前沒有未完成事項的時間窗涵蓋現在;已勾掉或還沒到的不算)',
            `(判定來源:${src})`,
            '此時開分心 app 不會被警告。',
          ].filter(Boolean).join('\n');
      try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
      return;
    }
    if (/^工作時段\s*(清除|清空|reset|關|取消)$/.test(t)) {
      if (env.CACHE) await env.CACHE.delete(`work-hours:${userId}`);
      const text = '✓ 工作時段手動 override 已清除\n→ 回到「自動跟 Notion」模式(預設)';
      try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
      return;
    }
    let mWh = t.match(/^工作時段\s+(.+)$/);
    if (mWh) {
      const spec = mWh[1];
      const parsed = await setWorkHours(env, userId, spec);
      const text = parsed.length === 0
        ? `⚠ 工作時段格式無法解析:「${spec}」\n正確格式:「工作時段 9-12, 14-18」或「工作時段 09:00-12:00, 14:00-18:00」\n或打「工作時段 清除」回到自動跟 Notion 模式`
        : `✓ 工作時段已設(手動 override):${formatWorkHours(parsed)}\n→ 此模式會蓋過 Notion 動態判斷。回到自動:「工作時段 清除」`;
      try { await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] }); } catch { await pushText(userId, text, env); }
      return;
    }
    // 拖延帳本
    if (/^(我的)?(拖延|拖延帳本|拖延紀錄)$/.test(t)) {
      const log = await getProcrastinationLog(env, userId);
      const lines = ['🐢 今日拖延帳本'];
      lines.push('━━━━━━━━━━━━');
      lines.push(`總次數:${log.total} 次`);
      if (log.total > 0) {
        lines.push('');
        lines.push('分項:');
        Object.entries(log.byApp)
          .sort((a, b) => b[1] - a[1])
          .forEach(([app, count]) => lines.push(`  • ${app}: ${count} 次`));
      }
      try { await client.replyMessage({ replyToken, messages: [buildMessage(lines.join('\n'), 'default')] }); } catch { await pushText(userId, lines.join('\n'), env); }
      return;
    }
  }

  // v126: sync 確認 / 查 Notion 後端(不呼叫 Claude,直接 API)
  if (!isVoice && isSyncCheckQuery(userMessage)) {
    const text = await buildSyncCheckReport(env, userId);
    try {
      await client.replyMessage({ replyToken, messages: [buildMessage(text, 'default')] });
    } catch {
      await pushText(userId, text, env);
    }
    return;
  }

  // v142: 偵測 user 直接貼 Pushover user key(沒加 pushover 前綴)→ Quick Reply 引導
  if (!isVoice && isCandidatePushoverKey(userMessage)) {
    const candidateKey = userMessage.trim();
    const masked = `${candidateKey.substring(0, 6)}...${candidateKey.slice(-4)}`;
    const text = [
      '這看起來像 Pushover user key',
      `(${masked})`,
      '',
      '要啟用嗎?完整指令格式是:',
      'pushover <你的 key>',
      '',
      '按下方按鈕一鍵啟用,或無視這則繼續打字',
    ].join('\n');
    const quickReply = {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '✓ 啟用 Pushover',
            data: `rm:cmd=activate-pushover-key:${candidateKey}`,
            displayText: '✓ 啟用',
          },
        },
        {
          type: 'action',
          action: { type: 'message', label: '✗ 不是 key', text: '不是 user key' },
        },
      ],
    };
    try {
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text, quickReply } as any],
      });
    } catch {
      await pushText(userId, text, env);
    }
    return;
  }

  // v211: 提醒時序設定 —「提醒設定」看總覽+範本;貼回範本(提前 N / 當下 開|關 / 檢測 N)即套用
  if (!isVoice) {
    const tt = userMessage.trim().replace(/[?？。!]+$/, '');
    const isShow = /^(我的|目前|現在|查看?|看一下)?提醒設定$/.test(tt);
    const form = isShow ? ({ matched: false } as const) : parseReminderForm(userMessage);
    if (isShow || form.matched) {
      let prefs = await getPreferences(env, userId);
      if (form.matched) {
        if (form.lead != null) prefs = { ...prefs, reminderLeadMin: Math.max(0, Math.min(60, form.lead)) };
        if (form.startNotify != null) prefs = { ...prefs, reminderStartNotify: form.startNotify };
        if (form.checkAfter != null) prefs = { ...prefs, reminderCheckAfterMin: Math.max(0, Math.min(180, form.checkAfter)) };
        await setPreferences(env, userId, prefs);
      }
      const msgs = buildReminderTimingReply(prefs);
      // 直接 fetch 送(bypass SDK 驗證,確保 clipboard action 這個較新型別不被擋)
      try {
        const r = await fetch('https://api.line.me/v2/bot/message/reply', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ replyToken, messages: msgs }),
        });
        if (!r.ok) {
          console.warn('[reminder-setting] reply failed', r.status, (await r.text()).substring(0, 200));
          for (const m of msgs) await pushText(userId, m.text, env);
        }
      } catch {
        for (const m of msgs) await pushText(userId, m.text, env);
      }
      // v212: 存進對話歷史(含三欄位白話語意),否則使用者緊接著問「檢測是什麼意思」時 Claude 沒 context 會亂答
      const settingSummary = `[已回覆使用者「提醒時序設定」] 三個欄位的意思:` +
        `① 提前 = 工作預定開始「前」幾分鐘先提醒(0=不提前);` +
        `② 當下 = 到了預定開始時間,要不要「再」提醒一次(開/關);` +
        `③ 檢測 = 工作開始「後」幾分鐘,我來查看你有沒有真的在做(反拖延追蹤,0=不檢測)。` +
        `若使用者接著問這三個詞是什麼意思,就照上面解釋,別當成一般中文詞。`;
      await Promise.all([
        saveConversation(env, userId, 'user', userMessage, null),
        saveConversation(env, userId, 'assistant', settingSummary, null),
      ]).catch(() => {});
      return;
    }
  }

  // v212: 早晚安推播設定 —「早晚安設定」看總覽+範本;貼回範本(早安 HH:MM / 晚安 HH:MM)即套用
  if (!isVoice) {
    const tt2 = userMessage.trim().replace(/[?？。!]+$/, '');
    const isShowMN = /^(我的|目前|現在|查看?|看一下)?(早晚安|早安晚安|早\/晚安|早晚安推播|早安晚安推播)(推播)?設定$/.test(tt2);
    const formMN = isShowMN ? ({ matched: false } as const) : parseMorningNightForm(userMessage);
    if (isShowMN || formMN.matched) {
      let prefs = await getPreferences(env, userId);
      if (formMN.matched) {
        if (formMN.morningHHMM) prefs = { ...prefs, morningBriefHHMM: formMN.morningHHMM, morningBriefEnabled: true };
        if (formMN.eveningHHMM) prefs = { ...prefs, eveningSummaryHHMM: formMN.eveningHHMM, eveningSummaryEnabled: true };
        await setPreferences(env, userId, prefs);
      }
      const msgs = buildMorningNightReply(prefs);
      try {
        const r = await fetch('https://api.line.me/v2/bot/message/reply', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ replyToken, messages: msgs }),
        });
        if (!r.ok) {
          console.warn('[morning-night-setting] reply failed', r.status, (await r.text()).substring(0, 200));
          for (const m of msgs) await pushText(userId, m.text, env);
        }
      } catch {
        for (const m of msgs) await pushText(userId, m.text, env);
      }
      const mnSummary = `[已回覆使用者「早晚安推播設定」] 早安推播=每天早上的問候/晨報;晚安總結=每晚的當日回顧。兩者可各自設定推播時間(HH:MM 24 小時制),改完自動開啟,打「關早安推播 / 關晚間總結」可關。`;
      await Promise.all([
        saveConversation(env, userId, 'user', userMessage, null),
        saveConversation(env, userId, 'assistant', mnSummary, null),
      ]).catch(() => {});
      return;
    }
  }

  // v213: 電話功能 MVP —「打給我」手動觸發 Twilio 撥號 + TTS 念測試語
  if (!isVoice) {
    const tt3 = userMessage.trim().replace(/[?？。!~～\s]+$/g, '');
    if (/^(打給我|打電話給我|打給我測試|打電話給我測試|打電話測試|電話測試|測試電話|callme)$/i.test(tt3)) {
      if (!isTwilioConfigured(env)) {
        await pushText(userId, '☎️ 電話功能還沒設定好。\n需要先設好 Twilio 憑證(帳號 SID / Auth Token / 來電號碼)+ 你的手機號碼。\n你 Twilio 帳號開好、拿到憑證後跟我說,我帶你填進去。', env);
        return;
      }
      if (!env.USER_PHONE_NUMBER) {
        await pushText(userId, '☎️ 還沒設定要撥打的手機號碼(USER_PHONE_NUMBER)。設定後再試。', env);
        return;
      }
      const testMsg = '這是你的 AI 秘書打來的測試電話。如果你聽得到這句話,代表電話提醒功能已經正常運作。';
      const result = await placeCall(env, testMsg);
      if (result.ok) {
        await pushText(userId, `☎️ 已撥出電話到 ${env.USER_PHONE_NUMBER},稍等幾秒會響。\n接通後會用中文念一段測試語。沒響或念不出來跟我說,我查 log。`, env);
      } else {
        await pushText(userId, `☎️ 撥打失敗:${result.error}\n常見原因:① 這支號碼還沒在 Twilio 後台「驗證」(trial 只能打已驗證號碼)② 號碼格式要 E.164(+886912345678)③ 撥台灣的權限(Geographic Permissions)沒開。把 Twilio console 的錯誤截圖給我看。`, env);
      }
      return;
    }
  }

  // v151: 追殺等級指令
  if (!isVoice) {
    const fc = parseFollowupLevelCommand(userMessage);
    if (fc.matched) {
      const prefs = await getPreferences(env, userId);
      let text: string;
      if (fc.showOnly) {
        const cur = prefs.followupLevel || 'standard';
        // v176: 詳細顯示當前等級的所有參數(追殺方式 / 次數 / 時間)+ 列其他可選等級
        const details: Record<string, { intervalDesc: string; maxDesc: string; emergencyDesc: string }> = {
          off: {
            intervalDesc: '不追殺(完全關閉)',
            maxDesc: '不適用',
            emergencyDesc: '不適用',
          },
          lite: {
            intervalDesc: '每 10 分鐘推一次',
            maxDesc: '上限 3 次,推完就停',
            emergencyDesc: '第 3 次起 Pushover Critical Alerts(priority 1)',
          },
          standard: {
            intervalDesc: '每 1 分鐘推一次「🚨 追殺 N 次」',
            maxDesc: '無上限(追到你回應或勾 Notion)',
            emergencyDesc: '第 3 次起 Pushover Critical Alerts(priority 1)',
          },
          aggressive: {
            intervalDesc: '每 1 分鐘推一次「🚨 追殺 N 次」',
            maxDesc: '無上限(追到你回應或勾 Notion)',
            emergencyDesc: '第 1 次起 Pushover Critical Alerts(priority 1)',
          },
        };
        const labels: Record<string, string> = {
          off: 'Off',
          lite: 'Lite',
          standard: 'Standard',
          aggressive: 'Aggressive',
        };
        const d = details[cur];
        const quietStart = prefs.quietHoursStart || '23:00';
        const quietEnd = prefs.quietHoursEnd || '07:00';
        const quietDesc = prefs.quietHoursEnabled === false
          ? '✗ 已關閉(無不打擾時段)'
          : `${quietStart} ~ ${quietEnd}(此時段不追殺)`;
        text = [
          `當前追殺等級:${labels[cur]}`,
          '━━━━━━━━━━━━',
          `追殺方式:${d.intervalDesc}`,
          `追殺次數:${d.maxDesc}`,
          `Emergency 觸發:${d.emergencyDesc}`,
          `T-5 / T+0 提醒:LINE push(無 Pushover,除非開全開模式)`,
          `不打擾時段:${quietDesc}`,
          '━━━━━━━━━━━━',
          '其他等級:',
          '• Off — 完全不追',
          '• Lite — 3 次後停,每 10 分鐘 1 次',
          '• Standard — 無上限,每 1 分鐘',
          '• Aggressive — 無上限,每 1 分鐘,第 1 次就 Emergency',
          '',
          '切換打:追殺等級 off / lite / standard / aggressive',
        ].join('\n');
      } else {
        await setPreferences(env, userId, { ...prefs, followupLevel: fc.level });
        const labels: Record<string, string> = {
          off: 'Off(完全不追)',
          lite: 'Lite(3 次後停 / 10 分間隔)',
          standard: 'Standard(無上限 / 1 分間隔)',
          aggressive: 'Aggressive(第 1 次起 Emergency)',
        };
        text = `✓ 追殺等級 → ${labels[fc.level!]}\n下次提醒生效`;
      }
      try {
        await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
      } catch {}
      return;
    }
  }

  // v151: 不打擾時段指令
  if (!isVoice) {
    const qh = parseQuietHoursCommand(userMessage);
    if (qh.matched) {
      const prefs = await getPreferences(env, userId);
      let text: string;
      if (qh.action === 'show') {
        const enabled = prefs.quietHoursEnabled !== false;
        const start = prefs.quietHoursStart || '23:00';
        const end = prefs.quietHoursEnd || '07:00';
        text = [
          `不打擾時段:${enabled ? '✓ 開' : '✗ 關'}`,
          `時段:${start} ~ ${end}`,
          '',
          '指令:',
          '不打擾 23:00-07:00(設時段)',
          '不打擾 關(暫停)',
          '不打擾 開(恢復)',
        ].join('\n');
      } else if (qh.action === 'off') {
        await setPreferences(env, userId, { ...prefs, quietHoursEnabled: false });
        text = '✓ 不打擾時段已關(夜間也會追殺)';
      } else if (qh.action === 'on') {
        await setPreferences(env, userId, { ...prefs, quietHoursEnabled: true });
        text = `✓ 不打擾時段已開(${prefs.quietHoursStart || '23:00'} ~ ${prefs.quietHoursEnd || '07:00'} 暫停追殺)`;
      } else {
        await setPreferences(env, userId, { ...prefs, quietHoursEnabled: true, quietHoursStart: qh.start, quietHoursEnd: qh.end });
        text = `✓ 不打擾時段 → ${qh.start} ~ ${qh.end}\n時段內追殺自動暫停`;
      }
      try {
        await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
      } catch {}
      return;
    }
  }

  // v141: Pushover 教學(文字觸發,雙端友善)
  if (!isVoice && isPushoverSetupQuery(userMessage)) {
    try {
      await client.replyMessage({
        replyToken,
        messages: [buildPushoverSetupFlex()],
      });
    } catch {
      await pushText(userId, '無法顯示教學,請從 Rich Menu 設定 → 擴充功能 → Pushover', env);
    }
    return;
  }

  // 列出今日寫入(不呼叫 Claude)
  if (!isVoice && isListWritesQuery(userMessage)) {
    const listText = await buildWritesList(env);
    try {
      await client.replyMessage({ replyToken, messages: [buildMessage(listText, 'default')] });
    } catch {
      await pushText(userId, listText, env);
    }
    return;
  }

  // 如果使用者用 LINE quote 功能引用某則 bot 訊息 → 查 KV 找對應 reminder
  let quotedReminderId: string | null = null;
  let quotedIsMorningBrief = false;
  let quotedText: string | null = null;
  const quotedMsgId = event.message?.quotedMessageId;
  if (quotedMsgId && env.CACHE) {
    try {
      // 1. 查 reminder 對照(single push 場景)
      const lookupValue = await env.CACHE.get(`pushed-msg:${quotedMsgId}`);
      if (lookupValue) {
        if (lookupValue.startsWith('morning-brief:')) {
          quotedIsMorningBrief = true;
        } else {
          quotedReminderId = lookupValue;
        }
      }
      // 2. 撈原文(v90+ 任何 bot push/reply 都記)
      quotedText = await env.CACHE.get(`pushed-msg-text:${quotedMsgId}`);
      // 3. 若 bot 訊息找不到 → 試 user 自己訊息
      if (!quotedText) {
        const userQuoted = await env.CACHE.get(`user-msg-text:${quotedMsgId}`);
        if (userQuoted) {
          quotedText = `[使用者引用了自己之前說的話] ${userQuoted}`;
        }
      }
      console.log(`[quote] msgId=${quotedMsgId} reminderId=${quotedReminderId} morningBrief=${quotedIsMorningBrief} hasText=${!!quotedText}`);
    } catch (e) {
      console.warn('[quote] KV lookup failed:', e);
    }
  }

  // 若引用早安推播 + 訊息是純數字 → 視為「設提醒 N」(快速 path)
  if (quotedIsMorningBrief && !isVoice && /^[\d\s,，、#]+$/.test(userMessage.trim())) {
    userMessage = `設提醒 ${userMessage.trim()}`;
    console.log(`[quote] 引用早安推播 + 純數字 → 轉成「${userMessage}」`);
  }

  // 保留原始 userMessage(只含使用者實際打的字)給 reminder 捷徑用 — 不能含 wrapper,
  // 否則 `^延後` 之類的正則抓不到,fallback 到 Haiku 又會誤判
  const rawUserMessage = userMessage;

  // 把引用原文塞進 userMessage 讓 Claude 主對話看得到 context(僅供 Claude 主對話用)
  if (quotedMsgId && quotedText) {
    userMessage = [
      `[使用者引用了我之前的訊息,內容如下:]`,
      `「${quotedText}」`,
      ``,
      `[使用者對該訊息的回應:]`,
      userMessage,
    ].join('\n');
  } else if (quotedMsgId && !quotedText) {
    // KV 沒原文(v90 之前推的訊息 / KV TTL 過期)
    userMessage = [
      '[系統提示:使用者用 LINE quote 功能引用了一則訊息,但我們的記錄找不到那則訊息對應到哪個 reminder/動作。',
      '你**絕對不能**用對話歷史「猜」她引用的是哪則。',
      '直接老實說:「我看到你引用了一則訊息但認不出來。請直接打字告訴我你要對哪件事做什麼。」]',
      '',
      userMessage,
    ].join('\n');
  }

  // v210/v211 排計畫 fast-path:規則抓骨架 + Claude 判斷;今天/明天混合(自動猜 + 一鍵切換)
  if (!isVoice) {
    const plan = parsePlanningRequest(rawUserMessage);
    if (plan.match) {
      let offset = plan.offset;
      if (offset == null) {
        // 自動猜:白天(台北 < 18 點)排今天、晚上排明天 — 對齊使用者「早上排今天、晚上排明天」習慣
        const hourTpe = localWallClock(env).getUTCHours();
        offset = hourTpe >= 18 ? 1 : 0;
      }
      const replyText = await runPlanningFastPath(env, userId, offset);
      const switchBtn = offset === 0 ? '排明天' : '排今天'; // 一鍵改看另一天
      const msgId = await rawReply(env, replyToken, buildMessage(replyText, 'none', undefined, [switchBtn]));
      if (!msgId) await pushText(userId, replyText, env);
      return;
    }
  }

  // v226 固定必帶快捷指令 + 「都帶了」ack(回饋圈)— deterministic,不過 Claude
  if (!isVoice) {
    // 親子提醒:剛點 Rich Menu「綁定」→ 正在等家長輸入小孩名字 → 這則當名字,產碼
    const awaitingName = env.CACHE ? await env.CACHE.get(`family-await-name:${userId}`) : null;
    if (awaitingName) {
      if (env.CACHE) await env.CACHE.delete(`family-await-name:${userId}`);
      const name = rawUserMessage.trim().slice(0, 20);
      if (name && !/^(取消|cancel|算了|不要)$/i.test(name)) {
        // v229:綁定先確認對方成年/未成年(決定是否套用未成年限制)
        if (env.CACHE) await env.CACHE.put(`family-await-adult:${userId}`, name, { expirationTtl: 600 });
        const reply =
          `要綁定「${name}」。他是成年還是未成年?\n\n` +
          `・未成年 → 只當「提醒小幫手」(設提醒 + 任務教練),不開放閒聊,我會保護他。\n` +
          `・成年 → 一般使用(同事 / 下屬適用)。\n\n` +
          `回「未成年」或「成年」(直接回別的或沒回 = 預設未成年)`;
        const msgId = await rawReply(env, replyToken, buildMessage(reply, 'none', undefined, ['未成年', '成年']));
        if (!msgId) await pushText(userId, reply, env);
        return;
      }
      // 打「取消」→ 放棄,繼續正常處理
    }
    // v229:綁定第二步 — 收到成年/未成年 → 產碼(成年時記 KV,收碼套到子帳號)
    const awaitingAdult = env.CACHE ? await env.CACHE.get(`family-await-adult:${userId}`) : null;
    if (awaitingAdult) {
      const ans = rawUserMessage.trim();
      if (env.CACHE) await env.CACHE.delete(`family-await-adult:${userId}`);
      if (/^(取消|cancel|算了|不要)$/i.test(ans)) {
        // 放棄綁定,繼續正常處理
      } else {
        // 預設未成年(保守);明確說「成年/成人/大人/同事/下屬」且非「未成年」才當成年
        const isAdult = /(成年|成人|大人|同事|下屬|員工)/.test(ans) && !/未成年/.test(ans);
        let reply: string;
        try {
          const code = await createInviteCode(env, userId, awaitingAdult);
          if (isAdult && env.CACHE) await env.CACHE.put(`invite-adult:${code}`, '1', { expirationTtl: 86400 });
          const who = isAdult ? '成年(一般使用)' : '未成年(只提醒 + 任務教練,不開放閒聊)';
          reply =
            `✓ 要綁定「${awaitingAdult}」— ${who}。把這組 6 位數字給他,請他加我好友後直接傳給我:\n\n` +
            `　　${code}\n\n(24 小時內有效。之後想改身份,跟我說「${awaitingAdult} 成年」或「${awaitingAdult} 未成年」)`;
        } catch (e: any) {
          reply = `產碼失敗:${e?.message ?? e},請再試一次`;
        }
        const msgId = await rawReply(env, replyToken, buildMessage(reply, 'default'));
        if (!msgId) await pushText(userId, reply, env);
        return;
      }
    }
    const done = tryBringDoneCommand(rawUserMessage);
    if (done.matched && done.reply) {
      const msgId = await rawReply(env, replyToken, buildMessage(done.reply, 'none'));
      if (!msgId) await pushText(userId, done.reply, env);
      return;
    }
    const bk = await tryBaseKitCommand(env, userId, rawUserMessage);
    if (bk.matched && bk.reply) {
      const msgId = await rawReply(env, replyToken, buildMessage(bk.reply, 'default'));
      if (!msgId) await pushText(userId, bk.reply, env);
      return;
    }
    // 親子提醒(功能 2)綁定:家長產碼 /「綁定小孩 X」、小孩收碼「綁定 123456」— deterministic,不過 Claude
    const fam = await tryFamilyBindCommand(env, userId, rawUserMessage);
    if (fam.matched && fam.reply) {
      const msgId = await rawReply(env, replyToken, buildMessage(fam.reply, 'default'));
      if (!msgId) await pushText(userId, fam.reply, env);
      if (fam.notifyParent) await pushText(fam.notifyParent.userId, fam.notifyParent.text, env);
      return;
    }
    // 親子提醒(功能 2):小孩打字「完成」→ 結掉家長提醒 + 回報(只在真有家長提醒在等時攔截)
    const childDone = await tryChildDoneTyped(env, userId, rawUserMessage);
    if (childDone) {
      const msgId = await rawReply(env, replyToken, buildMessage(childDone.childReply, 'none'));
      if (!msgId) await pushText(userId, childDone.childReply, env);
      if (childDone.notifyParent) await pushText(childDone.notifyParent.userId, childDone.notifyParent.text, env);
      return;
    }
  }

  // 提醒相關指令(提醒清單 / 已開始 / 延後 / 跳過 / 靜音)— 走捷徑不過 Claude
  // 用 rawUserMessage(沒 wrapper),才能匹配 `^延後` 之類的正則
  if (!isVoice) {
    const cmdResult = await tryReminderCommand(env, userId, rawUserMessage, quotedReminderId);
    // v171: skipReply — handler 已自己 push 訊息(如 batch 提案),完全不要再 reply 也不要 fall through
    if (cmdResult.matched && cmdResult.skipReply) {
      return;
    }
    if (cmdResult.matched && cmdResult.reply) {
      const mode = cmdResult.doNotShowQuickReply ? 'none' : 'default';
      // 用 rawReply 拿 messageId(關聯 reminder 用)
      const msgId = await rawReply(env, replyToken, buildMessage(cmdResult.reply, mode as any));
      if (cmdResult.reminderId) {
        await rememberSentMsg(env, msgId, cmdResult.reminderId);
      }
      if (!msgId) {
        // fallback: rawReply 失敗 → pushText
        await pushText(userId, cmdResult.reply, env);
      }
      return;
    }
  }

  // 追殺中的反應判斷(若有 active reminder + 沒匹配指令)
  // Haiku 判斷使用者回應是否敷衍 / 實質 / 無關
  {
    const followupResult = await checkFollowupResponse(env, userId, rawUserMessage, quotedReminderId);
    if (followupResult.matched && followupResult.reply) {
      const mode = followupResult.doNotShowQuickReply ? 'none' : 'default';
      const msgId = await rawReply(env, replyToken, buildMessage(followupResult.reply, mode as any));
      if (followupResult.reminderId) {
        await rememberSentMsg(env, msgId, followupResult.reminderId);
      }
      if (!msgId) {
        await pushText(userId, followupResult.reply, env);
      }
      return;
    }
    // unrelated → 不 return,繼續走 Claude 主對話
  }

  // 確認 / 取消(若有待確認批次)— 走捷徑,不呼叫 Claude
  if (!isVoice) {
    const trimmed = userMessage.trim().toLowerCase().replace(/\s+/g, '');
    const isConfirm = ['確認', '執行', 'ok', 'yes', '是', '好', 'go'].includes(trimmed);
    const isCancel = ['取消', '不要', 'no', 'cancel', '別', '別動'].includes(trimmed);
    if ((isConfirm || isCancel) && (await hasPendingBatch(env, userId))) {
      let reply: string;
      let mode: ButtonMode;
      if (isCancel) {
        await cancelPendingBatch(env, userId);
        reply = '✓ 已取消待確認的批次操作,Notion 未動';
        mode = 'default';
      } else {
        const r = await executePendingBatch(env, userId);
        reply = r.message;
        mode = 'write'; // 剛批次動 Notion → 帶撤回按鈕
      }
      try {
        await client.replyMessage({ replyToken, messages: [buildMessage(reply, mode)] });
      } catch {
        await pushText(userId, reply, env);
      }
      return;
    }
  }

  // 撤回指令(層 3b)— 不呼叫 Claude,直接走 Notion API DELETE
  if (!isVoice) {
    const undoIdx = parseUndoCommand(userMessage);
    if (undoIdx !== null) {
      const undoResult = await undoWrite(env, undoIdx);
      const reply = undoResult.ok
        ? [
            `✓ 撤回成功(第 ${undoIdx} 筆)`,
            '━━━━━━━━━━━━',
            undoResult.message,
            '━━━━━━━━━━━━',
            '若要看剩下的清單,打「今日寫入」',
          ].join('\n')
        : [
            `✗ 撤回失敗(第 ${undoIdx} 筆)`,
            '━━━━━━━━━━━━',
            undoResult.message,
          ].join('\n');
      try {
        await client.replyMessage({ replyToken, messages: [buildMessage(reply, 'default')] });
      } catch {
        await pushText(userId, reply, env);
      }
      return;
    }
  }

  // v228/v229:非開發者(= 綁定的子帳號)讀一次政策,後面防燒錢 guard、未成年路徑、模型 clamp 共用。
  const childPolicy: ChildPolicy | null = !(await isOwner(env, userId))
    ? await getChildPolicy(env, userId)
    : null;

  // v228 防亂玩燒錢:防洗版 rate limit + 每日 $ 上限。
  // 放這裡 → 家庭/提醒 deterministic 指令(綁定/完成回報/延後…)已在前面 return,不受影響;
  // 只擋真正燒錢的自由聊天(含升級到全套)。
  if (childPolicy) {
    const childGuard = await checkChildChatGuard(env, userId, childPolicy);
    if (!childGuard.allowed) {
      const gText = childGuard.reason || '今天先聊到這裡囉~';
      const gMsgId = await rawReply(env, replyToken, buildMessage(gText, 'none'));
      if (!gMsgId) await pushText(userId, gText, env);
      return;
    }
  }

  // v157: 6→8,給多 1 輪對話連貫(token 多 ~150,還在甜蜜點;>12 才進「變笨區」)
  const history = await getRecentHistory(env, userId, 8);

  // 安全網 1:卡住主動告知 — 改 60s/90s,大部分操作不會觸發,省 push 額度
  let processingDone = false;
  const slow60s = setTimeout(() => {
    if (!processingDone) {
      pushText(userId, '⋯ 處理較長,還在跑(已 60 秒)', env).catch(() => {});
    }
  }, 60000);
  const stuck90s = setTimeout(() => {
    if (!processingDone) {
      pushText(
        userId,
        '⚠️ bot 處理超過 90 秒,可能卡住。建議重傳或打「狀態」查用量。',
        env
      ).catch(() => {});
    }
  }, 90000);

  let replyText: string;
  let result: any = null;
  const startTime = Date.now();

  try {
    // v229 未成年限制路徑:isMinor → 只走「提醒專用 + 任務教練 + 危機升級」,不進一般 route/light/full。
    if (childPolicy?.isMinor) {
      let alerted = detectCrisis(userMessage);
      if (childPolicy.level === 0) {
        // L0:完全不過 AI
        result = { text: '我是你的提醒小幫手喔~要設提醒可以用下面的選單。(想用「講的」設定,要請主帳號幫你開啟)', toolCalls: 0 };
      } else {
        const minor = await chatWithTools(env, {
          taskContext: `minor-${userId}-${messageId}`,
          userId,
          system: buildMinorSystemPrompt(env, childPolicy.level),
          history,
          userMessage,
          maxTokens: 700,
          model: 'claude-haiku-4-5',
          allowedToolNames: MINOR_TOOL_NAMES,
        });
        if (hasAlert(minor.text)) alerted = true;
        result = {
          text: stripAlert(minor.text) || '我在喔~要不要我幫你設個提醒?',
          toolCalls: minor.toolCalls,
          blockedReason: minor.blockedReason,
        };
      }
      // 危機升級:通知所有主帳號(家長/上司)
      if (alerted) {
        try {
          const parents = await getParentsOf(env, userId);
          const snippet = userMessage.slice(0, 80);
          for (const p of parents) {
            await pushText(p, `⚠️ 關心提醒:你綁定的子帳號剛剛說了讓人擔心的話 ——「${snippet}」。建議盡快關心他、確認他安全。`, env).catch(() => {});
          }
          // L0 沒跑 AI、或 AI 沒生安撫語 → 補一句安全引導
          if (childPolicy.level === 0 || !result.text) {
            result = { text: '謝謝你願意說出來。我已經通知你的大人了,他們會關心你。如果現在很危急,請馬上去找身邊信任的大人喔。', toolCalls: 0 };
          }
        } catch (e) {
          console.warn('[minor] crisis notify failed:', e);
        }
      }
    }

    // v227 分流器(route.ts):閒聊/問答先走輕量快車道(迷你提示 + 0 工具,前綴 ~1k),
    // 只有「明顯要動手」或輕量自己喊 [[ESCALATE]] 才走全套(37k + 30 工具)。
    // 語音 / 圖片暫不走輕量(各有特殊處理 + vision)→ 一律全套。
    const route = !isVoice && !imageBase64 ? routeMessage(userMessage) : 'full';
    if (!result && route === 'light') {
      const light = await chatLight(env, {
        history,
        userMessage,
        userId,
        taskContext: `light-${userId}-${messageId}`,
      });
      if (light && !light.escalate) {
        result = { text: light.text, toolCalls: 0 };
        console.log(
          `[light] Done in ${Date.now() - startTime}ms, cost=$${light.result.costUsd.toFixed(4)}, ` +
            `in=${light.result.inputTokens} cached=${light.result.cachedTokens} out=${light.result.outputTokens}`
        );
      } else {
        console.log(`[light] ${light ? 'escalate' : 'unavailable'} → 轉全套路徑`);
      }
    }

    // 全套路徑:route==='full',或輕量升級([[ESCALATE]])/ 降級(缺 key)→ result 仍為 null
    if (!result) {
      const systemPrompt = await buildSystemPrompt(env, userId);
      // v154: 動態 inject 當前進行中事項 + 指代消解規則(放最末段,不影響 prompt cache prefix)
      const inProgressContext = await buildInProgressContext(env, userId);
      // v117: 用使用者偏好的處理模式(Haiku/Sonnet/Sonnet+思考/Opus)
      let userMode = await getUserMode(env, userId);
      // v228 防小孩燒錢:非開發者一律 clamp 到政策最高模型(預設 Haiku)—— 即使 mode 之前被設過
      // (未成年走不到這:上面 minor 分支已 set result;這裡只剩成年子帳號)
      if (childPolicy) {
        userMode = clampModelToPolicy(userMode, childPolicy.maxModel);
      }
      const userModel = modeToModel(userMode);
      const thinkingBudget = modeToThinkingBudget(userMode);
      result = await chatWithTools(env, {
        taskContext: `chat-${userId}-${messageId}`,
        userId,
        system: systemPrompt + inProgressContext,
        history,
        userMessage,
        maxTokens: 2000,
        model: userModel,
        thinkingBudget,
        imageBase64,
        imageMediaType,
      });
      const elapsed = Date.now() - startTime;
      console.log(`[v33] Done in ${elapsed}ms, ${result?.toolCalls ?? 0} tool calls`);
    }

    if (result.blockedReason) {
      // 安全網 4:迴圈/預算擋下 → 具體說明
      replyText = [
        '⚠️ bot 被自動擋下,原因如下',
        '━━━━━━━━━━━━',
        result.blockedReason,
        '━━━━━━━━━━━━',
        '建議:換個說法重傳,或打「狀態」查當前用量',
      ].join('\n');
    } else {
      // v158: Claude 生空回應 → 給 user 明確指引,不要丟「(無回應內容)」這種開發者語
      replyText = result.text || '⚠ 我沒生出回應(可能訊息不夠清楚或內部錯)\n請換個說法重傳,或打「狀態」查當前用量';
    }
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    const errMsg = err.message ?? String(err);
    console.error(`[v82] Failed after ${elapsed}ms: ${errMsg}`);
    // 429 rate limit → 人話翻譯
    if (errMsg.includes('429') || errMsg.includes('rate_limit')) {
      replyText = [
        '⏳ 短時間用量太大(API 限速),請等 1 分鐘再試',
        '━━━━━━━━━━━━',
        '原因:你剛短時間內測試太多次,Anthropic 限額每分鐘 30,000 tokens',
        '解法:等 60 秒讓額度補回,或減少測試頻率',
        '',
        '若常常碰到,可考慮升級 Anthropic tier(增加限額)',
      ].join('\n');
    } else if (errMsg.includes('overloaded') || errMsg.includes('529')) {
      replyText = '⚠️ Anthropic 服務暫時繁忙,稍後再試';
    } else if (errMsg.includes('timeout') || errMsg.includes('aborted')) {
      replyText = `⏱ 處理超時(${(elapsed / 1000).toFixed(0)} 秒),請重新傳訊息`;
    } else {
      replyText = `(內部錯誤)\n${errMsg.substring(0, 200)}`;
    }
  } finally {
    processingDone = true;
    clearTimeout(slow60s);
    clearTimeout(stuck90s);
  }

  // 若 KV 有 pending → propose_batch_action 已自己 push 提案訊息給使用者
  // → reply skip(不送 reply,省 push + 不重複)
  let buttonMode: ButtonMode = 'none';
  let skipReply = false;
  let customButtons: string[] | null = null; // v179: Claude 用 [QUICK_REPLY: a, b, c] 指定的自訂按鈕
  const pending = await getPendingBatch(env, userId);
  if (pending) {
    // 提案已 push,reply 完全跳過
    skipReply = true;
  } else {
    // v179: 優先偵測 [QUICK_REPLY: btn1, btn2] marker — Claude 自由附按鈕
    const customQR = detectCustomQuickReply(replyText);
    if (customQR.buttons) {
      replyText = customQR.cleanText;
      customButtons = customQR.buttons;
    } else {
      // v112: 偵測確認 marker → confirm 按鈕模式
      const ask = detectConfirmAsk(replyText);
      if (ask.isAsk) {
        replyText = ask.cleanText;
        buttonMode = 'confirm';
      } else if (result?.toolCalls && result.toolCalls > 0) {
        buttonMode = 'write';
      }
    }
  }

  // v125: fail-loud — 若上次 saveConversation 寫入失敗,在這則 reply 開頭加警告
  // 因為 history 可能缺一塊,Claude 的回應可能基於 stale history
  if (!skipReply) {
    const hadSaveFail = await consumeSaveFailFlag(env, userId);
    if (hadSaveFail) {
      replyText = '⚠ 上一輪對話我可能沒記住(D1 寫入失敗已重試 3 次),這則回答如果怪怪的請重述\n━━━━━━━━━━━━\n' + replyText;
    }
  }

  // v211: pending footer(📌 記著)只接在「送出用」的 displayText,不寫回 replyText。
  //   舊 bug:footer 併進 replyText → 被 saveConversation 存進對話歷史 → 下輪 Claude 看到就複述,
  //   程式又 append 一次 → footer 每輪累加(使用者看到「越來越多」)。歷史只存乾淨的 replyText。
  let displayText = replyText;
  if (!skipReply) {
    const footer = await buildPendingFooter(env, userId);
    if (footer) displayText = replyText + footer;
  }

  // 回 LINE — 跳過 reply 若 propose_batch_action 已直接 push 提案
  if (skipReply) {
    console.log(`[${VERSION}] skip reply(propose_batch_action 已 push 提案)`);
  } else {
    const msg = buildMessage(displayText, buttonMode, quoteToken, customButtons);
    const mainMsgId = await rawReply(env, replyToken, msg);
    if (!mainMsgId) {
      let pushOK = false;
      try {
        await client.pushMessage({ to: userId, messages: [msg] });
        console.log(`[${VERSION}] Sent via push (buttons: ${customButtons ? `custom[${customButtons.length}]` : buttonMode})`);
        pushOK = true;
      } catch (pushErr: any) {
        console.error(`[${VERSION}] push failed:`, pushErr.message ?? pushErr);
      }
      // v176: 強制錯誤回報 — rawReply 失敗 + pushMessage 也失敗 → 最後一搏用 pushText(更簡單 payload)告知 user
      if (!pushOK) {
        try {
          await pushText(
            userId,
            `⚠ bot 已生出回應但 LINE 傳送失敗(reply token 過期且 pushMessage 也炸)\n\n回應內容(可能截斷):\n${(replyText || '(無)').substring(0, 400)}\n\n請重傳訊息再試。`,
            env,
            false,
          );
        } catch (lastErr: any) {
          console.error(`[${VERSION}] last-resort pushText also failed:`, lastErr?.message ?? lastErr);
        }
      }
    } else {
      console.log(`[${VERSION}] Sent via reply msgId=${mainMsgId} (buttons: ${customButtons ? `custom[${customButtons.length}]` : buttonMode})`);
    }
  }

  // DB 儲存
  await Promise.all([
    saveConversation(env, userId, 'user', userMessage, null),
    result
      ? saveConversation(env, userId, 'assistant', replyText, {
          model: modeToModel(await getUserMode(env, userId)), // v117: DB 存實際 Claude model id
          inputTokens: result.totalInputTokens,
          outputTokens: result.totalOutputTokens,
          costUsd: result.totalCostUsd,
        })
      : Promise.resolve(),
  ]).catch((err) => console.error('[v20] DB save failed:', err));
}

// v110: 處理 postback —「▶ 開始做了」按鈕(data: action=start&id=<reminderId>)
async function handlePostback(event: any, client: any, env: Env): Promise<void> {
  const userId = event.source.userId;
  const data: string = event.postback?.data || '';
  const params = new URLSearchParams(data);
  const action = params.get('action');
  const reminderId = params.get('id');

  if (action === 'start' && reminderId) {
    const result = await markReminderStarted(env, userId, reminderId);
    try {
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: result.reply }],
      });
    } catch (err) {
      console.error('[v110] postback reply failed:', err);
    }
    return;
  }

  // 親子提醒(功能 2):小孩按「✓ 完成」/「⏰ 等一下做」
  if ((action === 'child-done' || action === 'child-snooze') && reminderId) {
    const res =
      action === 'child-done'
        ? await completeChildReminder(env, userId, reminderId)
        : await snoozeChildReminder(env, userId, reminderId);
    try {
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: res.childReply }],
      });
    } catch (err) {
      console.error('[family] child action reply failed:', err);
    }
    if (res.notifyParent) await pushText(res.notifyParent.userId, res.notifyParent.text, env);
    return;
  }

  // v178: 「⏰ 延後」二層選單 — 點開展開「延後 10 / 30 分鐘」
  if (action === 'postpone-menu' && reminderId) {
    const quickReply = {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '延後 10 分',
            data: `action=postpone&id=${reminderId}&min=10`,
            displayText: '延後 10 分鐘',
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '延後 30 分',
            data: `action=postpone&id=${reminderId}&min=30`,
            displayText: '延後 30 分鐘',
          },
        },
      ],
    };
    try {
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '要延後多久?', quickReply }],
      });
    } catch (err) {
      console.error('[v178] postpone-menu reply failed:', err);
    }
    return;
  }

  // v178: 執行延後 — 走 tryReminderCommand 跑既有 shortcut 邏輯(複用 v130 fuzzy replace / verify retry)
  if (action === 'postpone' && reminderId) {
    const min = parseInt(params.get('min') || '0', 10);
    if (min <= 0) {
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '⚠ 延後分鐘數錯誤,請打字「延後 N 分鐘」重試' }],
        });
      } catch {}
      return;
    }
    const cmd = await tryReminderCommand(env, userId, `延後 ${min} 分鐘`, reminderId);
    const replyText = (cmd.matched && cmd.reply)
      ? cmd.reply
      : `⚠ 延後 ${min} 分鐘失敗(可能找不到提醒,reminderId=${reminderId.substring(0, 8)})`;
    try {
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: replyText }],
      });
    } catch (err) {
      console.error('[v178] postpone reply failed:', err);
    }
    return;
  }

  // v133: Rich Menu switch 動作 — LINE 平台自己切選單,bot 不需回覆
  if (data.startsWith('rm-switch=')) {
    return;
  }

  // v134: Rich Menu 既有功能(postback 觸發,取代 message action 的「替你打字」)
  if (data.startsWith('rm:cmd=')) {
    const cmd = data.substring('rm:cmd='.length);

    // 親子提醒(功能 2)Rich Menu「家庭」子選單
    if (cmd === 'family-bind') {
      if (env.CACHE) await env.CACHE.put(`family-await-name:${userId}`, '1', { expirationTtl: 300 });
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '要綁定誰?直接打名字就好(例如「小明」)。\n(打「取消」可放棄)' }],
        });
      } catch (err) {
        console.error('[family] bind prompt failed:', err);
      }
      return;
    }
    if (cmd === 'family-list') {
      const kids = await getChildrenOf(env, userId);
      const text = kids.length
        ? `目前綁定的人:\n${kids.map((k) => `- ${k.childLabel || '(未命名)'}`).join('\n')}`
        : '你目前還沒綁定任何人。點「綁定」開始。';
      try {
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text }] });
      } catch (err) {
        console.error('[family] list failed:', err);
      }
      return;
    }
    if (cmd === 'family-reminders') {
      const rows = await listAssignedReminders(env, userId);
      let text: string;
      if (rows.length === 0) {
        text = '你還沒幫綁定的人設任何提醒。\n對我說「每天 8 點提醒小明刷牙」就能設。';
      } else {
        const kids = await getChildrenOf(env, userId);
        const labelOf = (uid: string) => kids.find((k) => k.childUserId === uid)?.childLabel || '(未命名)';
        const daily = rows.filter((a) => !a.onceDate);
        const once = rows.filter((a) => a.onceDate);
        const parts: string[] = [];
        if (daily.length)
          parts.push(
            '【每日固定】\n' +
              daily
                .map((a) => `- ${labelOf(a.assigneeUserId)}:${formatSchedule(a.daysOfWeek, null)} ${a.timeHhmm} ${a.text}${a.enabled ? '' : '(停)'}`)
                .join('\n')
          );
        if (once.length)
          parts.push(
            '【臨時(一次)】\n' +
              once.map((a) => `- ${labelOf(a.assigneeUserId)}:${a.onceDate} ${a.timeHhmm} ${a.text}`).join('\n')
          );
        text = parts.join('\n\n');
      }
      try {
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text }] });
      } catch (err) {
        console.error('[family] reminders failed:', err);
      }
      return;
    }

    // 額度
    if (cmd === '額度') {
      const text = await buildStatusReport(env, userId);
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text }],
        });
      } catch (err) {
        console.error('[v134] rm 額度 reply failed:', err);
      }
      return;
    }

    // 提醒列表(走既有 tryReminderCommand)
    if (cmd === '提醒') {
      const r = await tryReminderCommand(env, userId, '提醒', null);
      const text = r.matched && r.reply ? r.reply : '目前沒有提醒';
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text }],
        });
      } catch (err) {
        console.error('[v134] rm 提醒 reply failed:', err);
      }
      return;
    }

    // 今日寫入
    if (cmd === '今日寫入') {
      const text = await buildWritesList(env);
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text }],
        });
      } catch (err) {
        console.error('[v134] rm 今日寫入 reply failed:', err);
      }
      return;
    }

    // v211:「現在要做」— 等同使用者直接打字問 bot,走完整對話 pipeline(讀 Notion + Claude)
    //   合成一則 text 訊息事件,丟回 handleEventInBackground,自然走 AI 對話流程
    if (cmd === 'now-todo') {
      // v211: 把「當下台北時間」直接寫進訊息 — 舊版 Claude 常從 Notion 排程時間反推「現在幾點」而抓錯,
      //        直接給它確切時間最不會錯(來源同系統時間 new Date(),不另算)。
      const nowTpe = localWallClock(env);
      const hhmm = `${String(nowTpe.getUTCHours()).padStart(2, '0')}:${String(nowTpe.getUTCMinutes()).padStart(2, '0')}`;
      const synthetic = {
        type: 'message',
        replyToken: event.replyToken,
        source: event.source,
        message: {
          type: 'text',
          id: crypto.randomUUID(),
          text: `(現在台北時間 ${hhmm},請以這個為準判斷)我現在應該要做什麼?接下來只列往後 2~3 項就好,不要列整天清單。`,
        },
      };
      await handleEventInBackground(synthetic, client, env);
      return;
    }

    // v211: 反拖延偵測設定教學 — 回 Drive PDF SOP + 版本差異提醒
    if (cmd === 'antiprocrast-guide') {
      const parts = buildAntiProcrastGuideParts();
      const messages = parts.map((p) => ({ type: 'text' as const, text: p }));
      try {
        await client.replyMessage({ replyToken: event.replyToken, messages });
      } catch (err) {
        console.error('[v211] rm antiprocrast-guide reply failed:', err);
        for (const p of parts) await pushText(userId, p, env);
      }
      return;
    }

    // v214: 電話介入安裝引導 — 叫使用者在自己的 Claude 講一句話,讓 Claude 讀 docs 帶他裝 Twilio
    // v220: 電話介入按鈕 → 下一層 menu(一張卡 + 兩按鈕:安裝說明 / 使用說明)
    if (cmd === 'phone-setup-guide') {
      try {
        await client.replyMessage({ replyToken: event.replyToken, messages: [buildPhoneMenuFlex()] });
      } catch (err) {
        console.error('[v220] rm phone-setup-guide reply failed:', err);
        await pushText(userId, '☎️ 電話介入 — 跟我說「電話安裝說明」或「電話使用說明」', env);
      }
      return;
    }
    if (cmd === 'phone-install') {
      try {
        await client.replyMessage({ replyToken: event.replyToken, messages: [buildPhoneInstallFlex()] });
      } catch (err) {
        console.error('[v220] rm phone-install reply failed:', err);
        await pushText(userId, '安裝說明載入失敗,跟我說我重發', env);
      }
      return;
    }
    if (cmd === 'phone-usage') {
      try {
        await client.replyMessage({ replyToken: event.replyToken, messages: [buildPhoneUsageFlex()] });
      } catch (err) {
        console.error('[v220] rm phone-usage reply failed:', err);
        await pushText(userId, '使用說明載入失敗,跟我說我重發', env);
      }
      return;
    }
    // v220: 傳純文字版的 4 個 secret 指令(Flex 卡片不可複製,純文字訊息電腦版可選取複製)
    if (cmd === 'phone-copy-cmds') {
      const cmdsText = [
        '電話功能 — 設 4 個密碼(電腦終端機,一條一條來)',
        '',
        '【怎麼操作】貼一條按 Enter → 終端機會問「Enter a secret value:」→ 這時貼「對應的值」再按 Enter → 看到 Success 換下一條。',
        '',
        '① npx wrangler secret put TWILIO_ACCOUNT_SID',
        '   值 = Twilio 的 Account SID(AC 開頭)',
        '② npx wrangler secret put TWILIO_AUTH_TOKEN',
        '   值 = Auth Token',
        '③ npx wrangler secret put TWILIO_PHONE_NUMBER',
        '   值 = Twilio 送你的號碼(+1 開頭)',
        '④ npx wrangler secret put USER_PHONE_NUMBER',
        '   值 = 你的手機(+886 開頭,去掉最前面的 0)',
        '',
        '⚠ 貼密碼時畫面看不到字是正常的(故意藏起來,不是當機)',
      ].join('\n');
      try {
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: cmdsText }] });
      } catch (err) {
        console.error('[v220] rm phone-copy-cmds reply failed:', err);
        await pushText(userId, cmdsText, env);
      }
      return;
    }

    // v226: 帶東西 — 使用說明小卡(從 rm-bring 選單的「帶東西說明」進來)
    if (cmd === 'bring-help') {
      try {
        await client.replyMessage({ replyToken: event.replyToken, messages: [buildBringHelpFlex()] });
      } catch (err) {
        console.error('[v226] rm bring-help reply failed:', err);
        await pushText(userId, '🎒 帶東西說明載入失敗,跟我說我重發', env);
      }
      return;
    }
    // v226: 帶東西 — 設定(目前接固定必帶;之後擴充其他帶東西設定)
    if (cmd === 'bring-settings') {
      try {
        const kit = await getBaseKit(env, userId);
        await client.replyMessage({ replyToken: event.replyToken, messages: [buildBringSettingsFlex(kit)] });
      } catch (err) {
        console.error('[v226] rm bring-settings reply failed:', err);
        await pushText(userId, '🎒 帶東西設定 — 跟我說「固定必帶」看現在設定', env);
      }
      return;
    }

    // v135: 快速靜音(30 分 / 1 小時 / 4 小時 / 明早 6 點)
    const quickMute: Record<string, number> = {
      'mute-30m': 0.5,
      'mute-1h': 1,
      'mute-4h': 4,
    };
    if (cmd in quickMute) {
      const hours = quickMute[cmd];
      await setSilenceTemp(env, userId, hours);
      const text = [
        `✓ 已靜音 ${hours < 1 ? `${hours * 60} 分鐘` : `${hours} 小時`}`,
        '靜音期間提醒類 push 暫停;主動對話不受影響',
        '要解除打「取消靜音」',
      ].join('\n');
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text }],
        });
      } catch (err) {
        console.error(`[v135] rm ${cmd} reply failed:`, err);
      }
      return;
    }

    // v135: 靜音到明早 6:00(從現在到明早 6:00 是 N 小時)
    if (cmd === 'mute-tomorrow-6am') {
      const tz = env.TIMEZONE || 'Asia/Taipei';
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date());
      const nowH = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
      const nowM = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
      const nowTotalMin = nowH * 60 + nowM;
      const targetTotalMin = 6 * 60; // 明早 6:00
      // 一律算「下一個 6:00」 — 若現在 < 6:00 視為今天 6:00,否則明早 6:00
      let diffMin = targetTotalMin - nowTotalMin;
      if (diffMin <= 0) diffMin += 24 * 60;
      const hours = diffMin / 60;
      await setSilenceTemp(env, userId, hours);
      const text = [
        `✓ 已靜音到明早 6:00(約 ${hours.toFixed(1)} 小時)`,
        '靜音期間提醒類 push 暫停;主動對話不受影響',
        '要提早解除打「取消靜音」',
      ].join('\n');
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text }],
        });
      } catch (err) {
        console.error('[v135] rm mute-tomorrow-6am reply failed:', err);
      }
      return;
    }

    // v137: Pushover 教學(Flex Message)
    if (cmd === 'pushover-setup') {
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [buildPushoverSetupFlex()],
        });
      } catch (err) {
        console.error('[v137] rm pushover-setup reply failed:', err);
      }
      return;
    }

    // v138: Pushover key 引導已合併進 Carousel(舊 cmd 仍 fallback 到主教學)
    if (cmd === 'pushover-key-help') {
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [buildPushoverSetupFlex()],
        });
      } catch (err) {
        console.error('[v138] rm pushover-key-help fallback reply failed:', err);
      }
      return;
    }

    // v142: 一鍵啟用 Pushover user key(偵測到純 key 訊息後 user 按下啟用按鈕)
    if (cmd.startsWith('activate-pushover-key:')) {
      const key = cmd.substring('activate-pushover-key:'.length);
      if (!/^[a-zA-Z0-9]{20,40}$/.test(key)) {
        try {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '✗ user key 格式不對,請重貼' }],
          });
        } catch {}
        return;
      }
      await setUserPushoverKey(env, userId, key);
      const masked = `${key.substring(0, 6)}...${key.slice(-4)}`;
      const text = [
        '✓ Pushover 已啟用',
        `user key: ${masked}`,
        '',
        '之後 T+0 / T+15 / 追殺第 3 次起會同步推到 Pushover',
        '要關閉打「pushover 關」',
      ].join('\n');
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text }],
        });
      } catch (err) {
        console.error('[v142] activate-pushover-key reply failed:', err);
      }
      return;
    }

    // v151: 追殺等級 Flex 主選單
    if (cmd === 'followup-level') {
      const prefs = await getPreferences(env, userId);
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [buildFollowupLevelFlex(prefs.followupLevel || 'standard')],
        });
      } catch (err) {
        console.error('[v151] rm followup-level reply failed:', err);
      }
      return;
    }

    // v151: 切換追殺等級
    if (cmd.startsWith('set-followup-level:')) {
      const level = cmd.substring('set-followup-level:'.length) as any;
      if (!['off', 'lite', 'standard', 'aggressive'].includes(level)) return;
      const prefs = await getPreferences(env, userId);
      await setPreferences(env, userId, { ...prefs, followupLevel: level });
      const labels: Record<string, string> = {
        off: 'Off(完全不追)',
        lite: 'Lite(3 次後停 / 10 分間隔)',
        standard: 'Standard(無上限 / 1 分間隔)',
        aggressive: 'Aggressive(第 1 次起 Emergency)',
      };
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `✓ 追殺等級 → ${labels[level]}\n下次提醒生效` }],
        });
      } catch {}
      return;
    }

    // v151: 不打擾時段 Flex 主選單
    if (cmd === 'quiet-hours-menu') {
      const prefs = await getPreferences(env, userId);
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [buildQuietHoursFlex(prefs)],
        });
      } catch (err) {
        console.error('[v151] rm quiet-hours-menu reply failed:', err);
      }
      return;
    }

    // v151: 設不打擾時段預設組合 / 關閉
    if (cmd.startsWith('set-quiet-hours:')) {
      const range = cmd.substring('set-quiet-hours:'.length);
      const prefs = await getPreferences(env, userId);
      if (range === 'off') {
        await setPreferences(env, userId, { ...prefs, quietHoursEnabled: false });
        try {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '✓ 不打擾時段已關閉(夜間也會追殺)' }],
          });
        } catch {}
        return;
      }
      const m = range.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
      if (!m) return;
      await setPreferences(env, userId, {
        ...prefs,
        quietHoursEnabled: true,
        quietHoursStart: m[1],
        quietHoursEnd: m[2],
      });
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `✓ 不打擾時段 → ${m[1]} ~ ${m[2]}\n時段內追殺自動暫停` }],
        });
      } catch {}
      return;
    }

    // v149: Step 8 純文字版(電腦版 LINE 無法選 Flex 文字 → bot reply 純文字訊息給 user 選取複製)
    if (cmd === 'pushover-prompt-text') {
      const text = '請幫我把 Pushover App Token 設到我的 LINE bot,我等一下會貼 token 給你';
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text }],
        });
      } catch (err) {
        console.error('[v149] rm pushover-prompt-text reply failed:', err);
      }
      return;
    }

    // v137: Pushover 測試(複用既有 sendPushover 測試邏輯)
    if (cmd === 'pushover-test') {
      const key = await getUserPushoverKey(env, userId);
      const text = key
        ? (await sendPushover(env, key, '🚨 高優先測試', '應響鈴 1 次 — 沒響表示 iOS「Critical Alerts for high-priority」沒開', 1)).ok
          ? '✓ 已送 Pushover 測試訊息,看你 Pushover app 收到沒'
          : '✗ Pushover 送失敗(可能 user key 錯或 APP_TOKEN 未設)'
        : '尚未啟用 Pushover。先打「pushover <你的 user key>」啟用,再試測試';
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text }],
        });
      } catch (err) {
        console.error('[v137] rm pushover-test reply failed:', err);
      }
      return;
    }

    // v212: 早安/晚安時間 datetimepicker — 滑動選好時間 → 套用 + 重新顯示設定畫面(含再調按鈕)
    if (cmd === 'set-morning-time' || cmd === 'set-evening-time') {
      const time: string | undefined = event.postback?.params?.time;
      if (!time || !/^\d{2}:\d{2}$/.test(time)) {
        try {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '沒收到時間,請再選一次' }],
          });
        } catch {}
        return;
      }
      const isMorning = cmd === 'set-morning-time';
      const patch = isMorning
        ? { morningBriefHHMM: time, morningBriefEnabled: true }
        : { eveningSummaryHHMM: time, eveningSummaryEnabled: true };
      const prefs = await setPreferences(env, userId, patch);
      const label = isMorning ? '早安推播' : '晚安總結';
      const msgs = buildMorningNightReply(prefs);
      // 第一則前面加一行確認語,按鈕保留方便繼續調
      msgs[0] = { ...msgs[0], text: `✓ ${label} 改為每天 ${time}(自動開啟)\n\n` + msgs[0].text };
      try {
        await fetch('https://api.line.me/v2/bot/message/reply', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ replyToken: event.replyToken, messages: msgs }),
        });
      } catch (err) {
        console.error('[v212] set morning/night time reply failed:', err);
      }
      return;
    }

    // 靜音到 HH:MM(datetimepicker)
    if (cmd === 'mute-until') {
      const time: string | undefined = event.postback?.params?.time;
      if (!time || !/^\d{2}:\d{2}$/.test(time)) {
        try {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '沒收到時間,請再選一次' }],
          });
        } catch {}
        return;
      }
      // 算現在 → HH:MM 是 N 小時(若選的時間已過 → 視為明天該時間)
      const [hh, mm] = time.split(':').map((x) => parseInt(x, 10));
      const now = new Date();
      const tz = env.TIMEZONE || 'Asia/Taipei';
      // 用台北時區計算
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(now);
      const get = (t: string) => parts.find((p) => p.type === t)?.value || '0';
      const nowH = parseInt(get('hour'), 10);
      const nowM = parseInt(get('minute'), 10);
      const nowTotalMin = nowH * 60 + nowM;
      const targetTotalMin = hh * 60 + mm;
      let diffMin = targetTotalMin - nowTotalMin;
      if (diffMin <= 0) diffMin += 24 * 60; // 跨日
      const hours = diffMin / 60;
      await setSilenceTemp(env, userId, hours);
      const text = [
        `✓ 已靜音到 ${time}(約 ${hours.toFixed(1)} 小時)`,
        '靜音期間提醒類 push 暫停;你主動傳訊息給我不受影響',
        '要解除打「取消靜音」',
      ].join('\n');
      try {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text }],
        });
      } catch (err) {
        console.error('[v134] rm mute-until reply failed:', err);
      }
      return;
    }

    // 未識別的 cmd → 當 placeholder 走下面
  }

  // v133: Rich Menu placeholder — 新功能還沒實作的按鈕,回提示
  // v212: 早晚安推播設定按鈕(Rich Menu 設定子選單)→ 顯示設定畫面(取代原 placeholder)
  if (data === 'rm:早晚安推播設定') {
    const prefs = await getPreferences(env, userId);
    const msgs = buildMorningNightReply(prefs);
    try {
      await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyToken: event.replyToken, messages: msgs }),
      });
    } catch (err) {
      console.error('[v212] 早晚安設定 postback reply failed:', err);
    }
    const mnSummary = `[使用者點「早晚安推播設定」按鈕,已顯示設定畫面] 早安推播=每天早上問候/晨報;晚安總結=每晚當日回顧。可各自設推播時間(HH:MM),改完自動開啟。`;
    await Promise.all([
      saveConversation(env, userId, 'user', '早晚安設定', null),
      saveConversation(env, userId, 'assistant', mnSummary, null),
    ]).catch(() => {});
    return;
  }

  // v220: 電話介入 — LINE 上 Rich Menu 送的是舊版 postback data=rm:電話介入(顯示「→ 電話介入」)。
  //   接住它 → 回下一層卡片(安裝說明 / 使用說明)。免重跑整個 Rich Menu。
  //   (新版 setup-rich-menu 改送 rm:cmd=phone-setup-guide,那條在前面已 handle,兩條都通。)
  if (data === 'rm:電話介入') {
    try {
      await client.replyMessage({ replyToken: event.replyToken, messages: [buildPhoneMenuFlex()] });
    } catch (err) {
      console.error('[v220] rm:電話介入 reply failed:', err);
      await pushText(userId, '☎️ 電話介入 — 跟我說「電話安裝說明」或「電話使用說明」', env);
    }
    return;
  }

  if (data.startsWith('rm:')) {
    const feature = data.substring(3);
    const text = [
      `「${feature}」功能規劃中,即將推出。`,
      '',
      '目前可以打字直接告訴我你想做什麼,我會盡量幫你處理。',
    ].join('\n');
    try {
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text }],
      });
    } catch (err) {
      console.error('[v133] rm placeholder reply failed:', err);
    }
    return;
  }

  // 未識別的 postback action → 靜默,別吐錯訊息給 user
  console.log(`[v110] unknown postback action: ${data}`);
}

async function handleFollow(event: any, client: any, env: Env): Promise<void> {
  const userId = event.source.userId;
  await ensureUser(env, userId);

  try {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'text',
          text:
            '嗨,我是你的 AI 秘書 ✓\n\n' +
            '能力:\n' +
            '- 自然對話(Claude Sonnet 4.6)\n' +
            '- 記得對話脈絡 + 你的個人檔案\n' +
            '- 查你的 Notion 工作記錄 / 課程相關\n' +
            '- 上網搜尋即時資訊(天氣、新聞)\n\n' +
            '試試傳「我 5 月評等如何?」或「明天天氣?」',
        },
      ],
    });
  } catch (err) {
    console.error('[v20] Follow reply failed:', err);
  }
}

/**
 * 用 Whisper 把 LINE 語音訊息轉文字 + initial_prompt 引導常用詞
 */
async function transcribeAudio(messageId: string, env: Env): Promise<string> {
  const audioResponse = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    }
  );
  if (!audioResponse.ok) {
    throw new Error(`LINE 音檔下載失敗: ${audioResponse.status}`);
  }
  const audioBuffer = await audioResponse.arrayBuffer();
  const audioBytes = [...new Uint8Array(audioBuffer)];

  // Workers AI Whisper(嘗試傳 prompt — 不一定支援,但無害)
  const result: any = await env.AI.run('@cf/openai/whisper', {
    audio: audioBytes,
    initial_prompt: buildWhisperPrompt(env),
  });

  return result?.text || '(無法辨識語音內容)';
}

async function ensureUser(env: Env, userId: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, language, timezone) VALUES (?, 'zh-TW', ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(userId, env.TIMEZONE).run();
  } catch (err) {
    console.error('ensureUser:', err);
  }
}

async function getRecentHistory(
  env: Env,
  userId: string,
  limit: number
): Promise<Array<{ role: string; content: string }>> {
  try {
    const result = await env.DB.prepare(
      `SELECT role, content, created_at FROM conversations
       WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(userId, limit).all<{ role: string; content: string; created_at: string }>();
    const rows = (result.results || []).reverse();
    // v177: 跨日時把該則訊息前綴 [YYYY-MM-DD HH:MM] 給 Claude,讓 Claude 不會把昨天的 13:30 運動當成今天還有效
    //       只在「跨到不同日曆日」時 prefix,連續同日的不前綴(保持對話自然)
    let prevDate = '';
    return rows.map((r) => {
      const ts = new Date(r.created_at + (r.created_at.endsWith('Z') ? '' : 'Z'));
      const tpe = localWallClock(env, ts.getTime());
      const dateStr = `${tpe.getUTCFullYear()}-${String(tpe.getUTCMonth() + 1).padStart(2, '0')}-${String(tpe.getUTCDate()).padStart(2, '0')}`;
      const timeStr = `${String(tpe.getUTCHours()).padStart(2, '0')}:${String(tpe.getUTCMinutes()).padStart(2, '0')}`;
      let content = r.content;
      if (dateStr !== prevDate) {
        content = `[${dateStr} ${timeStr}] ${content}`;
        prevDate = dateStr;
      }
      return { role: r.role, content };
    });
  } catch (err) {
    console.error('getRecentHistory:', err);
    return [];
  }
}

// v125: 改 retry 3 次(0.5/1/2 秒 backoff) + fail 後設 KV `save-fail:<userId>` flag
async function saveConversation(
  env: Env,
  userId: string,
  role: 'user' | 'assistant',
  content: string,
  meta: { model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number } | null
): Promise<void> {
  const id = crypto.randomUUID();
  const params = [
    id, userId, role, content, 'line_message',
    meta?.model ?? null, meta?.inputTokens ?? null, meta?.outputTokens ?? null,
    meta?.costUsd ?? null, new Date().toISOString(),
  ];
  const stmt = `INSERT INTO conversations
       (id, user_id, role, content, trigger, model_used, input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const backoffMs = [0, 500, 1000, 2000]; // 第 1 次不等,後續 3 次 backoff
  let lastErr: any = null;
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt] > 0) {
      await new Promise((r) => setTimeout(r, backoffMs[attempt]));
    }
    try {
      await env.DB.prepare(stmt).bind(...params).run();
      if (attempt > 0) {
        console.log(`[saveConversation] 第 ${attempt + 1} 次重試成功 role=${role} uid=${userId.substring(0, 8)}`);
      }
      return; // 成功就回
    } catch (err: any) {
      lastErr = err;
      console.warn(`[saveConversation] attempt ${attempt + 1}/4 fail err=${err?.message ?? err}`);
    }
  }

  // 4 次都失敗 → fail-loud:詳細 log + 設 KV flag 讓下次 reply 警告 user
  console.error(
    `[saveConversation FAIL FINAL] role=${role} uid=${userId.substring(0, 8)} contentLen=${content.length} meta=${JSON.stringify(meta)} err=${lastErr?.message ?? lastErr} cause=${lastErr?.cause?.message ?? ''}`
  );
  if (env.CACHE) {
    try {
      await env.CACHE.put(`save-fail:${userId}`, new Date().toISOString(), { expirationTtl: 1800 });
    } catch {}
  }
}

// v125: 拿 + 清「上次 saveConversation fail」flag
async function consumeSaveFailFlag(env: Env, userId: string): Promise<boolean> {
  if (!env.CACHE) return false;
  try {
    const v = await env.CACHE.get(`save-fail:${userId}`);
    if (v) {
      await env.CACHE.delete(`save-fail:${userId}`);
      return true;
    }
  } catch {}
  return false;
}

// v132: 圖片支援 — 取台北日期(YYYY-MM-DD)當配額 KV key
function todayInTaipei(env: Env): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value ?? '';
  const m = parts.find((p) => p.type === 'month')?.value ?? '';
  const d = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${y}-${m}-${d}`;
}

// v132: 圖片配額 — 檢查 + 自增
const IMAGE_QUOTA_MAX = 20;
async function checkAndIncrementImageQuota(
  env: Env,
  userId: string
): Promise<{ allowed: boolean; today: number; max: number }> {
  const max = IMAGE_QUOTA_MAX;
  if (!env.CACHE) return { allowed: true, today: 0, max };
  const key = `image-quota:${userId}:${todayInTaipei(env)}`;
  const raw = await env.CACHE.get(key);
  const current = raw ? parseInt(raw, 10) : 0;
  if (current >= max) return { allowed: false, today: current, max };
  await env.CACHE.put(key, String(current + 1), { expirationTtl: 36 * 3600 });
  return { allowed: true, today: current + 1, max };
}

// v132: /額度 用 — 只讀,不增
async function getTodayImageCount(env: Env, userId: string): Promise<number> {
  if (!env.CACHE) return 0;
  const raw = await env.CACHE.get(`image-quota:${userId}:${todayInTaipei(env)}`);
  return raw ? parseInt(raw, 10) : 0;
}

// v220: 電話介入圖卡共用 helper(黑底卡片風,與 Pushover 教學同調)
function pcTxt(text: string, opts: any = {}): any {
  return { type: 'text', text, wrap: true, size: 'sm', color: opts.color || '#333333', weight: opts.weight, margin: opts.margin };
}
function pcCode(text: string): any {
  return {
    type: 'box', layout: 'vertical', backgroundColor: '#f5f5f5', paddingAll: '10px', cornerRadius: '6px', margin: 'sm',
    contents: [{ type: 'text', text, size: 'xs', color: '#000000', weight: 'bold', wrap: true }],
  };
}
function pcBubble(stepNum: number, total: number, title: string, body: any[]): any {
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#1a1a1a', paddingAll: '16px',
      contents: [
        { type: 'text', text: `${stepNum} / ${total}`, size: 'xs', color: '#aaaaaa' },
        { type: 'text', text: title, size: 'lg', weight: 'bold', color: '#ffffff', wrap: true, margin: 'xs' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: body },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '10px',
      contents: [{ type: 'text', text: '⚠ 跟畫面不同就截圖傳你的 Claude,他看圖帶你', size: 'xs', color: '#888888', wrap: true }],
    },
  };
}

// v220: 電話介入 — 下一層 menu(安裝說明 / 使用說明)
function buildPhoneMenuFlex(): any {
  const RED = '#e74c3c';
  return {
    type: 'flex', altText: '電話介入 — 安裝 / 使用說明',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#1a1a1a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '☎️ 電話介入', size: 'xl', weight: 'bold', color: '#ffffff' },
          { type: 'text', text: '追殺叫不動 / 指定時間 → 真的打電話,用人聲念給你聽', size: 'xs', color: '#aaaaaa', wrap: true, margin: 'sm' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
        contents: [
          { type: 'text', text: '想看哪個?', size: 'sm', weight: 'bold', color: '#333333' },
          { type: 'button', style: 'primary', color: RED,
            action: { type: 'postback', label: '📥 安裝說明', data: 'rm:cmd=phone-install', displayText: '電話安裝說明' } },
          { type: 'button', style: 'secondary',
            action: { type: 'postback', label: '📖 使用說明', data: 'rm:cmd=phone-usage', displayText: '電話使用說明' } },
        ],
      },
    },
  };
}

// v220: 電話介入「安裝說明」carousel(從零裝 Twilio,對應 docs/TWILIO-PHONE-SETUP.md)
function buildPhoneInstallFlex(): any {
  const T = 6;
  return {
    type: 'flex', altText: '電話介入 — 安裝說明(6 步)',
    contents: {
      type: 'carousel',
      contents: [
        pcBubble(1, T, '註冊 Twilio', [
          pcTxt('💻 建議用電腦操作 — 後面要用終端機貼指令,電腦方便很多', { weight: 'bold', color: '#e74c3c' }),
          pcTxt('到 twilio.com 註冊,用 Google 帳號登入最快'),
          pcTxt('免綁信用卡,註冊後是 trial 試用帳號、附試用金'),
          { type: 'button', style: 'primary', color: '#e74c3c', height: 'sm', margin: 'sm',
            action: { type: 'uri', label: '打開 twilio.com', uri: 'https://www.twilio.com/try-twilio' } },
        ]),
        pcBubble(2, T, '驗證你的手機(必做)', [
          pcTxt('trial 只能撥「已驗證」的號碼', { weight: 'bold' }),
          pcTxt('左側 Phone Numbers → Manage → Verified Caller IDs'),
          pcTxt('加你的台灣手機,收簡訊碼驗證'),
        ]),
        pcBubble(3, T, '拿 3 個憑證', [
          pcTxt('首頁往下滑到「Account Info」區塊,拿:'),
          pcTxt('• Account SID(AC 開頭)'),
          pcTxt('• Auth Token(按 Show 才顯示)'),
          pcTxt('• My Twilio phone number(+1 開頭)'),
        ]),
        pcBubble(4, T, '存 4 個密碼到雲端', [
          pcTxt('💻 電腦終端機操作,先確認在 line-ai-secretary 資料夾'),
          pcTxt('一條一條來:貼指令按 Enter → 終端機問「Enter a secret value」→ 貼對應的值再 Enter → Success 換下一條', { color: '#e74c3c' }),
          pcTxt('(點下面「📋 傳純文字指令」按鈕,會附每條配哪個值)'),
          pcCode('npx wrangler secret put TWILIO_ACCOUNT_SID'),
          pcCode('npx wrangler secret put TWILIO_AUTH_TOKEN'),
          pcCode('npx wrangler secret put TWILIO_PHONE_NUMBER'),
          pcCode('npx wrangler secret put USER_PHONE_NUMBER'),
          pcTxt('⚠ 貼密碼看不到字是正常的;USER_PHONE_NUMBER 填你手機,+886 開頭去掉 0', { color: '#e74c3c' }),
          { type: 'button', style: 'primary', color: '#e74c3c', height: 'sm', margin: 'md',
            action: { type: 'postback', label: '📋 傳純文字指令(可複製)', data: 'rm:cmd=phone-copy-cmds', displayText: '傳電話安裝指令' } },
        ]),
        pcBubble(5, T, '測試「打給我」', [
          pcTxt('LINE 傳「打給我」,幾秒內手機會響'),
          pcTxt('trial 接起來要先聽英文、按任一鍵,才聽到中文 — 正常'),
          pcTxt('沒響:① 號碼是不是 +886 ② 有沒有在第 2 步驗證'),
        ]),
        pcBubble(6, T, '先知道的雷區', [
          pcTxt('① trial 有英文提示音(升級才消)'),
          pcTxt('② 美國號撥台灣有 7 秒詐騙警語(台灣電信強制,去不掉)'),
          pcTxt('③ 手機號一律 +886 開頭、去掉最前面的 0'),
          pcTxt('④ 把 Twilio 號碼存成聯絡人「AI秘書」→ 來電就顯示名字', { weight: 'bold' }),
        ]),
      ],
    },
  };
}

// v220: 電話介入「使用說明」carousel(這次新功能:相對時間 / 查詢型 / Notion 📞 / 追殺電話)
function buildPhoneUsageFlex(): any {
  const T = 6;
  return {
    type: 'flex', altText: '電話介入 — 使用說明(6 張)',
    contents: {
      type: 'carousel',
      contents: [
        pcBubble(1, T, 'LINE 直接講', [
          pcTxt('打字就能設電話提醒:'),
          pcCode('9點打給我提醒我開會'),
          pcCode('5分鐘後打給我提醒我喝水'),
          pcTxt('絕對時間、相對時間(N分鐘後/半小時後)都認'),
        ]),
        pcBubble(2, T, 'LINE 查詢型(報計畫)', [
          pcTxt('叫它打來報你的「真實工作」:', { weight: 'bold' }),
          pcCode('X點打給我,跟我說明天有哪些工作'),
          pcTxt('到點電話會念 Notion 裡明天的真實工作,不是複述你那句話'),
        ]),
        pcBubble(3, T, '在 Notion 設', [
          pcTxt('今日計畫頁寫一行「待辦(checkbox)」:'),
          pcCode('📞19:15 吃藥'),
          pcTxt('⚠ 必須是 checkbox 格式、符號是 📞(不是 ☎️)、放最前面', { color: '#e74c3c' }),
        ]),
        pcBubble(4, T, 'Notion 查詢型', [
          pcTxt('Notion 也能報計畫:'),
          pcCode('📞19:25 報明天工作'),
          pcTxt('到點電話念真實明天工作(跟 LINE 查詢型同一套)'),
        ]),
        pcBubble(5, T, '自動追殺電話', [
          pcTxt('一般提醒你一直不理:'),
          pcTxt('LINE → Pushover 都叫不動(響滿 3 次)'),
          pcTxt('→ 自動升級「打電話」催你,比通知更逼', { weight: 'bold' }),
        ]),
        pcBubble(6, T, '重要行為', [
          pcTxt('• 電話打完即止,不會一直追殺你'),
          pcTxt('• 靜音時段不撥,延到非靜音再撥'),
          pcTxt('• 電話提醒不算「工作時段」(不會誤判分心)'),
          pcTxt('• Twilio 沒設好 → 自動改推 LINE,不漏提醒'),
        ]),
      ],
    },
  };
}

// v226: 帶東西「設定」卡 — 目前接固定必帶(之後擴充提醒時機/模板等)
function buildBringSettingsFlex(baseKit: string[]): any {
  return {
    type: 'flex', altText: '帶東西 — 設定',
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#1a1a1a', paddingAll: '16px',
        contents: [{ type: 'text', text: '⚙️ 帶東西 設定', size: 'lg', weight: 'bold', color: '#ffffff' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: [
          pcTxt('固定必帶(無論去哪都帶)', { weight: 'bold' }),
          pcTxt(baseKit.length ? baseKit.map((s) => `• ${s}`).join('\n') : '(目前是空的)'),
          pcTxt('怎麼改 — 直接打字:', { weight: 'bold', margin: 'md' }),
          pcCode('固定必帶加 行動電源'),
          pcCode('固定必帶拿掉 水壺'),
          pcTxt('更多設定(提醒時機 / 情境模板)陸續加。', { color: '#888888', margin: 'md' }),
        ],
      },
    },
  };
}

// v226: 帶東西「使用說明」小卡 — 黑底卡片風,5 張 carousel(與電話/Pushover 教學同調)
function buildBringHelpFlex(): any {
  const bub = (n: number, total: number, title: string, body: any[]): any => ({
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#1a1a1a', paddingAll: '16px',
      contents: [
        { type: 'text', text: `🎒 帶東西  ${n} / ${total}`, size: 'xs', color: '#aaaaaa' },
        { type: 'text', text: title, size: 'lg', weight: 'bold', color: '#ffffff', wrap: true, margin: 'xs' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: body },
  });
  const T = 5;
  return {
    type: 'flex', altText: '帶東西 — 使用說明',
    contents: {
      type: 'carousel',
      contents: [
        bub(1, T, '這功能是什麼', [
          pcTxt('出門前手機嗶一下,bot 就把「今天該帶的東西」整理成一張清單推給你。', { weight: 'bold' }),
          pcTxt('專治 ADHD 最常見的「出門才發現忘了帶」。'),
        ]),
        bub(2, T, '清單自動合併 5 個來源', [
          pcTxt('• 固定必帶:鑰匙 / 錢包 / 手機'),
          pcTxt('• 今天臨時加的:你說過「帶雨傘」'),
          pcTxt('• 今天的承諾:答應帶給朋友的東西'),
          pcTxt('• 今日計畫出門項:Notion 寫「去開會」'),
          pcTxt('• AI 判斷:「去客戶那」→ 自動想到合約 / 名片'),
        ]),
        bub(3, T, '怎麼拿到清單', [
          pcTxt('① 出門嗶門口的 NFC 標籤(到貨後貼),或'),
          pcTxt('② 打開你的專屬網址(等於「虛擬嗶」):'),
          pcCode('.../go?k=你的密碼'),
          pcTxt('清單就會推到你 LINE。'),
        ]),
        bub(4, T, '臨時加 & 讓它越來越懂你', [
          pcTxt('臨時要帶 → 打「帶 X」(例:帶雨傘)'),
          pcTxt('同個東西帶滿 3 次 → bot 主動問「要不要固定?」', { weight: 'bold' }),
          pcTxt('點「📌 固定加 X」一鍵固定。'),
          pcTxt('手動管理:固定必帶 /  固定必帶加 X /  固定必帶拿掉 X'),
        ]),
        bub(5, T, '收到清單後的按鈕', [
          pcTxt('清單底下會有:'),
          pcTxt('• ✅ 都帶了 → 回你「出門順利」'),
          pcTxt('• 📌 固定加 X → 一鍵把常帶的設成固定'),
          pcTxt('實體標籤到貨前,用網址就能先玩。', { color: '#888888' }),
        ]),
      ],
    },
  };
}

// v138: Pushover 設定教學 — 10 步 Carousel,純文字,每步底部備援提示
function buildPushoverSetupFlex(): any {
  const ORANGE = '#f0a05b';
  const STEP_COUNT = 11;

  // 每 bubble 共用 footer:備援提示 + 測試按鈕(只 step 7)
  function makeFooter(stepNum: number): any {
    // v165: 測試按鈕放 Step 9(貼 Token 完)+ Step 10(Critical Alerts 完)+ Step 11(進階音效末)
    //       Step 9 是第一次測試,Step 10 是設完突破靜音再測,Step 11 是音效調完最終測
    const hasTestButton = stepNum >= 9;
    return {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '12px',
      contents: [
        ...(hasTestButton
          ? [{
              type: 'button',
              style: 'primary',
              color: ORANGE,
              action: { type: 'postback', label: '測試 pushover', data: 'rm:cmd=pushover-test', displayText: '→ Pushover 測試' },
            }]
          : []),
        {
          type: 'text',
          text: '⚠ 若與實際畫面不同,截圖那畫面傳給你的 Claude Code,他會看圖協助',
          size: 'xs',
          color: '#888888',
          wrap: true,
        },
      ],
    };
  }

  function makeBubble(stepNum: number, title: string, body: any[]): any {
    return {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1a1a1a',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: `Step ${stepNum} / ${STEP_COUNT}`, size: 'xs', color: '#aaaaaa' },
          { type: 'text', text: title, size: 'lg', weight: 'bold', color: '#ffffff', wrap: true, margin: 'xs' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '14px',
        contents: body,
      },
      footer: makeFooter(stepNum),
    };
  }

  function txt(text: string, opts: any = {}): any {
    return { type: 'text', text, wrap: true, size: 'sm', color: opts.color || '#333333', weight: opts.weight, margin: opts.margin };
  }
  function code(text: string): any {
    return {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#f5f5f5',
      paddingAll: '10px',
      cornerRadius: '6px',
      margin: 'sm',
      contents: [{ type: 'text', text, size: 'xs', color: '#000000', weight: 'bold', wrap: true }],
    };
  }
  function sep(): any { return { type: 'separator', margin: 'md' }; }

  return {
    type: 'flex',
    altText: '設定 Pushover — 7 步教學',
    contents: {
      type: 'carousel',
      contents: [
        makeBubble(1, '下載 Pushover app(手機版)', [
          txt('搜尋「Pushover Notifications」', { weight: 'bold' }),
          txt('icon 是藍底白色 P 字'),
          {
            type: 'button',
            style: 'primary',
            color: '#f0a05b',
            height: 'sm',
            margin: 'sm',
            action: { type: 'uri', label: 'iOS App Store', uri: 'https://apps.apple.com/app/pushover-notifications/id506088175' },
          },
          {
            type: 'button',
            style: 'primary',
            color: '#f0a05b',
            height: 'sm',
            margin: 'sm',
            action: { type: 'uri', label: 'Android Play', uri: 'https://play.google.com/store/apps/details?id=net.superblock.pushover' },
          },
          sep(),
          txt('30 天免費試用,試用後 USD $4.99 一次買斷', { color: '#888888' }),
          txt('⚠ 手機版 / 電腦版 license 獨立計費(各 $4.99)。這步只裝手機,主要在手機收推播。', { color: '#888888' }),
        ]),
        makeBubble(2, '註冊 Pushover 帳號', [
          txt('開 app → Sign Up(或登入既有帳號)'),
          txt('填 email + 密碼'),
          sep(),
          txt('收 email 點驗證連結', { weight: 'bold' }),
          txt('沒收到?看垃圾信夾', { color: '#888888' }),
        ]),
        makeBubble(3, '找你的 User Key', [
          txt('打開 Pushover app'),
          txt('右上角點齒輪 ⚙', { weight: 'bold' }),
          txt('進入設定頁 → 看到「Your User Key」'),
          txt('一串 30 字元英數字'),
          txt('長按整串 → 複製', { weight: 'bold' }),
          sep(),
          txt('這個 key 等同你的 Pushover ID', { color: '#888888' }),
        ]),
        makeBubble(4, 'LINE 啟用 User Key', [
          txt('對這個 bot 打:'),
          code('pushover <貼上你的 user key>'),
          txt('範例(假 key,不要直接用):', { margin: 'md', color: '#888888' }),
          code('pushover abc123xyz789def456ghi012jkl345'),
          txt('整段一句,不要換行', { color: '#888888' }),
          sep(),
          txt('成功會回「✓ Pushover 已啟用」', { weight: 'bold' }),
        ]),
        makeBubble(5, '註冊 Application — 開頁面', [
          txt('🖥 建議從這步起改用電腦', { weight: 'bold', color: ORANGE }),
          txt('LINE 桌面版打開這對話一樣看得到教學', { color: '#888888' }),
          txt('Step 8-9 要用 Claude Code,電腦操作方便', { color: '#888888' }),
          sep(),
          txt('點下方按鈕打開 Application 註冊頁:'),
          {
            type: 'button',
            style: 'primary',
            color: '#f0a05b',
            height: 'sm',
            margin: 'sm',
            action: { type: 'uri', label: '打開 apps/build', uri: 'https://pushover.net/apps/build' },
          },
          sep(),
          txt('下一步:看怎麼填表單', { color: '#888888' }),
          txt('若被擋「Email 未驗證」→ 先回信箱點 Pushover 驗證信', { color: '#888888' }),
        ]),
        makeBubble(6, '填寫 Application 表單', [
          txt('• Name:隨意(例:你 bot 名)'),
          txt('  推播時會顯示這個 app 名', { color: '#888888' }),
          txt('• Description:留白'),
          txt('  (不影響功能)', { color: '#888888' }),
          txt('• URL:留白'),
          txt('  (不影響功能)', { color: '#888888' }),
          txt('• Icon:不用選'),
          txt('  (通知欄圖示一律是 Pushover 預設)', { color: '#888888' }),
          txt('• ☑ 勾「By checking this box」'),
          txt('  (同意服務條款,必勾)', { color: '#888888' }),
          sep(),
          txt('完成 → 點 Create Application', { weight: 'bold' }),
        ]),
        makeBubble(7, '拿 API Token', [
          txt('Application 建好後,頁面顯示:'),
          txt('API Token/Key', { weight: 'bold' }),
          txt('一串 30 字元英數字'),
          txt('複製整串', { weight: 'bold' }),
          sep(),
          txt('這個 token 是 bot 用的,不是 user key', { color: '#888888' }),
        ]),
        makeBubble(8, '告知 Claude 要做什麼', [
          txt('打開 Claude Code(電腦)'),
          txt('對你的 Claude 貼這段話:', { weight: 'bold', margin: 'md' }),
          code('請幫我把 Pushover App Token 設到我的 LINE bot,我等一下會貼 token 給你'),
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            margin: 'sm',
            action: {
              type: 'clipboard',
              label: '📋 複製(手機)',
              clipboardText: '請幫我把 Pushover App Token 設到我的 LINE bot,我等一下會貼 token 給你',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            margin: 'sm',
            action: {
              type: 'postback',
              label: '📤 純文字版(電腦)',
              data: 'rm:cmd=pushover-prompt-text',
              displayText: '→ 純文字版',
            },
          },
          sep(),
          txt('Claude 看到會說「好,給我 token」', { color: '#888888' }),
          txt('還不要貼 token,先讓 Claude 知道意圖', { color: '#888888' }),
        ]),
        makeBubble(9, '貼 Token 給 Claude + 測試', [
          txt('複製 Step 7 拿到的 API Token'),
          txt('貼給你的 Claude', { weight: 'bold' }),
          sep(),
          txt('Claude 會自動跑 wrangler 設定', { color: '#888888' }),
          txt('完成後 Claude 會說「✓ 設定好了」', { color: '#888888' }),
          sep(),
          txt('回 LINE 打「測試 pushover」', { weight: 'bold', margin: 'md' }),
          txt('或按下方按鈕'),
          txt('手機 Pushover app 跳通知 = 成功 ✓', { color: '#888888' }),
        ]),
        makeBubble(10, '響不夠強?開 Critical Alerts', [
          txt('Step 9 測試只振動沒響鈴?', { weight: 'bold' }),
          txt('iOS Critical Alerts 沒開 — 它是唯一能突破靜音 / 勿擾 / Focus 強制響鈴的權限', { color: '#888888' }),
          sep(),
          txt('① Pushover app 內(app 層)', { weight: 'bold', margin: 'md' }),
          txt('Settings → 拉到底「Critical Alerts」區'),
          txt('開「Critical Alerts for high-priority」', { weight: 'bold' }),
          txt('系統會跳 prompt → 允許', { color: '#888888' }),
          sep(),
          txt('② iOS 系統設定(系統層)', { weight: 'bold', margin: 'md' }),
          txt('設定 → 通知 → Pushover'),
          txt('拉到底 → Critical Alerts(重要提醒)→ 開', { weight: 'bold' }),
          txt('順便確認 Sounds(聲音)+ Time Sensitive 也開', { color: '#888888' }),
          sep(),
          txt('⚠ 兩層都要開才會生效', { color: ORANGE, weight: 'bold' }),
          txt('做完 → 回 LINE 再傳「pushover 測試」確認', { margin: 'md' }),
        ]),
        makeBubble(11, '進階:修改音效', [
          txt('Pushover 預設音效柔和、不太警示', { color: '#888888' }),
          sep(),
          txt('若想換音效:', { weight: 'bold' }),
          txt('• 在 Pushover app 內試聽 30+ 種音效', { wrap: true }),
          txt('  (Settings → Sounds 試聽)', { color: '#888888' }),
          txt('• 決定喜歡的之後'),
          txt('• 跟你的 Claude Code 討論處理', { weight: 'bold' }),
          sep(),
          txt('或在 Pushover 後台 Subscriptions 直接覆寫', { color: '#888888' }),
          txt('整個 LINE bot 都用你選的音效', { color: '#888888' }),
        ]),
      ],
    },
  };
}

// v151: 追殺等級 Flex(顯示當前 + 4 切換 + 不打擾入口)
function buildFollowupLevelFlex(currentLevel: string): any {
  const ORANGE = '#f0a05b';
  const labels: Record<string, string> = {
    off: 'Off — 完全不追',
    lite: 'Lite — 3 次後停 / 10 分間隔',
    standard: 'Standard — 無上限 / 1 分間隔',
    aggressive: 'Aggressive — 第 1 次起 Emergency',
  };
  function btn(level: string, label: string): any {
    const isCurrent = level === currentLevel;
    return {
      type: 'button',
      style: isCurrent ? 'primary' : 'secondary',
      color: isCurrent ? ORANGE : undefined,
      height: 'sm',
      margin: 'sm',
      action: { type: 'postback', data: `rm:cmd=set-followup-level:${level}`, displayText: `→ ${label}`, label },
    };
  }
  return {
    type: 'flex',
    altText: '追殺等級設定',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1a1a1a',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '追殺等級', size: 'lg', weight: 'bold', color: '#ffffff' },
          { type: 'text', text: '當前:' + (labels[currentLevel] || currentLevel), size: 'xs', color: '#aaaaaa', margin: 'sm', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '14px',
        contents: [
          btn('off', 'Off'),
          btn('lite', 'Lite'),
          btn('standard', 'Standard'),
          btn('aggressive', 'Aggressive'),
          { type: 'separator', margin: 'md' },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            margin: 'sm',
            action: { type: 'postback', data: 'rm:cmd=quiet-hours-menu', displayText: '→ 不打擾時段', label: '不打擾時段設定' },
          },
        ],
      },
    },
  };
}

// v151: 不打擾時段 Flex(預設組合 + 關閉)
function buildQuietHoursFlex(prefs: any): any {
  const ORANGE = '#f0a05b';
  const enabled = prefs.quietHoursEnabled !== false;
  const start = prefs.quietHoursStart || '23:00';
  const end = prefs.quietHoursEnd || '07:00';
  const currentRange = enabled ? `${start}-${end}` : 'off';

  function btn(range: string, label: string): any {
    const isCurrent = currentRange === range;
    return {
      type: 'button',
      style: isCurrent ? 'primary' : 'secondary',
      color: isCurrent ? ORANGE : undefined,
      height: 'sm',
      margin: 'sm',
      action: { type: 'postback', data: `rm:cmd=set-quiet-hours:${range}`, displayText: `→ ${label}`, label },
    };
  }

  return {
    type: 'flex',
    altText: '不打擾時段設定',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1a1a1a',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '不打擾時段', size: 'lg', weight: 'bold', color: '#ffffff' },
          { type: 'text', text: '當前:' + (enabled ? `${start} ~ ${end}` : '已關閉'), size: 'xs', color: '#aaaaaa', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '14px',
        contents: [
          { type: 'text', text: '預設組合(點即套用):', size: 'sm', color: '#888888' },
          btn('23:00-07:00', '23:00 ~ 07:00(預設)'),
          btn('22:00-07:30', '22:00 ~ 07:30'),
          btn('21:00-08:00', '21:00 ~ 08:00(長)'),
          btn('00:00-06:00', '00:00 ~ 06:00(短)'),
          { type: 'separator', margin: 'md' },
          btn('off', '關閉(夜間也追)'),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '進階:打字「不打擾 HH:MM-HH:MM」自訂時段', size: 'xs', color: '#888888', wrap: true },
        ],
      },
    },
  };
}

// v132: LINE 圖片下載 — Data API 抓 binary → base64
async function downloadLineImage(
  messageId: string,
  env: Env
): Promise<{
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}> {
  const r = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } }
  );
  if (!r.ok) {
    throw new Error(`LINE 圖片下載失敗: ${r.status}`);
  }
  const ct = (r.headers.get('content-type') || 'image/jpeg').toLowerCase();
  let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' = 'image/jpeg';
  if (ct.includes('png')) mediaType = 'image/png';
  else if (ct.includes('gif')) mediaType = 'image/gif';
  else if (ct.includes('webp')) mediaType = 'image/webp';

  const buf = await r.arrayBuffer();
  // Anthropic API base64 image 上限 5MB(實際 binary 上限 ~3.75MB)
  if (buf.byteLength > 3.75 * 1024 * 1024) {
    throw new Error(`圖片過大 ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB(上限 ~3.75MB),請壓縮後重傳`);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  // 分塊轉 base64 避免 stack overflow
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  const base64 = btoa(bin);
  return { base64, mediaType };
}
