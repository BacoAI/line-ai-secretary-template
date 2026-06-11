/**
 * 防子帳號亂玩燒錢 — 每個子帳號一份「聊天權限」設定(parent-adjustable)。
 *
 * 設計原則(對齊專案 Layer 3「隨時口語修改」):
 *  - 不寫死:每個子帳號一筆 KV(`child-policy:<childUserId>`),沒設過就吃 DEFAULT。
 *  - 主帳號隨時用講的調:全套路徑的 set_child_chat_limit 工具 → setChildPolicy 寫 KV → 即時生效。
 *  - 免動 D1 schema(避開「prod D1 非 migration 建」的遠端套用麻煩)。
 *
 * 三道防護:
 *  1. maxModel       — 該子帳號能用到的「最高」模型(預設 haiku = 鎖死最便宜)。擋掉子帳號自己切 Opus(差 25~50 倍)。
 *  2. dailyBudgetUsd — 每日聊天花費上限(Taipei 日界,跨午夜歸零)。到頂溫和擋住,提醒完成不受限。
 *  3. ratePerMin     — 每分鐘訊息上限,擋連續猛戳洗版。
 *
 * 只對「非開發者(子帳號/學員)」套用;開發者本人不受限。
 */

import type { Env } from '../types';
import { getDailyCost } from '../safety/budget';

/** 與 line.ts 的 UserMode 同一組字串(刻意不 import,避免跨檔耦合) */
export type PolicyModel = 'haiku' | 'sonnet' | 'sonnet-thinking' | 'opus';

/**
 * 未成年互動檔位(只在 isMinor=true 時有意義):
 *  0 = 純提醒:不過 AI,只能按鈕/固定格式
 *  1 = 任務教練(預設):設提醒 + 任務拆解/專注陪伴/鼓勵/慶祝,綁孩子自己的任務;其餘婉拒導去別的 AI
 *  2 = +安全問答:L1 再加 天氣/日期/簡單字詞 等有限事實
 * 開放聊天(等同 L3)不提供給未成年。
 */
export type InteractionLevel = 0 | 1 | 2;

export interface ChildPolicy {
  maxModel: PolicyModel; // 能用到的最高模型;預設 haiku
  dailyBudgetUsd: number; // 每日聊天花費上限(USD);<=0 = 不限
  ratePerMin: number; // 每分鐘訊息上限;<=0 = 不限
  isMinor: boolean; // 是否未成年;預設 true(保守)。決定是否套用未成年限制路徑
  level: InteractionLevel; // 未成年互動檔位(見上);預設 1
}

export const DEFAULT_CHILD_POLICY: ChildPolicy = {
  maxModel: 'haiku',
  dailyBudgetUsd: 0.15,
  ratePerMin: 8,
  isMinor: true,
  level: 1,
};

/** 模型由便宜到貴的排序,給「clamp 到 maxModel」與「切換是否被允許」用 */
export const MODEL_RANK: Record<PolicyModel, number> = {
  haiku: 0,
  sonnet: 1,
  'sonnet-thinking': 2,
  opus: 3,
};

const policyKey = (childUserId: string) => `child-policy:${childUserId}`;

/** 讀某子帳號的政策;沒設過 / 無 KV → DEFAULT。 */
export async function getChildPolicy(env: Env, childUserId: string): Promise<ChildPolicy> {
  if (!env.CACHE) return { ...DEFAULT_CHILD_POLICY };
  try {
    const raw = await env.CACHE.get(policyKey(childUserId));
    if (raw) {
      const o = JSON.parse(raw);
      return {
        maxModel: (o.maxModel in MODEL_RANK ? o.maxModel : DEFAULT_CHILD_POLICY.maxModel) as PolicyModel,
        dailyBudgetUsd:
          typeof o.dailyBudgetUsd === 'number' ? o.dailyBudgetUsd : DEFAULT_CHILD_POLICY.dailyBudgetUsd,
        ratePerMin: typeof o.ratePerMin === 'number' ? o.ratePerMin : DEFAULT_CHILD_POLICY.ratePerMin,
        isMinor: typeof o.isMinor === 'boolean' ? o.isMinor : DEFAULT_CHILD_POLICY.isMinor,
        level: o.level === 0 || o.level === 1 || o.level === 2 ? o.level : DEFAULT_CHILD_POLICY.level,
      };
    }
  } catch {}
  return { ...DEFAULT_CHILD_POLICY };
}

/** 主帳號調整某子帳號政策(只 patch 有給的欄位),回傳更新後完整政策。 */
export async function setChildPolicy(
  env: Env,
  childUserId: string,
  patch: Partial<ChildPolicy>
): Promise<ChildPolicy> {
  const cur = await getChildPolicy(env, childUserId);
  const next: ChildPolicy = { ...cur, ...patch };
  if (env.CACHE) await env.CACHE.put(policyKey(childUserId), JSON.stringify(next));
  return next;
}

/** 把使用者選的模型 clamp 到政策允許的最高模型(超過就降到 maxModel)。 */
export function clampModelToPolicy(mode: PolicyModel, maxModel: PolicyModel): PolicyModel {
  return MODEL_RANK[mode] <= MODEL_RANK[maxModel] ? mode : maxModel;
}

/** 政策是否允許切到某模型 */
export function isModelAllowedByPolicy(mode: PolicyModel, maxModel: PolicyModel): boolean {
  return MODEL_RANK[mode] <= MODEL_RANK[maxModel];
}

export interface ChatGuardResult {
  allowed: boolean;
  reason?: string; // 擋下時給子帳號看的人話
}

/**
 * 子帳號聊天前的防護檢查(防洗版 + 每日 $ 上限)。
 * 只該對「非開發者」呼叫;且要放在「家庭/提醒 deterministic 指令都已 return」之後,
 * 才不會擋到提醒完成回報 —— 只擋真正燒錢的自由聊天。
 */
export async function checkChildChatGuard(
  env: Env,
  childUserId: string,
  prePolicy?: ChildPolicy
): Promise<ChatGuardResult> {
  const policy = prePolicy ?? (await getChildPolicy(env, childUserId));

  // 1. 防洗版:固定視窗每分鐘計數(KV 無原子 incr,個人 bot 競態可忽略)
  if (env.CACHE && policy.ratePerMin > 0) {
    const bucket = Math.floor(Date.now() / 60000);
    const rlKey = `child-rl:${childUserId}:${bucket}`;
    let cnt = 0;
    try {
      cnt = parseInt((await env.CACHE.get(rlKey)) || '0', 10) || 0;
    } catch {}
    if (cnt >= policy.ratePerMin) {
      return { allowed: false, reason: '訊息傳太快囉,休息一下下,過一分鐘再跟我說~' };
    }
    try {
      await env.CACHE.put(rlKey, String(cnt + 1), { expirationTtl: 120 });
    } catch {}
  }

  // 2. 每日花費上限(Taipei 日界)
  if (policy.dailyBudgetUsd > 0) {
    const spent = await getDailyCost(env, childUserId);
    if (spent >= policy.dailyBudgetUsd) {
      return {
        allowed: false,
        reason: '今天聊得夠多囉,我先休息,明天再陪你玩~(提醒完成還是可以正常回報喔)',
      };
    }
  }

  return { allowed: true };
}
