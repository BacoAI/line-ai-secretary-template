/**
 * 提醒儲存 — KV-based,簡單可靠
 *
 * 結構:
 *   reminders:{userId}:{YYYY-MM-DD} = JSON Reminder[]
 *
 * Reminder 狀態機:
 *   pending → first_sent → (使用者回應 OR T+15 檢查 Notion)
 *   first_sent → second_sent(若未動)
 *   first_sent → resolved(若使用者回應 / Notion 完成 / 被修改)
 */

import type { Env } from '../types';
import { getTodayPageId } from '../planning/contract'; // v220(A-1): 今日計畫頁改走 per-user contract
import { isInternalMode } from '../config/runtime-config';
import { localWallClock } from '../util/time';

export interface Reminder {
  id: string;             // 唯一 ID
  blockId: string;        // Notion block ID
  text: string;           // 事項文字(原始)
  startTimeMin: number;   // HH:MM 轉成分鐘(14:00 = 840)
  endTimeMin?: number;    // 若事項含「~」「-」「到」分隔 → 解析結束時間
  enabled: boolean;       // 是否啟用提醒
  source: 'notion' | 'line' | 'parent_request' | 'self'; // Notion 符號 / LINE 電話 / 家長指派 / 自己設(功能 2)
  state: 'pending' | 'first_sent' | 'second_sent' | 'awaiting_reason' | 'started' | 'resolved';
  firstSentAt?: string;   // ISO timestamp
  startNotifiedAt?: string;   // v110: T+0「現在開始」提醒推播時間(在 first_sent 期間額外推一次,不切 state)
  secondSentAt?: string;
  startedAt?: string;         // v110: 使用者按「▶ 開始做了」按鈕的時間(state→started,停止追殺)
  resolvedAt?: string;
  resolvedReason?: 'user_response' | 'notion_checked' | 'notion_modified' | 'skipped';
  // 追殺模式(second_sent 後每 1 分鐘追到 resolved;v110 前為 5 分鐘)
  followupCount?: number;     // 已追殺幾次
  lastFollowupAt?: string;    // 最後一次追殺時間
  followupHistory?: string[]; // v110: 過往追殺訊息摘要,給 Haiku 生成下一則「不同的話」當 context(目前先預留欄位)
  totalPushCount?: number;    // 總共推了幾則(含 first/second/followup)— 算成本用
  lastUserActionAt?: string;  // v127: user 任何動作(按按鈕/打字回覆)的時間,cron 看到 60s 內動過就跳過避免 race
  // 跨任務 check:使用者說「在做了」但還沒勾 → 過一陣子驗證
  inProgressMarkedAt?: string; // 使用者標 in_progress 的時間
  nextCheckAt?: string;       // 下次該 check 的時間(in_progress / 使用者延長後設)
  // v214: 電話功能
  callAction?: boolean;       // true = 到點「打電話」念內容,而非推 LINE(來源:「X點打給我」指令 or Notion 📞 符號)
  queryPlan?: 'today' | 'tomorrow'; // v219: 查詢型電話 — 到點不念字面,改讀 Notion 今天/明天計畫 + Haiku 濃縮報出來
  phoneCalledAt?: number;     // 已撥過電話的 epoch 毫秒時間戳(防追殺迴圈每分鐘重複撥;也給「到點 callAction」防重撥)
  pushoverNotifyCount?: number; // v215: Pushover priority 1 推了幾次 — 追殺電話改用「響滿 3 次」相對門檻,不再寫死 followupCount=6
  // 親子提醒(功能 2)— source='parent_request' 時填
  creatorUserId?: string;            // 指派此提醒的家長 userId(完成/沒做時回報給他)
  assignedTemplateId?: string;       // 對應 assigned_reminders 模板 id(物化去重 + 管理)
  childSnoozeCount?: number;         // 小孩「等一下做」次數(有限 snooze;每次家長看得到)
  reportedDoneToParent?: boolean;    // 已回報「完成」給家長(防重複推)
  reportedMissedToParent?: boolean;  // 已回報「沒做」給家長(防重複推)
  emergencyPushoverSent?: boolean;   // 已發過 Pushover 緊急(priority 2 狂響突破靜音)— 防重複
}

function todayKey(env: Env, userId: string): string {
  const tpe = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return `reminders:${userId}:${tpe}`;
}

export async function loadReminders(env: Env, userId: string): Promise<Reminder[]> {
  if (!env.CACHE) return [];
  try {
    const raw = await env.CACHE.get(todayKey(env, userId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveReminders(
  env: Env,
  userId: string,
  reminders: Reminder[]
): Promise<void> {
  if (!env.CACHE) return;
  try {
    // 保留 36 小時(隔天 cron 清理)
    await env.CACHE.put(todayKey(env, userId), JSON.stringify(reminders), {
      expirationTtl: 36 * 3600,
    });
  } catch (e) {
    console.warn('[reminders] save failed:', e);
  }
}

// v219: 偵測「查詢型」提醒 — 要 bot 報今天/明天工作計畫(到點讀 Notion 念,而非字面複述)。
//   LINE「X點打給我」與 Notion 📞 共用。回 'today' | 'tomorrow' | undefined。
export function detectQueryPlan(text: string): 'today' | 'tomorrow' | undefined {
  if (!/工作|計畫|計劃|行程|事項|安排|要做什麼|做什麼|有哪些|有什麼/.test(text)) return undefined;
  if (/明天|明日/.test(text)) return 'tomorrow';
  if (/今天|今日|今晚|今早/.test(text)) return 'today';
  return undefined;
}

export function parseTimeMin(text: string): number | null {
  const m = text.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1]);
  const mm = parseInt(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

// 解析時間範圍:「9:00~11:00」「14:00-15:30」「14:00 到 15:30」
export function parseTimeRange(text: string): { start: number; end: number | null } {
  const start = parseTimeMin(text);
  if (start === null) return { start: 0, end: null };
  // 找第二個 HH:MM(在 「~」「-」「到」「至」後面)
  const m = text.match(/\d{1,2}:\d{2}\s*[~\-到至–—]\s*(\d{1,2}):(\d{2})/);
  if (!m) return { start, end: null };
  const eh = parseInt(m[1]);
  const em = parseInt(m[2]);
  if (eh < 0 || eh > 23 || em < 0 || em > 59) return { start, end: null };
  const end = eh * 60 + em;
  return { start, end: end > start ? end : null };
}

export function formatTime(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 從 Notion 今日計畫提取「有時間 + 🔔 符號」的事項
/**
 * v173: 容錯解析 Notion heading 的日期 — 接受 4 種常見格式
 *   - 「05/26 星期一」/「5/26 星期一」(MM/DD 或 M/D + 後綴)
 *   - 「5月6日」/「5 月 6 日」(中文 月日)
 *   - 「5/26 (一)」/「05/26 週一」(括號 / 週 / 星期 後綴)
 *   - 「05-26」「5.26」(分隔符變化)
 * 回 {month, day} 或 null
 */
export function parseHeadingDate(text: string): { month: number; day: number } | null {
  const norm = text.replace(/\s+/g, ''); // 去所有空格
  // MM/DD 或 M/D
  let m = norm.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return { month: parseInt(m[1], 10), day: parseInt(m[2], 10) };
  // MM-DD
  m = norm.match(/(\d{1,2})-(\d{1,2})/);
  if (m) return { month: parseInt(m[1], 10), day: parseInt(m[2], 10) };
  // M 月 D 日(中文)
  m = norm.match(/(\d{1,2})月(\d{1,2})日?/);
  if (m) return { month: parseInt(m[1], 10), day: parseInt(m[2], 10) };
  // M.D
  m = norm.match(/(\d{1,2})\.(\d{1,2})/);
  if (m) return { month: parseInt(m[1], 10), day: parseInt(m[2], 10) };
  return null;
}

export async function scanTodayPlanForReminders(env: Env, userId: string): Promise<Array<{
  blockId: string;
  text: string;
  startTimeMin: number;
  endTimeMin?: number;
  callAction?: boolean; // v214: 開頭是 📞 的事項 → 到點打電話念內容(由呼叫端決定怎麼用,scan 只標記)
  queryPlan?: 'today' | 'tomorrow'; // v219: 📞 查詢型(報今天/明天工作)→ 到點讀計畫念
}>> {
  // internal 模式(不接 Notion)→ 不掃 Notion 今日計畫。根因兜底:notion→internal 切換後 KV 的 contract
  //   會殘留,getTodayPageId 仍回有效 id → 每分鐘 runReminderCheck 會誤打 api.notion.com。這裡直接擋掉。
  if (isInternalMode(env)) return [];
  // v220(A-1): 改走 per-user contract,不再寫死今日計畫頁。沒 contract(學員未設定)→ 回空,不掃別人的頁。
  const TODAY_PAGE_ID = await getTodayPageId(env, userId);
  if (!TODAY_PAGE_ID) return [];
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
    console.warn(`[reminders] read today plan failed: ${response.status}`);
    return [];
  }
  const data: any = await response.json();
  const blocks = data.results || [];

  // v173: 用 parseHeadingDate 容錯解析,支援 MM/DD / M/D / M月D日 / MM-DD / M.D 等格式
  const now = new Date();
  const tpe = localWallClock(env, now.getTime()); // 當地牆鐘時間(原 Asia/Taipei UTC+8,改走 env 時區)
  const todayMonth = tpe.getUTCMonth() + 1;
  const todayDay = tpe.getUTCDate();

  // 找所有「日期 heading」
  const dateHeadings: Array<{ idx: number; text: string; isToday: boolean }> = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.type.startsWith('heading_')) continue;
    const c = b[b.type];
    if (!c?.rich_text) continue;
    const t = c.rich_text.map((x: any) => x.plain_text).join('');
    const parsed = parseHeadingDate(t);
    if (!parsed) continue; // 不含日期 → skip
    const isToday = parsed.month === todayMonth && parsed.day === todayDay;
    dateHeadings.push({ idx: i, text: t, isToday });
  }

  // 沒任何日期 heading → 預設整頁掃(保守:當今天)
  // 有日期 heading 但沒今天的 → 今天沒事,回空
  let scanStart = 0;
  let scanEnd = blocks.length;
  if (dateHeadings.length > 0) {
    // v211 方向A:優先用「今天」的 heading;沒有就退而用「最後一個(最近的)日期區段」當今天。
    //   使用者只維護一段滾動式「今日計畫」,常忘了把標題日期改成今天(例還停在 05/29) —
    //   舊版「沒今天 heading 就整天不抓」會讓所有 🔔 靜默失效(7:20 沒提醒就是這原因)。
    //   改用「最後一段」= 不再依賴標題那行日期文字寫對。
    let activeH = dateHeadings.find((h) => h.isToday);
    if (!activeH) {
      activeH = dateHeadings[dateHeadings.length - 1];
      console.log(`[reminders] 無今天 ${todayMonth}/${todayDay} heading,改用最後一個日期區段「${activeH.text}」當今天`);
    }
    scanStart = activeH.idx + 1;
    // 找區段結束(下個 date heading / divider / child_page)
    for (let i = activeH.idx + 1; i < blocks.length; i++) {
      const b = blocks[i];
      // v221: 區段結束只認 divider + 下一個日期 heading。
      //   移除原本「child_page 也算結束」— 使用者常在當天區段內嵌子頁(例當日某子頁),
      //   放在 to_do 清單之前 → 舊邏輯在 child_page 就 break,把整天的 🔔 全切出掃描範圍 → 誤報「沒偵測到提醒」。
      if (b.type === 'divider') { scanEnd = i; break; }
      if (b.type.startsWith('heading_')) {
        const c = b[b.type];
        const t = c?.rich_text?.map((x: any) => x.plain_text).join('') ?? '';
        if (parseHeadingDate(t)) { scanEnd = i; break; } // 下個日期 heading(同樣 fuzzy)
      }
    }
  }

  const results: Array<{ blockId: string; text: string; startTimeMin: number; endTimeMin?: number; callAction?: boolean; queryPlan?: 'today' | 'tomorrow' }> = [];
  for (let bi = scanStart; bi < scanEnd; bi++) {
    const b = blocks[bi];
    const c = b[b.type];
    if (!c?.rich_text) continue;

    // Filter 1: 只認 to_do block(避免 paragraph 多行內容誤判)
    if (b.type !== 'to_do') continue;

    // v119: 先 trim 尾部換行(user 在 Notion 按 Enter 結尾很常見,不該擋)
    const fullText = c.rich_text.map((t: any) => t.plain_text).join('').replace(/\n+$/, '');

    // v174: 若 user 用 Shift+Enter 在同 to_do 加註解(多行 rich_text)→ 取第一行當提醒文字
    //       原本 Filter 3「含 \n 就 reject」會吃掉這類合理寫法(整筆 reminder 永遠進不了 KV)
    //       Real bug case: "🔔11:00 烘焙PPT製作、設計\n-先設計新的PPT\n-讓阿靠開始跑\n-人工同時修正舊的PPT"
    const text = fullText.split('\n')[0];

    // Filter 2: 🔔(一般提醒)或 📞(到點打電話)必須在前 5 字內(避免中間夾的符號)
    // v214: 除了 🔔 也認 📞 — 📞 開頭代表這筆到點要「打電話念內容」而非推 LINE。
    //       兩者走完全相同的時間/長度/勾選 filter,只差「callAction」標記由呼叫端決定怎麼用。
    const bellIdx = text.indexOf('🔔');
    const phoneIdx = text.indexOf('📞');
    const isBell = bellIdx !== -1 && bellIdx <= 5;
    const isPhone = phoneIdx !== -1 && phoneIdx <= 5;
    if (!isBell && !isPhone) continue;

    // Filter 4: 第一行長度 < 80 字(避免把長段落誤判)
    if (text.length > 80) continue;

    // Filter 5: 已勾選的不再提醒
    if (c.checked) continue;

    const range = parseTimeRange(text);
    if (range.start === 0 && parseTimeMin(text) === null) continue;

    // v214: 只要開頭含 📞 就當電話事項(若同時有 🔔 + 📞,以 📞 為準 — 使用者既然打了 📞 就是想要電話)
    // v219: 📞 事項額外偵測查詢型(報今天/明天工作)→ 到點讀計畫念,而非念字面。🔔 不需要。
    results.push({ blockId: b.id, text, startTimeMin: range.start, endTimeMin: range.end ?? undefined, callAction: isPhone || undefined, queryPlan: isPhone ? detectQueryPlan(text) : undefined });
  }
  return results;
}

// 檢查特定 block 在 Notion 上目前狀態(完成?被改?)
// v120: 加回傳 currentText,讓呼叫端在 modified 時可以同步更新 reminder.text
export async function checkBlockStatus(
  env: Env,
  blockId: string,
  originalText: string
): Promise<{ status: 'checked' | 'modified' | 'unchanged' | 'deleted'; currentText?: string }> {
  // v215: 沒有 Notion block(blockId 空)→ 不查 Notion,回 'unchanged'。
  //   來源是「X點打給我」這類 LINE callAction 提醒,沒有對應的 Notion block。
  //   若硬查空 blockId,Notion API 回 404 → 被誤判 'deleted' → 追殺被誤停(resolvedReason='skipped')。
  //   回 'unchanged' 讓追殺迴圈繼續催,直到使用者在 LINE 按「開始/完成」或達 maxCount。
  if (!blockId) return { status: 'unchanged' };
  const response = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
    },
  });
  if (response.status === 404) return { status: 'deleted' };
  if (!response.ok) return { status: 'unchanged' };
  const block: any = await response.json();
  if (block.archived) return { status: 'deleted' };
  if (block.type === 'to_do' && block.to_do?.checked) return { status: 'checked' };
  const currentText = (block[block.type]?.rich_text?.map((t: any) => t.plain_text).join('') ?? '').replace(/\n+$/, '');
  if (currentText !== originalText) return { status: 'modified', currentText };
  return { status: 'unchanged' };
}
