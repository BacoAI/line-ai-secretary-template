/**
 * 提醒相關指令的寬鬆解析 + 執行
 *
 * 走「捷徑路線」:不過 Claude,line.ts 早期判斷,直接執行
 *
 * 支援指令:
 * - 提醒清單:「提醒」/「我的提醒」/「目前提醒」
 * - 已開始:「已開始 14:00」/「開始了」(無編號就找 first first_sent)
 * - 延後:「延後 14:00 15 分」/「延後 看牙醫 30」
 * - 跳過:「跳過 14:00 因為下雨」/「不做 看牙醫」
 * - 靜音:「靜音 2 小時」/「靜音 23:00~7:30」/「靜音」(模糊問清楚)
 * - 取消靜音:「取消靜音」/「打開提醒」
 * - 設提醒:「設提醒 14:00 看牙醫」/「設提醒 2」(需要編號 context)
 */

import type { Env } from '../types';
import {
  loadReminders,
  saveReminders,
  formatTime,
  parseTimeMin,
  detectQueryPlan,
  type Reminder,
} from './store';
import {
  getSilence,
  setSilenceTemp,
  setSilenceRecurring,
  cancelSilence,
} from './silence';
import {
  getPreferences,
  setPreferences,
} from '../preferences/store';
import { calculateClaudeCost, logCost } from '../safety/budget';
import { proposeBatchAction } from '../tools/notion-write-tools';
import { isTwilioConfigured } from '../../adapters/twilio';

export interface CommandResult {
  matched: boolean;
  reply?: string;
  doNotShowQuickReply?: boolean; // true = 不帶 Quick Reply(第二次提醒場景)
  reminderId?: string; // 若此次 reply 跟某筆 reminder 相關 → line.ts 會把 reply messageId 記進 KV
  skipReply?: boolean; // v170: handler 已自己 push 訊息(如 batch 提案),caller 完全不要再送 reply
}

// ============================================================
// 入口:嘗試各種指令
// ============================================================
export async function tryReminderCommand(
  env: Env,
  userId: string,
  text: string,
  quotedReminderId?: string | null
): Promise<CommandResult> {
  const t = text.trim();

  // 親子提醒(功能 2)防亂關:純小孩(有未完成的家長提醒、且沒有自己的提醒)
  //   不能用通用「延後 / 跳過 / 不做 / 靜音」逃避家長提醒,只能用「完成 / 等一下做」按鈕(有上限、家長看得到)。
  //   開發者 / 家長(有自己的 Notion 提醒)→ hasOwnActive=true → 完全不受影響。
  if (/^(延|跳過|不做|不去|靜音|全部延|今天.*延)/.test(t)) {
    const rems = await loadReminders(env, userId);
    const hasActiveParentReq = rems.some(
      (r) => r.source === 'parent_request' && r.enabled && r.state !== 'resolved'
    );
    const hasOwnActive = rems.some(
      (r) => r.source !== 'parent_request' && r.source !== 'self' && r.enabled && r.state !== 'resolved'
    );
    if (hasActiveParentReq && !hasOwnActive) {
      return {
        matched: true,
        reply:
          '這是主帳號幫你設的提醒,不能自己延後或關掉喔。\n做完按「✓ 完成」;真的需要晚點做按「⏰ 等一下做」(最多 2 次,主帳號看得到)。',
      };
    }
  }

  // v216: 算「現在台北分鐘數」— 供相對時間電話提醒(「N分鐘後 / 半小時後打給我」)換算實際時間點用
  const nowMinTpe = (() => {
    const tpe = new Intl.DateTimeFormat('en-GB', {
      timeZone: env.TIMEZONE || 'Asia/Taipei',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    const [hh, mm] = tpe.split(':').map((x) => parseInt(x, 10));
    return hh * 60 + mm;
  })();

  // v170: 批次語意守門員 — 含這些字 → 任何 single-target shortcut 都要讓開
  //       原則:寧可錯讓 Claude 確認一次,也不可錯誤批次執行
  const isBatchPhrasing = /全部|所有|統統|統一|剩餘|剩下|整天|一起|全都|都延|都改|都做|都跳|都取消|都完成/.test(t);

  // v171: server-side 批次延後 fast path — 不靠 Claude(原本 Claude 路徑常因 Anthropic timeout / Worker 30s 上限 silent fail)
  //       觸發:含 batch 字 + 含 延/推/往後 + 含 N 分(或小時) → 直接跳過 Claude,本機建 actions + 推 propose_batch_action
  //       支援 optional cutoff:「9:30 後 / 之後」→ 只動 >= 9:30 的 reminders
  // v172: 加 bail-out — 含例外詞 / 多動作 / 模糊時段範圍 → 不走 fast path,讓 Claude 判斷
  //       原則:fast path 只接「最直白的純批次」,把判斷空間留給 Claude
  const batchPostponeIntent = (() => {
    if (!isBatchPhrasing) return null;
    if (!/(延|推|往後)/.test(t)) return null;
    // 例外詞 → 有除外條件,要 Claude 判斷哪些不動
    if (/除了|但|不過|不算|不要動|不要延|不要推|except/i.test(t)) return null;
    // 多動作詞 → 一句講多件事,要 Claude 拆解
    if (/加|新增|刪除|刪掉|取消|還要|還有|另外|然後|順便/.test(t)) return null;
    // 模糊時段範圍詞 → 要 Claude 判斷該時段對應哪些 reminders(早上/上午/下午/晚上)
    if (/早上|上午|中午|下午|晚上|清晨|傍晚|午前|午後/.test(t)) return null;
    const mHr = t.match(/(\d+)\s*(?:小時|時)/);
    const mMin = t.match(/(\d+)\s*分鐘?/);
    let offsetMin = 0;
    if (mHr) offsetMin += parseInt(mHr[1], 10) * 60;
    if (mMin) offsetMin += parseInt(mMin[1], 10);
    if (offsetMin === 0) return null;
    const mCutoff = t.match(/(\d{1,2}:\d{2})\s*(?:後|之後|以後)/);
    const cutoffMin = mCutoff ? parseTimeMin(mCutoff[1]) : null;
    return { offsetMin, cutoffMin };
  })();
  if (batchPostponeIntent) {
    return await handleBatchPostpone(env, userId, batchPostponeIntent.offsetMin, batchPostponeIntent.cutoffMin);
  }

  // v214:「X點打給我,提醒我要XXX」— 設一個到點打電話的 reminder(callAction=true)
  //   吃變體:「9點打給我提醒我要開會」「9:30 打電話給我 記得吃藥」「下午3點打給我叫我寫報告」
  //   觸發條件:含時間 + 含「打給我 / 打電話(給我)」。內容取「打給我/打電話」之後那段(去掉「提醒我(要)/叫我/記得」引導詞)。
  {
    const callIntent = parseCallReminderCommand(t, nowMinTpe);
    if (callIntent) {
      return await handleSetCallReminder(env, userId, callIntent.timeMin, callIntent.content, callIntent.queryPlan);
    }
  }

  // 1. 提醒清單
  // v221: 補認「提醒清單」(LINE 按鈕送的就是這四字,舊版漏認 → 落給 Claude 誤用 outing 工具亂答)
  //       + 常見口語變體(查/看/列表/有哪些)。對齊 feedback_line_bot_shortcut_fuzzy。
  if (/^(提醒|我的提醒|目前提醒|現在的提醒|提醒清單|我的提醒清單|提醒列表|查提醒|看提醒|查看提醒|有哪些提醒|目前有哪些提醒|還有哪些提醒|reminders?|\/提醒)$/i.test(t)) {
    return { matched: true, reply: await buildRemindersList(env, userId) };
  }

  // 2. 取消靜音
  if (/^(取消靜音|打開提醒|解除靜音|cancel\s?silence)$/i.test(t)) {
    const ok = await cancelSilence(env, userId);
    return {
      matched: true,
      reply: ok ? '✓ 已取消靜音,提醒恢復' : '目前沒在靜音中',
    };
  }

  // 3. 靜音 N 小時
  let m = t.match(/^靜音\s*(\d+(?:\.\d+)?)\s*小時?$/);
  if (m) {
    const hours = parseFloat(m[1]);
    const s = await setSilenceTemp(env, userId, hours);
    const endsLocal = new Date(s.endsAt!).toLocaleTimeString('zh-TW', {
      timeZone: env.TIMEZONE || 'Asia/Taipei',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return {
      matched: true,
      reply: `✓ 已暫時靜音 ${hours} 小時(${endsLocal} 結束)\n靜音期間提醒會延後,結束後我會檢查 Notion 變動再提醒。\n你還是可以主動傳訊息給我。`,
    };
  }

  // 4. 靜音 HH:MM~HH:MM(每天)
  m = t.match(/^靜音\s*(\d{1,2}:\d{2})\s*[~\-到至]\s*(\d{1,2}:\d{2})$/);
  if (m) {
    const start = m[1];
    const end = m[2];
    await setSilenceRecurring(env, userId, start, end);
    return {
      matched: true,
      reply: `✓ 已設每天 ${start}~${end} 不打擾,你未來可以隨時要求我修改這規則。\n(打「取消靜音」可立刻解除)`,
    };
  }

  // 5. 模糊「靜音」
  if (/^靜音$/.test(t)) {
    return {
      matched: true,
      reply: '靜音多久?是這次暫時還是每天固定?\n• 「靜音 2 小時」← 暫時\n• 「靜音 23:00~7:30」← 每天固定\n• 「靜音 30 分鐘」← 暫時短',
    };
  }

  // 6. 已開始/正在做/在做了/動手了(可選編號或時間)— v119 擴增口語變體
  // v170: 加 isBatchPhrasing 守門 — 「全部已開始」不可走單筆 shortcut
  m = t.match(/^(?:已?開始|正在做|在做(?:了)?|動手(?:了)?|做了|處理中)\s*(?:這個)?(?:這件|這項)?\s*(#?\d+|\d{1,2}:\d{2})?$/);
  if (m && !isBatchPhrasing) {
    return await handleStartedCommand(env, userId, m[1], quotedReminderId);
  }

  // 7. 延後 N M 分(指定目標 + 分鐘)
  m = t.match(/^延後\s*(#?\d+|\d{1,2}:\d{2}|.+?)\s+(\d+)\s*分鐘?$/);
  if (m && !isBatchPhrasing) {
    return await handlePostponeCommand(env, userId, m[1], parseInt(m[2]), quotedReminderId);
  }
  // 7b. 「延後 N 分鐘」/「這個延後 N 分鐘」/「幫我延後 N 分鐘」— 無時間 spec,靠 quotedReminderId 鎖定
  m = t.match(/^(?:這個|幫我|麻煩|請|這件事|這項)?\s*(?:幫我|麻煩|請)?\s*延後\s*(\d+)\s*分鐘?$/);
  if (m && !isBatchPhrasing) {
    return await handlePostponeCommand(env, userId, '', parseInt(m[1]), quotedReminderId);
  }
  // 7c. 「這個幫我延後 N 分鐘」之類較鬆口語
  m = t.match(/^.{0,10}延後\s*(\d+)\s*分鐘?$/);
  if (m && !isBatchPhrasing) {
    return await handlePostponeCommand(env, userId, '', parseInt(m[1]), quotedReminderId);
  }
  // 7d. v127: 「延後到 HH:MM」/「延到 15:00」/「這個延後到 15:00」— 改 Notion 時間
  m = t.match(/^.{0,10}(?:延後|延)到\s*(\d{1,2}:\d{2})$/);
  if (m && !isBatchPhrasing) {
    const targetMin = parseTimeMin(m[1]);
    if (targetMin === null) return { matched: true, reply: '時間格式錯,請用 HH:MM 例:「延後到 15:00」' };
    return await handlePostponeUntilCommand(env, userId, targetMin, quotedReminderId);
  }

  // 8. 跳過(可帶原因)
  // v170: 加 isBatchPhrasing 守門 — 「跳過全部 / 今天剩下都跳過」不可走單筆
  m = t.match(/^(?:跳過|不做|不去)\s*(#?\d+|\d{1,2}:\d{2}|.+?)(?:\s+(.+))?$/);
  if (m && (m[1] || m[2]) && !isBatchPhrasing) {
    return await handleSkipCommand(env, userId, m[1], m[2], quotedReminderId);
  }

  // 9. 已完成(自動勾 Notion + 標 reminder resolved)
  // v122: 「了」吃進 alternates,避免「完成了」誤 capture「了」當 spec
  // v131: 加「已經」「結束了」「弄完」「都好了」等變體 — user 報「已經完成」沒匹配
  // v170: 加 isBatchPhrasing 守門 — 「做完了全部 / 已經完成所有事」不可走單筆
  m = t.match(/^(?:已經?完成了?|已?完成了?|做完了?|已做完了?|已經?做完了?|搞定了?|打勾了?|弄好了?|弄完了?|結束了?|都好了?|ok\s*了?|處理好了?|處理完了?)\s*(#?\d+|\d{1,2}:\d{2}|.+?)?$/);
  if (m && !isBatchPhrasing) {
    return await handleCompleteCommand(env, userId, m[1], quotedReminderId);
  }

  // 10. 取消提醒(找對應事項,移除 🔔 + 從 reminders 拿掉)
  // v170: 加 isBatchPhrasing 守門 — 「取消提醒今天全部 / 全部取消提醒」不可走單筆
  m = t.match(/^(?:取消提醒|不要提醒|關掉提醒|移除提醒)\s*(#?\d+|\d{1,2}:\d{2}|.+?)?$/);
  if (m && m[1] && !isBatchPhrasing) {
    return await handleCancelReminderCommand(env, userId, m[1]);
  }

  // 10.5 設提醒 N N N(用早安推播的編號)
  // 變體:「設提醒 2 3」「2 3 設提醒」「加提醒 2 3」
  m = t.match(/^(?:設提醒|設定提醒|加提醒|新增提醒)\s+(.+)$/);
  if (m) {
    return await handleSetReminderByNumberCommand(env, userId, m[1]);
  }
  // 數字在前格式:「2 3 設提醒」「18 設提醒」
  m = t.match(/^([\d\s,，、#]+?)\s*(?:設提醒|設定提醒|加提醒)$/);
  if (m) {
    return await handleSetReminderByNumberCommand(env, userId, m[1]);
  }

  // 10.6 延長 X(in_progress 狀態下延長 check 時間)
  m = t.match(/^延長\s*(\d+)\s*(小時|分鐘|分|hr|h|min)$/i);
  if (m) {
    const value = parseInt(m[1]);
    const unit = m[2];
    const minutes = unit.startsWith('小時') || unit.startsWith('h') ? value * 60 : value;
    return await handleExtendCheckCommand(env, userId, minutes);
  }
  m = t.match(/^延長到\s*(\d{1,2}:\d{2})$/);
  if (m) {
    const targetMin = parseTimeMin(m[1]);
    if (targetMin === null) return { matched: true, reply: '時間格式錯,請用 HH:MM 例:「延長到 17:00」' };
    return await handleExtendCheckUntilCommand(env, userId, targetMin);
  }

  // 11. 設定 — 列目前所有偏好
  if (/^(設定|我的設定|偏好|偏好設定|settings|preferences)$/i.test(t)) {
    const p = await getPreferences(env, userId);
    return {
      matched: true,
      reply: [
        '⚙️ 你目前的偏好設定',
        '━━━━━━━━━━━━',
        `早安推播:${p.morningBriefEnabled ? '✓ 開' : '✗ 關'}(${p.morningBriefHHMM})`,
        `晚間總結:${p.eveningSummaryEnabled ? '✓ 開' : '✗ 關'}(${p.eveningSummaryHHMM})`,
        `拖延偵測:${p.procrastinationDetectionEnabled ? '✓ 開' : '✗ 關'}`,
        `卡住告知:${p.stuckAlertEnabled ? '✓ 開' : '✗ 關'}`,
        '━━━━━━━━━━━━',
        '改設定(可語音):',
        '• 「早安時間 7:30」',
        '• 「晚安時間 22:00」',
        '• 「關早安推播」/「打開早安推播」',
        '• 「關晚間總結」/「打開晚間總結」',
        '• 「關拖延偵測」/「打開拖延偵測」',
      ].join('\n'),
    };
  }

  // 12. 早安時間
  m = t.match(/^(?:早安|早安推播|morning|早報)\s*時間\s*(\d{1,2}:\d{2})$/);
  if (m) {
    const p = await setPreferences(env, userId, { morningBriefHHMM: m[1], morningBriefEnabled: true });
    return { matched: true, reply: `✓ 早安推播改為每天 ${p.morningBriefHHMM}\n(自動開啟若原本關著)` };
  }

  // 13. 晚安時間
  m = t.match(/^(?:晚安|晚安總結|晚間總結|evening)\s*時間\s*(\d{1,2}:\d{2})$/);
  if (m) {
    const p = await setPreferences(env, userId, { eveningSummaryHHMM: m[1], eveningSummaryEnabled: true });
    return { matched: true, reply: `✓ 晚間總結改為每天 ${p.eveningSummaryHHMM}\n(自動開啟若原本關著)` };
  }

  // 14. 開關早安 / 晚安 / 拖延 / 卡住
  m = t.match(/^(關|打開|開)\s*(早安推播|早安|晚安總結|晚安|晚間總結|拖延偵測|拖延|卡住告知|卡住)$/);
  if (m) {
    const verb = m[1];
    const target = m[2];
    const enable = verb === '打開' || verb === '開';
    const patch: Partial<UserPreferences> = {};
    let label = '';
    if (target.includes('早安')) {
      patch.morningBriefEnabled = enable;
      label = '早安推播';
    } else if (target.includes('晚')) {
      patch.eveningSummaryEnabled = enable;
      label = '晚間總結';
    } else if (target.includes('拖延')) {
      patch.procrastinationDetectionEnabled = enable;
      label = '拖延偵測';
    } else if (target.includes('卡住')) {
      patch.stuckAlertEnabled = enable;
      label = '卡住告知';
    }
    await setPreferences(env, userId, patch);
    return { matched: true, reply: `✓ ${label} 已${enable ? '開啟' : '關閉'}` };
  }

  return { matched: false };
}

type UserPreferences = import('../preferences/store').UserPreferences;

// ============================================================
// v214:「X點打給我,提醒我要XXX」解析 + 建立 callAction reminder
// ============================================================

// v215 調整③: 把中文數字字串(零一二三四五六七八九十十一十二…)轉成阿拉伯數字。
//   支援 0~59 的常見口語寫法:
//     - 個位:一~九 → 1~9
//     - 十、十一、十二…十九 → 10~19
//     - 二十、二十一…五十九 → 20~59(用於「N分」如「二十分」)
//     - 兩 → 2(「兩點」)
//   解析不出 → null。純工具,不影響既有阿拉伯數字路徑。
function cnNumToInt(s: string): number | null {
  if (!s) return null;
  const digit: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  // 純阿拉伯(防呆,理論上呼叫端已先試阿拉伯)
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s in digit) return digit[s];
  // 含「十」的兩位數:十 / 十X / X十 / X十Y
  const tenIdx = s.indexOf('十');
  if (tenIdx !== -1) {
    const before = s.slice(0, tenIdx);
    const after = s.slice(tenIdx + 1);
    const tens = before === '' ? 1 : (before in digit ? digit[before] : null);
    const ones = after === '' ? 0 : (after in digit ? digit[after] : null);
    if (tens === null || ones === null) return null;
    return tens * 10 + ones;
  }
  return null;
}

// 從一段文字抽時間(分鐘數)。支援:
//   - HH:MM(9:30 / 09:30)— 走既有 parseTimeMin
//   - 「N點」「N點半」「N點30(分)」+ 上午/下午/早上/中午/晚上/傍晚 修飾(阿拉伯數字)
//   - v215 調整③: 中文數字「九點」「十點半」「十二點」「下午三點」「晚上九點」「凌晨一點」「N點二十分」
// 找不到 → null。中文路徑與既有阿拉伯路徑並存,阿拉伯先試,不破壞既有行為。
function extractTimeMinLoose(text: string): { timeMin: number; matchEnd: number } | null {
  // 先試 HH:MM
  const mc = text.match(/(\d{1,2}):(\d{2})/);
  if (mc) {
    const h = parseInt(mc[1], 10);
    const mm = parseInt(mc[2], 10);
    if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) {
      return { timeMin: h * 60 + mm, matchEnd: (mc.index ?? 0) + mc[0].length };
    }
  }
  // 「(上午/下午/...)N點(半 / NN分 / NN)」— 阿拉伯數字
  const m = text.match(/(上午|下午|早上|中午|晚上|傍晚|凌晨|清晨)?\s*(\d{1,2})\s*點\s*(半|[0-5]?\d)?\s*分?/);
  if (m) {
    let h = parseInt(m[2], 10);
    let mm = 0;
    if (m[3] === '半') mm = 30;
    else if (m[3]) mm = parseInt(m[3], 10);
    const period = m[1];
    // 下午/晚上/傍晚 → +12(若 h < 12);中午 12 點維持
    if ((period === '下午' || period === '晚上' || period === '傍晚') && h < 12) h += 12;
    if (period === '凌晨' && h === 12) h = 0;
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
    return { timeMin: h * 60 + mm, matchEnd: (m.index ?? 0) + m[0].length };
  }
  // v215 調整③:「(上午/下午/...)中文數字點(半 / 中文數字分)」— 中文數字
  //   時:十/十一/十二/一~九/兩(後面接「點」);分:半 或 中文數字 + 分。
  const mz = text.match(/(上午|下午|早上|中午|晚上|傍晚|凌晨|清晨)?\s*([零一二兩三四五六七八九十]{1,3})\s*點\s*(半|[零一二兩三四五六七八九十]{1,3}\s*分)?/);
  if (mz) {
    const h0 = cnNumToInt(mz[2]);
    if (h0 === null) return null;
    let h = h0;
    let mm = 0;
    if (mz[3]) {
      if (mz[3].includes('半')) mm = 30;
      else {
        const mmRaw = mz[3].replace(/\s*分/, '').trim();
        const mmVal = cnNumToInt(mmRaw);
        if (mmVal === null) return null;
        mm = mmVal;
      }
    }
    const period = mz[1];
    if ((period === '下午' || period === '晚上' || period === '傍晚') && h < 12) h += 12;
    if (period === '凌晨' && h === 12) h = 0;
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
    return { timeMin: h * 60 + mm, matchEnd: (mz.index ?? 0) + mz[0].length };
  }
  return null;
}

// v216: 抽「相對時間」(「N分鐘後 / 半小時後 / N小時後 / 一個半小時後」)。回 { timeMin, matchEnd } 或 null。
//   timeMin = (nowMin + offset) 對 1440 取模 → 跨午夜自動接到隔天的對應時刻(罕見,不報錯)。
//   必須帶相對指示詞「後 / 之後 / 過後 / 以後」才算(避免把「3點」這種絕對時間誤判成相對)。
function extractRelativeTimeMin(text: string, nowMin: number): { timeMin: number; matchEnd: number } | null {
  if (!/(後|之後|過後|以後)/.test(text)) return null;
  let offset = 0;
  let matchEnd = 0;

  // 小時部分:「N小時 / N個小時 / N鐘頭 / 半小時 / N個半小時」(N 阿拉伯或中文,可含「半」)
  const hr = text.match(/([\d零一二兩三四五六七八九十]+)?\s*個?\s*(半)?\s*(?:小時|鐘頭)/);
  if (hr) {
    const nRaw = hr[1];
    const n = nRaw ? (/^\d+$/.test(nRaw) ? parseInt(nRaw, 10) : cnNumToInt(nRaw)) : null;
    let hours = n ?? 0;
    if (hr[2]) hours += 0.5; // 「半」
    if (hours > 0) {
      offset += Math.round(hours * 60);
      matchEnd = Math.max(matchEnd, (hr.index ?? 0) + hr[0].length);
    }
  }

  // 分部分:「N分鐘 / N分」(N 阿拉伯或中文)
  const mn = text.match(/([\d零一二兩三四五六七八九十]+)\s*分鐘?/);
  if (mn) {
    const nRaw = mn[1];
    const n = /^\d+$/.test(nRaw) ? parseInt(nRaw, 10) : cnNumToInt(nRaw);
    if (n !== null && n > 0) {
      offset += n;
      matchEnd = Math.max(matchEnd, (mn.index ?? 0) + mn[0].length);
    }
  }

  if (offset <= 0) return null;
  const timeMin = (((nowMin + offset) % 1440) + 1440) % 1440;
  return { timeMin, matchEnd };
}

// 解析「X點打給我提醒我要XXX」。回 { timeMin, content } 或 null
function parseCallReminderCommand(t: string, nowMin: number): { timeMin: number; content: string; queryPlan?: 'today' | 'tomorrow' } | null {
  // 必含「打給我 / 打電話(給我)」這個語意
  const callKw = t.match(/打(?:電話)?給我|打電話/);
  if (!callKw) return null;
  // 必含時間:先試相對時間(「N分鐘後 / 半小時後」),再試絕對時間(「9點 / 9:30」)
  const tm = extractRelativeTimeMin(t, nowMin) ?? extractTimeMinLoose(t);
  if (!tm) return null;

  // 內容 = 「打給我/打電話」之後那段;去掉引導詞「提醒我(要)/叫我/記得/跟我說/要我」
  const callIdx = (callKw.index ?? 0) + callKw[0].length;
  let content = t.slice(callIdx);
  content = content
    .replace(/^[\s,，、:：]+/, '')
    .replace(/^(提醒我要|提醒我|叫我要|叫我|記得要|記得|跟我說要|跟我說|要我|請我)/, '')
    .replace(/^[\s,，、:：]+/, '')
    .trim();
  // v215 reviewer #5: strip 掉 content 裡殘留的「時間描述」,避免 TTS 念重複時間。
  //   例「打給我9點開會」→ slice 後 content = "9點開會",時間已在 timeMin 表達,念稿只要留「開會」。
  //   同時 cover 尾部殘留(「打給我開會9點」→「開會」)。中英時間格式都剝:
  //     HH:MM / (上午/下午…)N點(半/N分) / (上午/下午…)中文數字點(半/中文數字分)。
  const timePatterns = [
    // v216: 相對時間(「N分鐘後 / 半小時後 / N小時後」)— 念稿不需要,先剝掉
    /([\d零一二兩三四五六七八九十]+\s*個?\s*半?\s*(?:小時|鐘頭)|半\s*個?\s*(?:小時|鐘頭)|[\d零一二兩三四五六七八九十]+\s*分鐘?)\s*(?:後|之後|過後|以後)/g,
    /(上午|下午|早上|中午|晚上|傍晚|凌晨|清晨)?\s*\d{1,2}:\d{2}/g,
    /(上午|下午|早上|中午|晚上|傍晚|凌晨|清晨)?\s*\d{1,2}\s*點\s*(半|[0-5]?\d\s*分?)?/g,
    /(上午|下午|早上|中午|晚上|傍晚|凌晨|清晨)?\s*[零一二兩三四五六七八九十]{1,3}\s*點\s*(半|[零一二兩三四五六七八九十]{1,3}\s*分)?/g,
  ];
  for (const p of timePatterns) content = content.replace(p, ' ');
  content = content.replace(/^[\s,，、:：]+/, '').replace(/[\s,，、:：]+$/, '').replace(/\s{2,}/g, ' ').trim();
  if (!content) return null;
  if (content.length > 60) return null; // 太長 → 不像單純提醒事項,讓 Claude 處理
  // v219: 偵測「查詢型」— 要 bot 報今天/明天工作計畫,到點改讀 Notion 念內容(而非字面複述問句)。
  //   與 Notion 📞 共用 detectQueryPlan(避免兩套偵測 drift)。
  const queryPlan = detectQueryPlan(content);
  return { timeMin: tm.timeMin, content, queryPlan };
}

async function handleSetCallReminder(
  env: Env,
  userId: string,
  timeMin: number,
  content: string,
  queryPlan?: 'today' | 'tomorrow'
): Promise<CommandResult> {
  const reminders = await loadReminders(env, userId);
  const hhmm = formatTime(timeMin);
  const r: Reminder = {
    id: crypto.randomUUID(),
    blockId: '', // 非 Notion 來源,沒有 block
    text: `${hhmm} ${content}`,
    startTimeMin: timeMin,
    enabled: true,
    source: 'line',
    state: 'pending',
    callAction: true, // 到點打電話念內容
    queryPlan, // v219: 查詢型 → 到點讀 Notion 計畫念,而非字面複述
  };
  reminders.push(r);
  await saveReminders(env, userId, reminders);

  const twilioReady = isTwilioConfigured(env) && !!env.USER_PHONE_NUMBER;
  const planLabel = queryPlan === 'tomorrow' ? '明天的工作計畫' : queryPlan === 'today' ? '今天的工作計畫' : null;
  let note: string;
  if (!twilioReady) {
    note = '⚠️ 電話功能還沒設定好,到時間會改用 LINE 訊息提醒你(設好 Twilio 後就會真的打電話)';
  } else if (planLabel) {
    note = `到時間我會打電話「讀${planLabel}報給你聽」☎️`;
  } else {
    note = '到時間我會打電話念給你聽 ☎️';
  }
  return {
    matched: true,
    reminderId: r.id,
    reply: `✓ 已設定 ${hhmm} 打電話提醒:「${content}」\n${note}`,
  };
}

// ============================================================
// 延長 check(in_progress 後使用者要更長時間)
// ============================================================
// v121: 改成找 state=started 的 reminder(v119 後新流程)
//        把它從 started → second_sent + lastFollowupAt 推遲 N 分鐘
//        → cron N 分鐘後會 resume check + 開始追殺
async function handleExtendCheckCommand(
  env: Env,
  userId: string,
  minutes: number
): Promise<CommandResult> {
  const reminders = await loadReminders(env, userId);
  const target = reminders
    .filter((r) => r.enabled && r.state === 'started')
    .sort((a, b) => {
      const at = new Date(a.startedAt ?? 0).getTime();
      const bt = new Date(b.startedAt ?? 0).getTime();
      return bt - at;
    })[0];
  if (!target) {
    return {
      matched: true,
      reply: '目前沒有「正在做」狀態的提醒可以延長。\n若要延後一般提醒時間,用「延後 14:00 30 分」(會改 Notion 時間)',
    };
  }
  target.state = 'second_sent';
  target.startedAt = undefined; // v218(B1): 清 startedAt,否則 cron 678 永久 skip,延長後追殺不 resume
  target.lastFollowupAt = new Date(Date.now() + (minutes - 1) * 60 * 1000).toISOString();
  await saveReminders(env, userId, reminders);
  const clean = target.text.replace(/🔔/g, '').trim();
  return {
    matched: true,
    reminderId: target.id,
    reply: `✓ 已延長「${clean}」休止期 ${minutes} 分鐘\n${minutes} 分鐘後我會 check Notion,沒勾就再催`,
  };
}

async function handleExtendCheckUntilCommand(
  env: Env,
  userId: string,
  targetMin: number
): Promise<CommandResult> {
  const reminders = await loadReminders(env, userId);
  const target = reminders
    .filter((r) => r.enabled && r.state === 'started')
    .sort((a, b) => {
      const at = new Date(a.startedAt ?? 0).getTime();
      const bt = new Date(b.startedAt ?? 0).getTime();
      return bt - at;
    })[0];
  if (!target) {
    return { matched: true, reply: '目前沒有「正在做」狀態的提醒可以延長' };
  }
  const nowMin = nowHHMMToMinDirect(new Date());
  const checkInMinutes = targetMin - nowMin;
  if (checkInMinutes <= 0) {
    return { matched: true, reply: `${formatTime(targetMin)} 已經過了,請給未來時間` };
  }
  target.state = 'second_sent';
  target.startedAt = undefined; // v218(B1): 清 startedAt,否則 cron 678 永久 skip,延長後追殺不 resume
  target.lastFollowupAt = new Date(Date.now() + (checkInMinutes - 1) * 60 * 1000).toISOString();
  await saveReminders(env, userId, reminders);
  const clean = target.text.replace(/🔔/g, '').trim();
  return {
    matched: true,
    reminderId: target.id,
    reply: `✓ 已延長「${clean}」休止期到 ${formatTime(targetMin)},屆時會 check`,
  };
}

function nowHHMMToMin(env: Env): number {
  const tpe = new Intl.DateTimeFormat('en-GB', {
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
  const [h, m] = tpe.split(':').map((x) => parseInt(x));
  return h * 60 + m;
}

function nowHHMMToMinDirect(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

// ============================================================
// 設提醒(用早安推播的編號 #N #N #N)
// ============================================================
async function handleSetReminderByNumberCommand(
  env: Env,
  userId: string,
  arg: string
): Promise<CommandResult> {
  if (!env.CACHE) return { matched: true, reply: 'KV 不可用' };

  // 解析數字(支援空格 / 逗號 / 頓號 / # 開頭)
  const nums = arg
    .split(/[\s,，、]+/)
    .map((s) => s.replace(/^#/, '').trim())
    .filter((s) => /^\d+$/.test(s))
    .map((s) => parseInt(s));

  if (nums.length === 0) {
    return {
      matched: true,
      reply: '請給編號,例:「設提醒 2 3 5」(早安推播會列編號)\n或直接 Notion 加 🔔 也行',
    };
  }

  // 從 KV 撈今早 morning-index
  const todayKey = new Date().toISOString().substring(0, 10);
  const indexRaw = await env.CACHE.get(`morning-index:${userId}:${todayKey}`);
  if (!indexRaw) {
    return {
      matched: true,
      reply: '今天還沒收到早安推播,沒有編號可用。\n建議直接 Notion 事項前加 🔔。',
    };
  }
  const index: Array<{ n: number; blockId: string; text: string; hasReminder: boolean }> = JSON.parse(indexRaw);

  const results: string[] = [];
  let okCount = 0;
  let alreadyCount = 0;
  let failCount = 0;
  for (const n of nums) {
    const item = index.find((x) => x.n === n);
    if (!item) {
      results.push(`#${n}: 找不到對應事項`);
      failCount++;
      continue;
    }
    if (item.hasReminder) {
      results.push(`#${n}: 已有 🔔`);
      alreadyCount++;
      continue;
    }
    const ok = await prependBell(env, item.blockId, item.text);
    if (ok) {
      results.push(`#${n}: ✓ 已加 🔔 「${item.text.substring(0, 25)}」`);
      okCount++;
    } else {
      results.push(`#${n}: ✗ 加 🔔 失敗`);
      failCount++;
    }
  }

  return {
    matched: true,
    reply: [
      `設提醒結果:${okCount} 成功 / ${alreadyCount} 已有 / ${failCount} 失敗`,
      '━━━━━━━━━━━━',
      ...results,
      '━━━━━━━━━━━━',
      '下次 cron 會自動掃 🔔 開始追蹤',
    ].join('\n'),
  };
}

// 在 Notion block 文字前加 🔔
async function prependBell(env: Env, blockId: string, currentText: string): Promise<boolean> {
  try {
    const getRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    });
    if (!getRes.ok) return false;
    const block: any = await getRes.json();
    const type = block.type;
    const richText = block[type]?.rich_text ?? [];
    const existing = richText.map((t: any) => t.plain_text).join('');
    if (existing.includes('🔔')) return true; // 已有
    const newText = `🔔 ${existing}`;
    const payload: any = { [type]: {} };
    payload[type].rich_text = [{ type: 'text', text: { content: newText } }];
    if (type === 'to_do') payload.to_do.checked = block.to_do?.checked ?? false;
    const patchRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify(payload),
    });
    return patchRes.ok;
  } catch {
    return false;
  }
}

// ============================================================
// 追殺中的反應判斷 — Claude(Haiku)判斷使用者回應敷衍與否
// ============================================================

export async function checkFollowupResponse(
  env: Env,
  userId: string,
  userMessage: string,
  quotedReminderId?: string | null
): Promise<CommandResult> {
  const reminders = await loadReminders(env, userId);

  // 優先用 quote 反查
  let r: Reminder | undefined;
  if (quotedReminderId) {
    r = reminders.find((x) => x.id === quotedReminderId && x.enabled && x.state !== 'resolved');
  }
  if (!r) {
    // v218(E3): 沒 quote → 選「最近被推給 user」的那筆(user 通常回應剛收到的追殺),
    //   跟 handleCompleteCommand 的 findReminder 策略一致。原本用「最舊」在多筆同時追殺時會標錯筆 → 原筆繼續追。
    const active = reminders.filter(
      (x) => x.enabled && (x.state === 'second_sent' || x.state === 'awaiting_reason')
    );
    if (active.length === 0) return { matched: false };
    const recentPush = (x: Reminder): number => {
      const stamps = [x.secondSentAt, x.lastFollowupAt, x.firstSentAt]
        .filter((s): s is string => Boolean(s))
        .map((s) => new Date(s).getTime());
      return stamps.length ? Math.max(...stamps) : 0;
    };
    active.sort((a, b) => recentPush(b) - recentPush(a));
    r = active[0];
  }

  // 用 Haiku 判斷(5 種 verdict)
  const cleanText = r.text.replace(/🔔/g, '').trim();
  const judgePrompt = [
    '你是判斷器,只輸出單一字串:done / in_progress / skipped / evasive / unrelated',
    '',
    `背景:使用者被追殺提醒「${cleanText}」`,
    `使用者剛回應:「${userMessage}」`,
    '',
    '判斷類別:',
    '- done:明確表示「已完成 / 已搞定 / OK 了 / 做完了 / 弄好了」',
    '  例:「完成」「做完了」「OK 了」「搞定」「處理好了」',
    '- in_progress:正在做但還沒完成',
    '  例:「在做了」「處理中」「快好了」「等下就做」',
    '- skipped:跳過 / 不做 / 改時間,且有說原因',
    '  例:「卡住了,改明天」「不舒服跳過」「行程取消」「忘了現在做不了」',
    '- evasive:敷衍應付(空格/單字無意義/重複符號/明顯逃避)',
    '  例:「.」「ok」「嗯」「.....」「好啦」「知道了」(光單字不解釋)',
    '  注意:「OK 了」≠ 「ok」,「OK 了」是 done',
    '- unrelated:跟此提醒無關(在問別的事 / 純閒聊)',
    '  例:「今天天氣?」「你會做菜嗎」',
    '',
    '判斷別太嚴格 — 有具體內容就別當 evasive。',
    '只回單一字:done / in_progress / skipped / evasive / unrelated',
  ].join('\n');

  let verdict = 'unrelated';
  try {
    const r2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 20,
        messages: [{ role: 'user', content: judgePrompt }],
      }),
    });
    if (r2.ok) {
      const d: any = await r2.json();
      const text = (d.content?.[0]?.text ?? '').toLowerCase().trim();
      if (text.includes('done')) verdict = 'done';
      else if (text.includes('in_progress')) verdict = 'in_progress';
      else if (text.includes('skipped')) verdict = 'skipped';
      else if (text.includes('evasive')) verdict = 'evasive';
      else if (text.includes('unrelated')) verdict = 'unrelated';
      // v118: 補 logCost
      try {
        const usage = d.usage || {};
        const inTok = usage.input_tokens ?? 0;
        const outTok = usage.output_tokens ?? 0;
        const cachedTok = usage.cache_read_input_tokens ?? 0;
        const writeTok = usage.cache_creation_input_tokens ?? 0;
        const cost = calculateClaudeCost('claude-haiku-4-5', inTok, outTok, cachedTok, writeTok);
        await logCost(env, {
          userId, service: 'anthropic', operation: 'reminder-verdict',
          model: 'claude-haiku-4-5',
          inputTokens: inTok, outputTokens: outTok, cachedTokens: cachedTok, costUsd: cost,
          taskContext: 'reminder-verdict',
        });
      } catch (e) { console.warn('[judge] logCost failed', e); }
    }
  } catch (e) {
    console.warn('[judge] Haiku failed:', e);
  }

  console.log(`[judge] reminder=${cleanText.substring(0, 20)} msg="${userMessage.substring(0, 30)}" verdict=${verdict}`);

  if (verdict === 'unrelated') {
    return { matched: false }; // 讓 Claude 主對話接手
  }

  if (verdict === 'evasive') {
    // 立刻追殺(無按鈕)
    r.followupCount = (r.followupCount ?? 0) + 1;
    r.totalPushCount = (r.totalPushCount ?? 0) + 1;
    r.lastFollowupAt = new Date().toISOString();
    await saveReminders(env, userId, reminders);
    return {
      matched: true,
      reminderId: r.id,
      doNotShowQuickReply: true,
      reply: [
        `⚠️ 「${userMessage}」這樣不算回答`,
        '━━━━━━━━━━━━',
        `事項:${cleanText}(原訂 ${formatTime(r.startTimeMin)})`,
        '',
        '請具體說明:你打算做嗎?還是改時間?還是放棄?為什麼?',
        '隨意打發我會繼續追殺,直到你誠實面對。',
        '',
        '(這是反拖延設計 — 你自己要的)',
      ].join('\n'),
    };
  }

  // 不同 verdict 處理:
  // done    → 標 resolved + 勾 Notion
  // skipped → 標 resolved + 記原因(不勾)
  // in_progress → **不標 resolved**,設 inProgressMarkedAt + 延後追殺 15 分鐘
  //              讓跨任務 check 啟動(15 分後再 check Notion 是否真的勾了)
  (r as any).resolvedResponse = userMessage;
  (r as any).resolvedVerdict = verdict;
  let notionMsg = '';
  let replyExtra = '';

  if (verdict === 'done') {
    r.state = 'resolved';
    r.resolvedAt = new Date().toISOString();
    r.resolvedReason = 'user_response';
    r.lastUserActionAt = new Date().toISOString(); // v217 修 A1:漏設這條 → cron 整包 save 把 resolved 蓋回 second_sent → 無限追殺
    const checkOk = await markNotionChecked(env, r.blockId);
    notionMsg = checkOk ? '\nNotion 上已自動打勾 ✓' : '\n(該 block 不是 to_do,Notion 沒勾)';
  } else if (verdict === 'skipped') {
    r.state = 'resolved';
    r.resolvedAt = new Date().toISOString();
    r.resolvedReason = 'user_response';
    r.lastUserActionAt = new Date().toISOString(); // v217 修 A1:同 done,補 race 防護(否則被 cron 蓋回繼續追)
  } else {
    // v119: in_progress 不再延長追殺,直接走 v110 state='started' 完全停追殺
    //       (舊 inProgressMarkedAt 邏輯有 cron race condition 會被覆蓋,改成 started 較穩)
    r.state = 'started';
    r.startedAt = new Date().toISOString();
    r.lastUserActionAt = new Date().toISOString(); // v211 修:這條漏設 → cron race 防護失效 → 追殺停不下來
    replyExtra = '\n追殺停了 — 做完打字「完成」或自己勾 Notion 都認';
  }

  await saveReminders(env, userId, reminders);

  const verdictLabel = verdict === 'done' ? '已完成' : verdict === 'in_progress' ? '在處理' : '跳過';
  return {
    matched: true,
    reminderId: r.id,
    reply: `✓ 收到「${cleanText}」(${verdictLabel}):「${userMessage}」${replyExtra}${notionMsg}`,
  };
}

// 勾 Notion to_do block(若是 to_do)
async function markNotionChecked(env: Env, blockId: string): Promise<boolean> {
  try {
    const getRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    });
    if (!getRes.ok) return false;
    const block: any = await getRes.json();
    if (block.type !== 'to_do') return false;
    const richText = block.to_do?.rich_text ?? [];
    const patchRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({ to_do: { rich_text: richText, checked: true } }),
    });
    return patchRes.ok;
  } catch {
    return false;
  }
}

// ============================================================
// 已完成 — 標 reminder resolved + 自動勾 Notion(若是 to_do)
// ============================================================
async function handleCompleteCommand(
  env: Env,
  userId: string,
  spec?: string,
  quotedReminderId?: string | null
): Promise<CommandResult> {
  const reminders = await loadReminders(env, userId);
  const r = findReminder(reminders, spec || '', quotedReminderId);
  if (!r) {
    // v122: 有明確 spec 但找不到 → 回錯誤訊息(user 講錯時間 14:00 之類)
    //       沒 spec 也找不到 → 不攔截,讓 Claude 接(用 history 看 bot 上一則推什麼,推理意圖)
    if (spec && spec.trim()) {
      return { matched: true, reply: '找不到對應事項。請說「已完成 14:00」或「完成 #2」' };
    }
    return { matched: false };
  }

  // 標 resolved
  r.state = 'resolved';
  r.lastUserActionAt = new Date().toISOString(); // v127
  r.resolvedAt = new Date().toISOString();
  r.resolvedReason = 'user_response';
  await saveReminders(env, userId, reminders);

  // 嘗試勾 Notion(只對 to_do 有效)
  const checkOk = await markNotionBlockChecked(env, r.blockId);
  const clean = r.text.replace(/🔔/g, '').trim();
  return {
    matched: true,
    reminderId: r.id,
    reply: checkOk
      ? `✓ 已完成「${clean}」,Notion 上已打勾`
      : `✓ 已記錄完成「${clean}」(該 block 不是 to_do,Notion 沒打勾,但提醒已關)`,
  };
}

async function markNotionBlockChecked(env: Env, blockId: string): Promise<boolean> {
  try {
    const getRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    });
    if (!getRes.ok) return false;
    const block: any = await getRes.json();
    if (block.type !== 'to_do') return false;
    const currentText = block.to_do?.rich_text ?? [];
    const patchRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({ to_do: { rich_text: currentText, checked: true } }),
    });
    return patchRes.ok;
  } catch (e) {
    console.warn('[complete] check Notion failed:', e);
    return false;
  }
}

// ============================================================
// 取消提醒 — 從 KV 移除 + 同步把 Notion 上的 🔔 拿掉
// ============================================================
async function handleCancelReminderCommand(
  env: Env,
  userId: string,
  spec: string,
  quotedReminderId?: string | null
): Promise<CommandResult> {
  const reminders = await loadReminders(env, userId);
  const r = findReminder(reminders, spec, quotedReminderId);
  if (!r) {
    return {
      matched: true,
      reply: '找不到對應提醒。請說「取消提醒 14:00」或「取消提醒 #2」',
    };
  }

  // 單向:只在 KV 標 disabled,不改 Notion
  // (常見工作流:每天會把當日工作複製到工作記錄歸檔,動 🔔 會破壞歸檔真實性)
  r.enabled = false;
  await saveReminders(env, userId, reminders);

  const clean = r.text.replace(/🔔/g, '').trim();
  return {
    matched: true,
    reply: `✓ 已停用今天「${clean}」的提醒\nNotion 上的 🔔 保留(歸檔用)\n明天若同樣事項出現,要在 LINE 重新「取消提醒」`,
  };
}

// ============================================================
// 提醒清單
// ============================================================
async function buildRemindersList(env: Env, userId: string): Promise<string> {
  const reminders = (await loadReminders(env, userId)).filter((r) => r.enabled);
  const silence = await getSilence(env, userId);

  const lines: string[] = ['📋 目前提醒設定', '━━━━━━━━━━━━'];

  if (reminders.length === 0) {
    lines.push('今日未設任何提醒');
    lines.push('');
    lines.push('要設提醒的方法:');
    lines.push('• Notion 事項前加「🔔」符號');
    lines.push('• 早安推播後回「設提醒 2 3」(編號)');
    lines.push('• 直接傳「設提醒 14:00 看牙醫」');
  } else {
    // 按時間排序,且去重(同 blockId 只顯示一次)
    // v214: LINE 來源的 callAction reminder 沒 blockId(空字串)→ 改用 id 去重,避免多筆電話提醒被誤併成一筆
    const seen = new Set<string>();
    const dedup = reminders.filter((r) => {
      const dedupKey = r.blockId || `id:${r.id}`;
      if (seen.has(dedupKey)) return false;
      seen.add(dedupKey);
      return true;
    });
    dedup.sort((a, b) => a.startTimeMin - b.startTimeMin);
    dedup.forEach((r) => {
      // v214: callAction(到點打電話)用 ☎️ 標,跟一般提醒區分
      const stateIcon = r.callAction ? '☎️' : r.state === 'resolved' ? '✓' : r.state === 'second_sent' ? '⏰' : r.state === 'first_sent' ? '🔔' : r.state === 'awaiting_reason' ? '🤔' : '•';
      // 去掉 🔔/📞 + 去掉開頭重複的時間字串(避免「17:58 17:58 吃晚餐」)
      let display = r.text.replace(/🔔/g, '').replace(/📞/g, '').trim();
      const startStr = formatTime(r.startTimeMin);
      if (display.startsWith(startStr)) {
        display = display.slice(startStr.length).trim();
      } else {
        // 也試短時間格式(去掉前置 0)
        const shortStart = startStr.replace(/^0/, '');
        if (display.startsWith(shortStart)) display = display.slice(shortStart.length).trim();
      }
      lines.push(`${stateIcon} ${startStr} ${display}`);
    });
  }

  lines.push('');
  if (silence) {
    if (silence.type === 'temp' && silence.endsAt) {
      const endsLocal = new Date(silence.endsAt).toLocaleTimeString('zh-TW', {
        timeZone: env.TIMEZONE || 'Asia/Taipei',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      lines.push(`🔇 靜音中(${endsLocal} 結束)`);
    } else if (silence.type === 'recurring') {
      lines.push(`🔇 每天 ${silence.startHHMM}~${silence.endHHMM} 不打擾`);
    }
  } else {
    lines.push('🔔 提醒功能正常運作');
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━');
  lines.push('指令(可用語音):');
  lines.push('• 「靜音 2 小時」← 暫時');
  lines.push('• 「靜音 23:00~7:30」← 每天固定');
  lines.push('• 「取消靜音」');
  lines.push('• 「已開始 14:00」/「延後 14:00 15 分」/「跳過 14:00 原因」');

  return lines.join('\n');
}

// ============================================================
// 找對應的 reminder(支援編號 / 時間 / 文字)
// ============================================================
function findReminder(reminders: Reminder[], spec: string, quotedReminderId?: string | null): Reminder | null {
  // 優先用 LINE quote 反查的 reminderId
  if (quotedReminderId) {
    const r = reminders.find((x) => x.id === quotedReminderId);
    if (r && r.state !== 'resolved') return r;
  }
  if (!spec) {
    // v122: 沒指定 → 找「最近被推過提醒」的 reminder(通常是 user 剛收到的那則)
    //       不再用「最舊 active」 — 那個策略在多筆同時 active 時會找錯
    const candidates = reminders
      .filter((r) => r.state !== 'resolved' && r.enabled)
      .map((r) => {
        const stamps = [r.firstSentAt, r.startNotifiedAt, r.secondSentAt, r.lastFollowupAt, r.startedAt]
          .filter(Boolean)
          .map((s) => new Date(s!).getTime());
        const recentPush = stamps.length > 0 ? Math.max(...stamps) : 0;
        return { r, recentPush };
      })
      .sort((a, b) => b.recentPush - a.recentPush);
    return candidates[0]?.r || null;
  }
  // 編號 #2 / 2
  const numMatch = spec.match(/^#?(\d+)$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1]) - 1;
    const sorted = [...reminders].sort((a, b) => a.startTimeMin - b.startTimeMin);
    return sorted[idx] || null;
  }
  // 時間 14:00
  const tMin = parseTimeMin(spec);
  if (tMin !== null) {
    return reminders.find((r) => r.startTimeMin === tMin) || null;
  }
  // 文字模糊比對
  return reminders.find((r) => r.text.includes(spec)) || null;
}

// ============================================================
// 已開始 — v110: state=started(不是 resolved),停止追殺,等使用者自己回「完成」或修 Notion
// ============================================================
async function handleStartedCommand(
  env: Env,
  userId: string,
  spec?: string,
  quotedReminderId?: string | null
): Promise<CommandResult> {
  const reminders = await loadReminders(env, userId);
  const r = findReminder(reminders, spec || '', quotedReminderId);
  if (!r) {
    // v122: 有 spec 找不到 → 錯誤訊息;沒 spec 找不到 → 不攔截,讓 Claude 接
    if (spec && spec.trim()) {
      return { matched: true, reply: '找不到對應提醒。請說「已開始 14:00」(時間) 或「已開始 #2」(編號)' };
    }
    return { matched: false };
  }
  r.state = 'started';
  r.lastUserActionAt = new Date().toISOString(); // v127
  r.startedAt = new Date().toISOString();
  await saveReminders(env, userId, reminders);
  const clean = r.text.replace(/🔔/g, '').trim();
  return {
    matched: true,
    reminderId: r.id,
    reply: `▶ 已標記「${clean}」開始進行中\n追殺停了 — 做完打字「完成」或勾 Notion 都認`,
  };
}

// v110: 給 LINE postback「▶ 開始做了」按鈕用 — 直接吃 reminderId,不用解析口語
export async function markReminderStarted(
  env: Env,
  userId: string,
  reminderId: string
): Promise<{ ok: boolean; reply: string }> {
  const reminders = await loadReminders(env, userId);
  const r = reminders.find((x) => x.id === reminderId);
  if (!r) {
    return { ok: false, reply: '找不到這筆提醒(可能已過期或被刪除)' };
  }
  if (r.state === 'started') {
    return { ok: true, reply: '已標記在進行中,不會再追殺(做完打字「完成」)' };
  }
  if (r.state === 'resolved') {
    return { ok: true, reply: '這筆已完成,不用再標記' };
  }
  r.state = 'started';
  r.startedAt = new Date().toISOString();
  r.lastUserActionAt = new Date().toISOString(); // v127: KV race 防護,cron 60s 內跳過
  await saveReminders(env, userId, reminders);
  const clean = r.text.replace(/🔔/g, '').trim();
  return {
    ok: true,
    reply: `▶ 已標記「${clean}」開始進行中\n追殺停了 — 做完打字「完成」或勾 Notion 都認`,
  };
}

// v127: 延後到 HH:MM(設新時間,不是「加幾分」)— reuse handlePostponeCommand 算 minutes 差
async function handlePostponeUntilCommand(
  env: Env,
  userId: string,
  targetMin: number,
  quotedReminderId?: string | null
): Promise<CommandResult> {
  const reminders = await loadReminders(env, userId);
  const r = findReminder(reminders, '', quotedReminderId);
  if (!r) {
    return { matched: true, reply: '找不到對應提醒。例:「延後到 15:00」會延後最近推過那筆' };
  }
  const minutes = targetMin - r.startTimeMin;
  if (minutes <= 0) {
    return {
      matched: true,
      reply: `${formatTime(targetMin)} 比原時間 ${formatTime(r.startTimeMin)} 早,請給未來時間`,
    };
  }
  return await handlePostponeCommand(env, userId, '', minutes, quotedReminderId);
}

// ============================================================
// 延後 M 分鐘 — 同時改 Notion 上的時間
// ============================================================
// v171: server-side 批次延後 — 不靠 Claude,直接從 KV reminders 建 propose_batch_action
//        原本 Claude 路徑常因 Anthropic timeout / Worker 30s 上限 / 多 tool call 漏球 silent fail
async function handleBatchPostpone(
  env: Env,
  userId: string,
  offsetMin: number,
  cutoffMin: number | null
): Promise<CommandResult> {
  const reminders = await loadReminders(env, userId);
  // 篩選未完成 + 啟用 + 有 blockId(Notion 來源) + text 含時間
  let active = reminders.filter(
    (r) =>
      r.enabled !== false &&
      r.state !== 'resolved' &&
      r.blockId &&
      r.blockId.length > 0 &&
      /\d{1,2}:\d{2}/.test(r.text)
  );
  if (cutoffMin !== null) {
    active = active.filter((r) => r.startTimeMin >= cutoffMin);
  }
  if (active.length === 0) {
    return {
      matched: true,
      reply: cutoffMin !== null
        ? `${formatTime(cutoffMin)} 後沒有未完成的提醒可以延後`
        : '今天沒有未完成的提醒可以延後',
    };
  }

  // 建 actions(每筆都 op=update,把 text 內第一個 HH:MM 換成新時間)
  const actions = active.map((r) => {
    const newMin = (r.startTimeMin + offsetMin) % (24 * 60);
    const newHHMM = formatTime(newMin);
    const oldHHMM = formatTime(r.startTimeMin);
    // 同時嘗試 HH:MM 跟 H:MM 兩種格式(對齊 handlePostponeCommand 的 fuzzy replace)
    const oldNoPad = oldHHMM.replace(/^0/, '');
    const newNoPad = newHHMM.replace(/^0/, '');
    let newText = r.text.replace(oldHHMM, newHHMM);
    if (newText === r.text) newText = r.text.replace(oldNoPad, newNoPad);
    return {
      op: 'update' as const,
      block_id: r.blockId,
      old_text: r.text,
      new_text: newText,
    };
  });

  const cutoffDesc = cutoffMin !== null ? `${formatTime(cutoffMin)} 後` : '今天剩餘';
  const summary = `${cutoffDesc} ${active.length} 筆延後 ${offsetMin} 分鐘`;

  // proposeBatchAction 內部會 KV 暫存 + 直接 push LINE 訊息(含 ✓ 確認 / ✗ 取消 按鈕)
  await proposeBatchAction(env, userId, summary, actions);

  // 已 push,告訴 caller 別再 reply(避免重複)
  return { matched: true, skipReply: true };
}

async function handlePostponeCommand(
  env: Env,
  userId: string,
  spec: string,
  minutes: number,
  quotedReminderId?: string | null
): Promise<CommandResult> {
  const reminders = await loadReminders(env, userId);
  const r = findReminder(reminders, spec, quotedReminderId);
  if (!r) {
    return {
      matched: true,
      reply: `找不到對應提醒。例:「延後 14:00 15 分」`,
    };
  }
  const newTimeMin = r.startTimeMin + minutes;
  const oldHHMM = formatTime(r.startTimeMin);
  const newHHMM = formatTime(newTimeMin);

  // v130: 改 Notion text — fuzzy replace 同時嘗試 HH:MM (08:20) 跟 H:MM (8:20) 兩種格式
  const oldNoPad = oldHHMM.replace(/^0/, '');
  const newNoPad = newHHMM.replace(/^0/, '');
  let newText = r.text.replace(oldHHMM, newHHMM);
  if (newText === r.text) newText = r.text.replace(oldNoPad, newNoPad);
  if (newText === r.text) {
    // 仍沒匹配 → 兩種格式都找不到時間,放棄改 Notion
    return {
      matched: true,
      reply: `⚠️ 找不到原時間 ${oldHHMM} 在 reminder 內容裡,沒改 Notion。\n你可以手動延後,或先用「延後到 HH:MM」改成絕對時間`,
    };
  }
  const updateOk = await updateBlockTextSimple(env, r.blockId, newText);

  // 更新 reminder
  r.startTimeMin = newTimeMin;
  r.text = newText;
  r.state = 'pending';
  r.lastUserActionAt = new Date().toISOString(); // v127
  r.startedAt = undefined; // v130: 延後 = 新行程,清 startedAt 不然 cron 永遠 skip
  r.startNotifiedAt = undefined;
  r.firstSentAt = undefined;
  r.secondSentAt = undefined;
  await saveReminders(env, userId, reminders);

  // v130: verify write — 1 秒後 read 確認,被 race 覆蓋就 retry 一次
  await new Promise((res) => setTimeout(res, 1000));
  const verify = await loadReminders(env, userId);
  const verified = verify.find((x) => x.id === r.id);
  if (verified && verified.startTimeMin !== newTimeMin) {
    console.warn(`[postpone] KV race detected,retry write for ${r.id.substring(0, 8)}`);
    verified.startTimeMin = newTimeMin;
    verified.text = newText;
    verified.state = 'pending';
    verified.lastUserActionAt = new Date().toISOString();
    verified.startedAt = undefined;
    verified.startNotifiedAt = undefined;
    verified.firstSentAt = undefined;
    verified.secondSentAt = undefined;
    await saveReminders(env, userId, verify);
  }

  const clean = newText.replace(/🔔/g, '').trim();
  return {
    matched: true,
    reminderId: r.id,
    reply: updateOk
      ? `✓ 已延後 ${minutes} 分鐘:${oldHHMM} → ${newHHMM}\nNotion 上事項「${clean}」已更新時間\n新時間前 5 分鐘我會再提醒`
      : `⚠️ 內部紀錄已延後到 ${newHHMM},但 Notion 寫入失敗,請手動改`,
  };
}

// ============================================================
// 跳過 — 沒原因就 awaiting_reason
// ============================================================
async function handleSkipCommand(
  env: Env,
  userId: string,
  spec: string,
  reason?: string,
  quotedReminderId?: string | null
): Promise<CommandResult> {
  const reminders = await loadReminders(env, userId);
  const r = findReminder(reminders, spec, quotedReminderId);
  if (!r) {
    return {
      matched: true,
      reply: `找不到對應提醒。例:「跳過 14:00 因為下雨」`,
    };
  }

  if (reason && reason.trim().length >= 2) {
    // 有原因 → resolved
    r.state = 'resolved';
    r.resolvedAt = new Date().toISOString();
    r.resolvedReason = 'user_response';
    // 把原因存進去(可選)
    (r as any).skipReason = reason;
    await saveReminders(env, userId, reminders);
    const clean = r.text.replace(/🔔/g, '').trim();
    return {
      matched: true,
      reminderId: r.id,
      reply: `✓ 已跳過「${clean}」\n原因:${reason}\n(我會記下,連續跳過同類事情會在晚安總結提醒你)`,
    };
  }

  // 沒原因 → awaiting_reason(cron 會每 5 分追問)
  r.state = 'awaiting_reason';
  r.lastUserActionAt = new Date().toISOString(); // v127
  r.lastFollowupAt = new Date().toISOString();
  await saveReminders(env, userId, reminders);
  const clean = r.text.replace(/🔔/g, '').trim();
  return {
    matched: true,
    reminderId: r.id,
    doNotShowQuickReply: true, // 反拖延,逼打字
    reply: [
      `要跳過「${clean}」,請告訴我為什麼`,
      '',
      '(這是反拖延設計 — 直接按「跳過」太容易,要你誠實面對)',
      '隨意打幾個字都行,例:「不舒服」「行程取消」「下次再說」',
      '',
      '⚠️ 沒給原因我會每 5 分鐘追問一次(NT$0.13/次)',
    ].join('\n'),
  };
}

// ============================================================
// 改 Notion block 文字(簡化版,不保 to_do checked 狀態)
// ============================================================
async function updateBlockTextSimple(
  env: Env,
  blockId: string,
  newText: string
): Promise<boolean> {
  try {
    // 先讀 block 取 type
    const getRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    });
    if (!getRes.ok) return false;
    const block: any = await getRes.json();
    const type = block.type;
    const payload: any = { [type]: {} };
    payload[type].rich_text = [{ type: 'text', text: { content: newText } }];
    if (type === 'to_do') payload.to_do.checked = block.to_do?.checked ?? false;

    const patchRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify(payload),
    });
    return patchRes.ok;
  } catch (e) {
    console.warn('[postpone] update block failed:', e);
    return false;
  }
}
