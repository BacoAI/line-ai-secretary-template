/**
 * 輕量路徑(light path)— 給「閒聊 / 問答 / 模稜兩可」訊息走的快車道。
 *
 * 跟全套路徑(buildSystemPrompt 18.8k + 30 工具 17.4k)相比:
 *  - 迷你系統提示(~0.6k),0 工具 → 前綴從 ~37k 砍到 ~1k(降 ~97%)。
 *  - 模型固定 Haiku + maxTokens 壓低 + 提示要求「回短」→ TTFT 與生成都快、成本 $0.048→~$0.002。
 *
 * 逃生艙(escalate):輕量模型沒有任何工具,一旦發現使用者其實要「動手」(改提醒/排計畫/
 * 寫 Notion/上網查),提示要求它只回 [[ESCALATE]] → 呼叫端偵測到就轉全套路徑重跑。
 * 這讓分流器(route.ts)可以「偏向 light」而不致命:誤判頂多多一次呼叫,不會無聲失敗。
 */

import type { Env } from '../types';
import { chat, type ChatResult } from './claude';
import { buildCoreIdentity } from './core-prompt';
import { buildWeekDateTable } from '../util/time';

/** 逃生艙標記 — 輕量模型發現需要工具時回這個,呼叫端偵測後轉全套 */
export const ESCALATE_TOKEN = '[[ESCALATE]]';

/** 輕量模型的回應是否在喊「我需要工具,請升級」 */
export function needsEscalate(text: string): boolean {
  return !!text && text.includes(ESCALATE_TOKEN);
}

/** 迷你系統提示 — 刻意極短,只保留非妥協不可的行為 */
export function buildLightSystemPrompt(env: Env): string {
  const now = new Date();
  const tpe = new Intl.DateTimeFormat('zh-TW', {
    timeZone: env.TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);

  return `${buildCoreIdentity(env.OWNER_NAME)}

【現在時間】${tpe}

${buildWeekDateTable(env)}
(問「本週X/上週X/下週X/某天幾號」一律查上表,不要自己心算 —— 心算容易差一天。)

【回答風格】
- 這是 LINE 即時對話:回覆簡短直接,一般 2~4 句講完,不要長篇、不要硬湊條列。
- 知道就直接答;不知道就老實說「我不知道」並講清楚為什麼(缺什麼資訊),絕不裝死、絕不亂猜。

【你這條路徑沒有任何工具 — 最重要】
你現在「無法」動手、也「無法」查使用者的個人資料。遇到下列任一種,你都做不到 ——
**只回 ${ESCALATE_TOKEN} 這個標記、一個字都不要多寫**,系統會自動把這則轉給有工具的完整助理處理:

1. 要你「動手」改東西:新增 / 修改 / 刪除 / 完成 提醒或待辦、排計畫、設定排程鬧鐘、設定「帶東西 / 出門清單」。
2. 要你「查使用者自己的東西」:他的待辦、行程、提醒、計畫、報告、進度、Notion 內容、今天/昨天/最近做了什麼或完成沒。
   ⚠ 這些完整助理查得到、你查不到。**絕對不要回「我沒有存取」「我看不到你的清單」這類** —— 那是錯的,一律改成 ${ESCALATE_TOKEN} 讓它去查。
3. 要你查即時外部資訊:天氣、新聞、匯率、股價等。

反之,只有「**既不用動手、也不用碰任何個人資料**」的訊息才直接回答:一般知識問答、閒聊、給建議、陪伴情緒、解釋概念。這類正常回,**不要** escalate。`;
}

export interface LightChatResult {
  text: string;
  escalate: boolean;
  result: ChatResult;
}

/**
 * 跑輕量路徑。
 * @returns null 表示「無法用輕量處理」(缺 key 或被燒錢防護擋下)→ 呼叫端應改走全套。
 */
export async function chatLight(
  env: Env,
  opts: {
    history: Array<{ role: string; content: string }>;
    userMessage: string;
    userId: string;
    taskContext: string;
  }
): Promise<LightChatResult | null> {
  const system = buildLightSystemPrompt(env);
  const messages = [
    ...opts.history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user' as const, content: opts.userMessage },
  ];

  const result = await chat(env, {
    taskContext: opts.taskContext,
    userId: opts.userId,
    system,
    messages,
    model: 'claude-haiku-4-5',
    maxTokens: 800,
  });

  if (!result) return null; // 缺 key / 被擋 → 呼叫端轉全套
  return { text: result.text, escalate: needsEscalate(result.text), result };
}
