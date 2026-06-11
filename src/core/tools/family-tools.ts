/**
 * 綁定提醒(功能 2)— 給主帳號用的 AI 工具
 *   assign_child_reminder / list_child_reminders / cancel_child_reminder / update_child_reminder_time
 *
 * 全部 scope 在「呼叫者 = 主帳號(creator)」:
 *   - 解析子帳號用 resolveChildByLabel(只在自己綁定的子帳號裡找)
 *   - 改/停/刪一律帶 creator_user_id 條件
 * 子帳號呼叫這些工具 → getChildrenOf 為空 → 做不了任何事(防亂關第二道)。
 */

import type { Env } from '../types';
import {
  resolveChildByLabel,
  getChildrenOf,
  createAssignedReminder,
  listAssignedReminders,
  deleteAssigned,
  updateAssignedTime,
} from '../family/store';
import {
  getChildPolicy,
  setChildPolicy,
  DEFAULT_CHILD_POLICY,
  MODEL_RANK,
  type PolicyModel,
  type ChildPolicy,
  type InteractionLevel,
} from '../family/child-policy';
import { getDailyCost } from '../safety/budget';

/** 給主帳號看的模型中文標籤 */
const MODEL_LABEL: Record<PolicyModel, string> = {
  haiku: 'Haiku(快/最省)',
  sonnet: 'Sonnet(平衡)',
  'sonnet-thinking': 'Sonnet+思考(貴/推理深)',
  opus: 'Opus(最聰明/最貴)',
};

/** 未成年互動檔位中文標籤 */
const LEVEL_LABEL: Record<InteractionLevel, string> = {
  0: 'L0 純提醒(不過 AI)',
  1: 'L1 任務教練',
  2: 'L2 +安全問答',
};

export const FAMILY_TOOLS = [
  {
    name: 'assign_child_reminder',
    description:
      '幫「已綁定的子帳號」設定提醒(主帳號專用)。「每天早上8點提醒小明刷牙」「平日7點叫小華起床」「今天6點提醒小明帶作業」都用這個。' +
      'child_label=子帳號暱稱(小明);text=事項(刷牙);time=24 小時制 HH:MM;' +
      '一次性(只某一天,如「今天」「明天」「6/15」)→ 填 once_date=YYYY-MM-DD,不要填 days;' +
      '固定循環 → days(daily/weekdays/weekends 或「1,3,5」,不填=每天),不要填 once_date。',
    input_schema: {
      type: 'object',
      properties: {
        child_label: { type: 'string', description: '子帳號暱稱,需與綁定時的暱稱相符(如「小明」)' },
        text: { type: 'string', description: '要提醒子帳號做的事,如「刷牙」「寫作業」' },
        time: { type: 'string', description: '24 小時制 HH:MM,如「08:00」' },
        days: { type: 'string', description: '固定循環用:daily / weekdays / weekends / 或「1,3,5」(1=一..7=日)。不填=每天。一次性提醒勿填' },
        once_date: { type: 'string', description: '一次性提醒的日期 YYYY-MM-DD(今天/明天/某日)。填了=只提醒這天一次,勿同時填 days' },
      },
      required: ['child_label', 'text', 'time'],
    },
  },
  {
    name: 'list_child_reminders',
    description:
      '列出你幫子帳號設定的固定提醒(主帳號專用)。主帳號問「小明有哪些提醒」「我幫子帳號設了什麼」→ 用這個。child_label 不填則列全部子帳號。',
    input_schema: {
      type: 'object',
      properties: {
        child_label: { type: 'string', description: '可選:只看某個子帳號' },
      },
      required: [],
    },
  },
  {
    name: 'cancel_child_reminder',
    description:
      '取消/刪除你幫子帳號設的某個固定提醒(主帳號專用)。主帳號說「取消小明刷牙的提醒」「不要再叫小華起床了」→ 用這個。',
    input_schema: {
      type: 'object',
      properties: {
        child_label: { type: 'string', description: '子帳號暱稱' },
        text: { type: 'string', description: '要取消的提醒事項(如「刷牙」),用來指認是哪一條' },
      },
      required: ['child_label', 'text'],
    },
  },
  {
    name: 'update_child_reminder_time',
    description: '修改你幫子帳號設的某個提醒的時間(主帳號專用)。主帳號說「小明刷牙改成 7 點」→ 用這個。',
    input_schema: {
      type: 'object',
      properties: {
        child_label: { type: 'string', description: '子帳號暱稱' },
        text: { type: 'string', description: '要改的提醒事項(如「刷牙」)' },
        new_time: { type: 'string', description: '新的 24 小時制 HH:MM' },
      },
      required: ['child_label', 'text', 'new_time'],
    },
  },
  {
    name: 'set_child_chat_limit',
    description:
      '主帳號調整某個子帳號的「權限/安全/燒錢防護」(主帳號專用)。例:「小明成年了」「把小華設未成年」「讓小明開放到安全問答(L2)」「小華只給純提醒(L0)」「讓小明可以用 Sonnet」「小華每天上限改 0.3 美元」「放寬到每分鐘 15 則」「調回預設」。' +
      '只填要改的欄位,沒填的維持原狀。is_minor=是否未成年(true 套用未成年限制路徑);level=未成年互動檔位(0 純提醒不過AI / 1 任務教練 / 2 +安全問答);max_model=能用到的最高模型;daily_budget_usd=每日花費上限美元(0=不限);rate_per_min=每分鐘訊息上限(0=不限)。',
    input_schema: {
      type: 'object',
      properties: {
        child_label: { type: 'string', description: '子帳號暱稱,需與綁定時相符(如「小明」)' },
        is_minor: { type: 'boolean', description: '是否未成年。true=套用未成年限制(只提醒+任務教練、不開放聊天);false=成年,開放一般使用' },
        level: { type: 'integer', enum: [0, 1, 2], description: '未成年互動檔位:0 純提醒(不過AI)、1 任務教練(預設)、2 +安全問答' },
        max_model: {
          type: 'string',
          enum: ['haiku', 'sonnet', 'sonnet-thinking', 'opus'],
          description: '能用到的最高模型;haiku=最省(預設)、opus=最貴最聰明',
        },
        daily_budget_usd: { type: 'number', description: '每日聊天花費上限(美元),如 0.15;填 0 或負數=不限' },
        rate_per_min: { type: 'integer', description: '每分鐘訊息上限,如 8;填 0=不限' },
      },
      required: ['child_label'],
    },
  },
  {
    name: 'get_child_chat_limit',
    description:
      '查某個子帳號目前的聊天權限/燒錢防護設定(主帳號專用)。主帳號問「小明現在的限制是什麼」「小華能用什麼模型」「小明今天聊了多少」→ 用這個。',
    input_schema: {
      type: 'object',
      properties: {
        child_label: { type: 'string', description: '子帳號暱稱(如「小明」)' },
      },
      required: ['child_label'],
    },
  },
  {
    name: 'set_self_reminder',
    description:
      '幫「使用者自己」設提醒(任何人都能用,不需要 Notion)。「提醒我8點吃藥」「今天3點提醒我開會」「每天7點叫我起床」→ 用這個。' +
      'text=事項;time=24小時制HH:MM;一次性→once_date=YYYY-MM-DD(不填days);固定循環→days(daily/weekdays/「1,3,5」)。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要提醒自己的事,如「吃藥」「開會」' },
        time: { type: 'string', description: '24 小時制 HH:MM' },
        days: { type: 'string', description: '固定循環:daily/weekdays/weekends/「1,3,5」。不填=每天;一次性勿填' },
        once_date: { type: 'string', description: '一次性日期 YYYY-MM-DD(今天/明天/某日)。勿同時填 days' },
      },
      required: ['text', 'time'],
    },
  },
  {
    name: 'list_self_reminders',
    description: '列出使用者「自己設的」提醒。使用者問「我的提醒」「我設了什麼提醒」→ 用這個。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cancel_self_reminder',
    description: '取消使用者自己設的某個提醒。「取消吃藥提醒」「不用提醒我開會了」→ 用這個。',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要取消的提醒事項(用來指認是哪一條)' } },
      required: ['text'],
    },
  },
];

export const FAMILY_TOOL_NAMES = new Set(FAMILY_TOOLS.map((t) => t.name));

function normalizeTime(s: string): string | null {
  const m = (s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function normalizeDays(s?: string): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  if (t === 'daily' || t === '每天' || t === '') return null;
  if (t === 'weekdays' || t === '平日' || t === '工作日') return '1,2,3,4,5';
  if (t === 'weekends' || t === '週末' || t === '假日') return '6,7';
  const nums = t
    .split(/[,，、\s]+/)
    .map((x) => parseInt(x, 10))
    .filter((n) => n >= 1 && n <= 7);
  return nums.length ? Array.from(new Set(nums)).sort((a, b) => a - b).join(',') : null;
}

const DOW = ['一', '二', '三', '四', '五', '六', '日'];
function daysLabel(d: string | null): string {
  if (!d) return '每天';
  if (d === '1,2,3,4,5') return '平日';
  if (d === '6,7') return '週末';
  const ns = d.split(',').map((x) => parseInt(x, 10));
  return '週' + ns.map((n) => DOW[n - 1] || '?').join('、');
}

function normalizeDate(s?: string): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[0] : null;
}

/** 排程標籤:一次性顯示日期,循環顯示每天/平日/週X。 */
function schedLabel(onceDate: string | null, daysOfWeek: string | null): string {
  return onceDate ? `${onceDate} 一次` : daysLabel(daysOfWeek);
}

function candidatesMsg(kids: { childLabel: string | null }[]): string {
  const names = kids.map((k) => k.childLabel || '(未命名)').filter(Boolean);
  if (names.length === 0) return '你目前還沒綁定任何子帳號。請先打「綁定子帳號 小明」產生綁定碼給他。';
  return `找不到這個子帳號。你綁定的有:${names.join('、')}。`;
}

export async function executeFamilyTool(
  env: Env,
  toolName: string,
  input: any,
  userId: string
): Promise<string> {
  if (toolName === 'assign_child_reminder') {
    const label = (input?.child_label || '').toString();
    const text = (input?.text || '').toString().trim();
    const time = normalizeTime((input?.time || '').toString());
    const onceDate = normalizeDate(input?.once_date);
    const days = onceDate ? null : normalizeDays(input?.days);
    if (!text) return '沒收到要提醒的事項';
    if (!time) return '時間格式看不懂(需 24 小時制 HH:MM,如 08:00)';
    const r = await resolveChildByLabel(env, userId, label);
    if (!r.childUserId) return candidatesMsg(r.candidates || []);
    await createAssignedReminder(env, {
      creatorUserId: userId,
      assigneeUserId: r.childUserId,
      text,
      timeHhmm: time,
      daysOfWeek: days,
      onceDate,
    });
    return `✓ 已設定:${schedLabel(onceDate, days)} ${time} 提醒「${label}」${text}。到點我會提醒他,做了沒會回報給你。`;
  }

  if (toolName === 'list_child_reminders') {
    const label = (input?.child_label || '').toString().trim();
    let assigneeUserId: string | undefined;
    if (label) {
      const r = await resolveChildByLabel(env, userId, label);
      if (!r.childUserId) return candidatesMsg(r.candidates || []);
      assigneeUserId = r.childUserId;
    }
    const rows = await listAssignedReminders(env, userId, assigneeUserId);
    if (rows.length === 0) return label ? `「${label}」目前沒有任何提醒。` : '你還沒幫子帳號設任何提醒。';
    const kids = await getChildrenOf(env, userId);
    const labelOf = (uid: string) => kids.find((k) => k.childUserId === uid)?.childLabel || '(未命名)';
    const lines = rows.map(
      (a) => `- ${labelOf(a.assigneeUserId)}:${schedLabel(a.onceDate, a.daysOfWeek)} ${a.timeHhmm} ${a.text}${a.enabled ? '' : '(已停用)'}`
    );
    return `目前的提醒:\n${lines.join('\n')}`;
  }

  if (toolName === 'cancel_child_reminder' || toolName === 'update_child_reminder_time') {
    const label = (input?.child_label || '').toString();
    const text = (input?.text || '').toString().trim();
    const r = await resolveChildByLabel(env, userId, label);
    if (!r.childUserId) return candidatesMsg(r.candidates || []);
    const rows = await listAssignedReminders(env, userId, r.childUserId);
    const matches = rows.filter((a) => a.text === text || a.text.includes(text) || text.includes(a.text));
    if (matches.length === 0) return `找不到「${label}」叫「${text}」的提醒。可先用「${label}有哪些提醒」看看。`;
    if (matches.length > 1)
      return `「${label}」有多條符合「${text}」的提醒(${matches.map((m) => m.text).join('、')}),請說得更明確一點。`;
    const target = matches[0];
    if (toolName === 'cancel_child_reminder') {
      await deleteAssigned(env, userId, target.id);
      return `✓ 已取消「${label}」的提醒:${target.text}(${target.timeHhmm})。`;
    }
    const nt = normalizeTime((input?.new_time || '').toString());
    if (!nt) return '新時間格式看不懂(需 HH:MM)';
    await updateAssignedTime(env, userId, target.id, nt);
    return `✓ 已把「${label}」的「${target.text}」改成 ${nt}。`;
  }

  // ===== 防子帳號燒錢:主帳號調 / 查某子帳號的聊天權限 =====
  if (toolName === 'set_child_chat_limit' || toolName === 'get_child_chat_limit') {
    const label = (input?.child_label || '').toString();
    const r = await resolveChildByLabel(env, userId, label);
    if (!r.childUserId) return candidatesMsg(r.candidates || []);

    if (toolName === 'set_child_chat_limit') {
      const patch: Partial<ChildPolicy> = {};
      if (typeof input?.is_minor === 'boolean') {
        patch.isMinor = input.is_minor;
      }
      if (input?.level === 0 || input?.level === 1 || input?.level === 2) {
        patch.level = input.level as InteractionLevel;
      }
      if (typeof input?.max_model === 'string' && input.max_model in MODEL_RANK) {
        patch.maxModel = input.max_model as PolicyModel;
      }
      if (typeof input?.daily_budget_usd === 'number') {
        patch.dailyBudgetUsd = input.daily_budget_usd <= 0 ? 0 : input.daily_budget_usd;
      }
      if (typeof input?.rate_per_min === 'number') {
        patch.ratePerMin = input.rate_per_min <= 0 ? 0 : Math.floor(input.rate_per_min);
      }
      if (Object.keys(patch).length === 0)
        return '沒看懂要改什麼。可改:成年/未成年(is_minor)、互動檔位(level 0/1/2)、最高模型(max_model)、每日花費上限(daily_budget_usd)、每分鐘則數(rate_per_min)。';
      const next = await setChildPolicy(env, r.childUserId, patch);
      return (
        `✓ 已更新「${label}」的設定:\n` +
        `- 身份:${next.isMinor ? '未成年(套用限制)' : '成年(開放使用)'}\n` +
        (next.isMinor ? `- 互動檔位:${LEVEL_LABEL[next.level]}\n` : '') +
        `- 最高模型:${MODEL_LABEL[next.maxModel]}\n` +
        `- 每日花費上限:${next.dailyBudgetUsd > 0 ? '$' + next.dailyBudgetUsd : '不限'}\n` +
        `- 每分鐘訊息:${next.ratePerMin > 0 ? next.ratePerMin + ' 則' : '不限'}`
      );
    }

    // get_child_chat_limit
    const policy = await getChildPolicy(env, r.childUserId);
    const spentToday = await getDailyCost(env, r.childUserId);
    return (
      `「${label}」目前的設定:\n` +
      `- 身份:${policy.isMinor ? '未成年(套用限制)' : '成年(開放使用)'}\n` +
      (policy.isMinor ? `- 互動檔位:${LEVEL_LABEL[policy.level]}\n` : '') +
      `- 最高模型:${MODEL_LABEL[policy.maxModel]}\n` +
      `- 每日花費上限:${policy.dailyBudgetUsd > 0 ? '$' + policy.dailyBudgetUsd : '不限'}(今天已用 $${spentToday.toFixed(3)})\n` +
      `- 每分鐘訊息:${policy.ratePerMin > 0 ? policy.ratePerMin + ' 則' : '不限'}\n` +
      `(預設:未成年 / L1 任務教練 / ${MODEL_LABEL[DEFAULT_CHILD_POLICY.maxModel]} / $${DEFAULT_CHILD_POLICY.dailyBudgetUsd} / ${DEFAULT_CHILD_POLICY.ratePerMin} 則)`
    );
  }

  // ===== 使用者自己的提醒(任何人,不需要 Notion) =====
  if (toolName === 'set_self_reminder') {
    const text = (input?.text || '').toString().trim();
    const time = normalizeTime((input?.time || '').toString());
    const onceDate = normalizeDate(input?.once_date);
    const days = onceDate ? null : normalizeDays(input?.days);
    if (!text) return '沒收到要提醒的事項';
    if (!time) return '時間格式看不懂(需 24 小時制 HH:MM,如 08:00)';
    await createAssignedReminder(env, {
      creatorUserId: userId,
      assigneeUserId: userId,
      text,
      timeHhmm: time,
      daysOfWeek: days,
      onceDate,
    });
    return `✓ 好,${schedLabel(onceDate, days)} ${time} 提醒你「${text}」。`;
  }

  if (toolName === 'list_self_reminders') {
    const rows = (await listAssignedReminders(env, userId)).filter((a) => a.assigneeUserId === userId);
    if (rows.length === 0) return '你目前沒有設自己的提醒。說「提醒我 8 點吃藥」就能設。';
    const lines = rows.map(
      (a) => `- ${schedLabel(a.onceDate, a.daysOfWeek)} ${a.timeHhmm} ${a.text}${a.enabled ? '' : '(已停用)'}`
    );
    return `你自己的提醒:\n${lines.join('\n')}`;
  }

  if (toolName === 'cancel_self_reminder') {
    const text = (input?.text || '').toString().trim();
    const rows = (await listAssignedReminders(env, userId)).filter((a) => a.assigneeUserId === userId);
    const matches = rows.filter((a) => a.text === text || a.text.includes(text) || text.includes(a.text));
    if (matches.length === 0) return `找不到叫「${text}」的提醒。可先說「我的提醒」看看。`;
    if (matches.length > 1) return `有多條符合「${text}」(${matches.map((m) => m.text).join('、')}),請說明確一點。`;
    await deleteAssigned(env, userId, matches[0].id);
    return `✓ 已取消提醒:${matches[0].text}(${matches[0].timeHhmm})。`;
  }

  return `Unknown tool: ${toolName}`;
}
