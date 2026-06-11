/**
 * 綁定提醒(功能 2)— 投遞共用邏輯(純資料 + KV,不含推播)
 *
 * 推播(帶按鈕)留給呼叫端:cron 用 pushLineMessage、handler 用 pushText。
 * 這裡只負責:模板→今日提醒、完成/snooze 的 KV 狀態變更、回報主帳號的文字。
 */

import type { Env } from '../types';
import { loadReminders, saveReminders, type Reminder } from '../reminders/store';
import { getChildLabel, type AssignedReminder } from './store';

export const CHILD_MISSED_AFTER_MIN = 15; // 過點 15 分沒做 → 通知主帳號 + 催子帳號
export const CHILD_EMERGENCY_AFTER_MIN = 30; // 過點 30 分還沒做 → Pushover 緊急(priority 2 狂響突破靜音)
export const CHILD_MATERIALIZE_GRACE_MIN = 30; // 超過排程時間 30 分以上,今天不補觸發(避免事後綁定就被舊提醒轟炸)
export const CHILD_SNOOZE_MAX = 2; // 「等一下做」最多 2 次
export const CHILD_SNOOZE_MIN = 10; // 每次延 10 分

function formatHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** 今天(dow:1=Mon..7=Sun)是否該觸發此「循環」模板。 */
export function isDueOnDow(daysOfWeek: string | null, dow: number): boolean {
  if (!daysOfWeek) return true;
  return daysOfWeek
    .split(',')
    .map((x) => parseInt(x, 10))
    .includes(dow);
}

const DOW_CH = ['一', '二', '三', '四', '五', '六', '日'];
/** 排程的中文標籤:一次性顯示日期,循環顯示每天/平日/週末/週X。 */
export function formatSchedule(daysOfWeek: string | null, onceDate: string | null): string {
  if (onceDate) return `${onceDate} 一次`;
  if (!daysOfWeek) return '每天';
  if (daysOfWeek === '1,2,3,4,5') return '平日';
  if (daysOfWeek === '6,7') return '週末';
  return '週' + daysOfWeek.split(',').map((x) => DOW_CH[parseInt(x, 10) - 1] || '?').join('、');
}

/** 模板今天是否該觸發:一次性看 once_date==today;循環看星期。 */
export function isTemplateDueToday(
  daysOfWeek: string | null,
  onceDate: string | null,
  dow: number,
  todayStr: string
): boolean {
  if (onceDate) return onceDate === todayStr;
  return isDueOnDow(daysOfWeek, dow);
}

export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}

/** 指派模板 → 今天的 KV Reminder(無 Notion block)。creator==assignee → 'self'(自己設),否則 'parent_request'(主帳號設)。 */
export function templateToReminder(t: AssignedReminder): Reminder {
  const isSelf = t.creatorUserId === t.assigneeUserId;
  return {
    id: crypto.randomUUID(),
    blockId: '',
    text: t.text,
    startTimeMin: hhmmToMin(t.timeHhmm),
    enabled: true,
    source: isSelf ? 'self' : 'parent_request',
    state: 'pending',
    creatorUserId: t.creatorUserId,
    assignedTemplateId: t.id,
    childSnoozeCount: 0,
  };
}

// ============== 回報主帳號的字 ==============

export function doneReportText(childLabel: string, text: string, startMin: number): string {
  return `✓ ${childLabel} 完成了「${text}」(${formatHHMM(startMin)} 的提醒)`;
}
export function missedReportText(childLabel: string, text: string, startMin: number): string {
  return `⚠ ${childLabel} 還沒做「${text}」(${formatHHMM(startMin)} 已過 ${CHILD_MISSED_AFTER_MIN} 分鐘)`;
}
export function snoozeReportText(childLabel: string, text: string, n: number): string {
  return `⏰ ${childLabel} 把「${text}」延後 ${CHILD_SNOOZE_MIN} 分鐘(第 ${n} 次)`;
}

// ============== 子帳號動作:完成 / 等一下做(KV-only,回報文字交呼叫端 push) ==============

export interface ChildActionResult {
  childReply: string;
  notifyParent?: { userId: string; text: string };
}

/** 子帳號標完成 → resolved + 回報主帳號。 */
export async function completeChildReminder(
  env: Env,
  childUserId: string,
  reminderId: string
): Promise<ChildActionResult> {
  const rems = await loadReminders(env, childUserId);
  const r = rems.find((x) => x.id === reminderId && x.source === 'parent_request');
  if (!r) return { childReply: '找不到這個提醒(可能已過期)' };
  if (r.state === 'resolved') return { childReply: '這個已經完成囉 ✓' };
  r.state = 'resolved';
  r.resolvedAt = new Date().toISOString();
  r.resolvedReason = 'user_response';
  r.lastUserActionAt = new Date().toISOString();
  await saveReminders(env, childUserId, rems);
  // 自己設的提醒(creator==assignee)不回報;只有主帳號設的才回報主帳號
  const parentId = r.creatorUserId && r.creatorUserId !== childUserId ? r.creatorUserId : undefined;
  const label = parentId ? await getChildLabel(env, parentId, childUserId) : '子帳號';
  return {
    childReply: parentId ? '✓ 完成,已回報給主帳號,讚!' : '✓ 完成,讚!',
    notifyParent: parentId ? { userId: parentId, text: doneReportText(label, r.text, r.startTimeMin) } : undefined,
  };
}

/** 子帳號按「等一下做」→ 延 10 分(上限 2 次)+ 回報主帳號。 */
export async function snoozeChildReminder(
  env: Env,
  childUserId: string,
  reminderId: string
): Promise<ChildActionResult> {
  const rems = await loadReminders(env, childUserId);
  const r = rems.find((x) => x.id === reminderId && x.source === 'parent_request');
  if (!r) return { childReply: '找不到這個提醒(可能已過期)' };
  if (r.state === 'resolved') return { childReply: '這個已經完成囉 ✓' };
  const isSelf = !r.creatorUserId || r.creatorUserId === childUserId;
  const count = (r.childSnoozeCount ?? 0) + 1;
  if (!isSelf && count > CHILD_SNOOZE_MAX) {
    return { childReply: '不能再延囉,趕快做完吧!做完按「✓ 完成」' };
  }
  r.childSnoozeCount = count;
  r.startTimeMin += CHILD_SNOOZE_MIN;
  r.state = 'pending'; // 延後後重新等到點觸發
  r.firstSentAt = undefined;
  r.reportedMissedToParent = false; // 延後後重新計算 missed
  // 注意:不設 lastUserActionAt — 否則 30 分 skip 窗會擋掉 10 分後的重新觸發
  await saveReminders(env, childUserId, rems);
  const parentId = isSelf ? undefined : r.creatorUserId!;
  const label = parentId ? await getChildLabel(env, parentId, childUserId) : '子帳號';
  return {
    childReply: isSelf
      ? `好,${CHILD_SNOOZE_MIN} 分鐘後再提醒你`
      : `好,${CHILD_SNOOZE_MIN} 分鐘後再提醒你(還可延 ${CHILD_SNOOZE_MAX - count} 次)`,
    notifyParent: parentId ? { userId: parentId, text: snoozeReportText(label, r.text, count) } : undefined,
  };
}

const DONE_WORDS = /^(完成了?|做完了?|做好了?|弄好了?|好了|ok|done)$/i;

/** 子帳號打字「完成」的 fast-path:只在真的有主帳號提醒在等時才攔截,否則回 null 交回原流程。 */
export async function tryChildDoneTyped(
  env: Env,
  childUserId: string,
  text: string
): Promise<ChildActionResult | null> {
  const t = (text || '').trim();
  if (!DONE_WORDS.test(t)) return null;
  const rems = await loadReminders(env, childUserId);
  const active = rems.filter(
    (x) =>
      (x.source === 'parent_request' || x.source === 'self') &&
      (x.state === 'first_sent' || x.state === 'second_sent')
  );
  if (active.length === 0) return null; // 沒有主帳號提醒在等 → 不攔,交回原本「完成了」處理
  active.sort((a, b) => new Date(b.firstSentAt || 0).getTime() - new Date(a.firstSentAt || 0).getTime());
  return completeChildReminder(env, childUserId, active[0].id);
}
