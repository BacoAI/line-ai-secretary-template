/**
 * 分流器(thin router)— 純規則,0 延遲,不呼叫 AI。
 *
 * 作用:一則「沒被既有 28 個指令攔下」的訊息,在丟給 AI 前先決定走哪條路:
 *  - 'full'  → 全套系統提示(18.8k)+ 30 個工具(17.4k)。需要「動手」的訊息(寫 Notion /
 *             排程 / 提醒 / 上網查)才走這條。
 *  - 'light' → 輕量路徑:迷你系統提示(~1.5k)+ 0 工具。閒聊 / 問答 / 模稜兩可走這條。
 *
 * 設計原則(重要):
 *  1. 判斷必須是純規則 → 0 延遲。用 AI 判反而又多一次往返,失去意義。
 *  2. **偏向 light**。light 路徑帶 [[ESCALATE]] 逃生艙(輕量模型一旦發現使用者要改動資料,
 *     會自己喊升級 → 後端轉全套重跑),所以「把該 full 的誤判成 light」不致命,只是多一次呼叫。
 *  3. 反之「把閒聊誤判成 full」會白白付 37k 的慢與貴(雖然答案仍正確)。所以只有 **明顯要動手**
 *     才判 full,寧可漏判(交給逃生艙),不要過度判 full。
 *
 * 關鍵字外露(下面的陣列)方便日後用真實 log 調整邊界 —— 見實作分段 ⑤。
 */

export type Route = 'light' | 'full';

/**
 * 明顯的「動作 / 寫入 / 排程」訊號 — 命中即 full。
 * 刻意用多字詞 / 幫我-前綴,降低誤判(例:避免單一「加」命中「參加 / 加油」)。
 */
export const FULL_VERBS: string[] = [
  // 提醒 / 排程
  '提醒我', '提醒一下', '排程', '安排', '排個', '排一',
  // 寫入 / 新增到清單
  '幫我記', '幫我加', '幫我排', '幫我設', '幫我訂', '幫我安排',
  '新增', '加到', '加入清單', '加進', '記到', '記進',
  // 修改 / 刪除 / 完成 / 撤回
  '刪掉', '刪除', '移除', '取消掉', '改成', '標記', '做完了', '完成了', '撤回',
  '設定', '更新成',
];

/** 出門 / 帶東西(需 outing 工具) */
export const OUTING_HINTS: string[] = ['要帶', '記得帶', '出門帶', '別忘了帶', '帶什麼出門'];

/** 明確要上網查(需 web_search 工具) */
export const SEARCH_HINTS: string[] = ['幫我查', '查一下', '搜尋一下', '今天天氣', '明天天氣', '匯率', '股價'];

/** 明確時刻樣式:HH:MM 或 「N 點」 */
const CLOCK_RE = /(\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*點)/;
/** 跟時刻搭配才算排程意圖的動詞(時刻單獨出現不算,避免「今天 3 點好熱」誤判) */
const SCHEDULE_NEAR_CLOCK_RE = /(要|幫我|提醒|排|加|記|開會|會議|回診|看診|出門)/;

/**
 * 判斷一則訊息該走 light 還是 full。
 * @param text 使用者訊息(語音已轉文字)
 */
export function routeMessage(text: string): Route {
  const t = (text || '').trim();
  if (!t) return 'light';

  for (const kw of FULL_VERBS) if (t.includes(kw)) return 'full';
  for (const kw of OUTING_HINTS) if (t.includes(kw)) return 'full';
  for (const kw of SEARCH_HINTS) if (t.includes(kw)) return 'full';

  // 「明確時刻 + 排程語境」→ 排程意圖 → full
  if (CLOCK_RE.test(t) && SCHEDULE_NEAR_CLOCK_RE.test(t)) return 'full';

  // 其餘(問句、閒聊、反應、模稜兩可)→ light(由 [[ESCALATE]] 逃生艙兜底)
  return 'light';
}
