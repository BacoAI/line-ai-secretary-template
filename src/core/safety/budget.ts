/**
 * 燒錢防護 — 預算與成本管理
 *
 * 三道防線:
 * 1. 月度硬性上限(MONTHLY_BUDGET_USD)
 *    超過直接拒絕請求,bot 推訊息告知使用者
 *
 * 2. 單次任務上限(SINGLE_TASK_CONFIRMATION_USD)
 *    估計成本超過閾值,強制問使用者確認
 *
 * 3. 迴圈偵測(LOOP_DETECTION_THRESHOLD)
 *    同任務 1 小時內觸發超過 N 次,自動暫停
 *
 * Claude 模型費用(2026 年參考價,可能變動):
 * - Haiku 4.5:  $1 / 5 per 1M (input/output)
 * - Sonnet 4.6: $3 / 15 per 1M
 * - Opus 4.7:   $15 / 75 per 1M
 *
 * Cached input:約原價 10%
 */

import type { Env, ClaudeModel } from '../types';

// === 模型費率(USD per 1M tokens)===
export const MODEL_RATES: Record<ClaudeModel, { input: number; output: number; cached: number }> = {
  'claude-haiku-4-5':   { input: 1,   output: 5,   cached: 0.1 },
  'claude-sonnet-4-6':  { input: 3,   output: 15,  cached: 0.3 },
  'claude-opus-4-7':    { input: 15,  output: 75,  cached: 1.5 },
};

/**
 * 計算單次 Claude 呼叫的成本
 * v118: 修兩個 bug —
 *   1. Anthropic API 的 input_tokens 已不含 cache read/write,之前再減 cachedTokens 是 double subtract
 *   2. cache_creation_input_tokens(cache write)漏算 — 它是 normal input × 1.25 倍
 */
export function calculateClaudeCost(
  model: ClaudeModel,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number = 0,
  cacheWriteTokens: number = 0
): number {
  const rates = MODEL_RATES[model];
  const cacheWriteRate = rates.input * 1.25;

  return (
    (inputTokens / 1_000_000) * rates.input +
    (cachedTokens / 1_000_000) * rates.cached +
    (cacheWriteTokens / 1_000_000) * cacheWriteRate +
    (outputTokens / 1_000_000) * rates.output
  );
}

/**
 * 取得本月累積成本
 */
export async function getMonthlyCost(env: Env, userId?: string): Promise<number> {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const startStr = startOfMonth.toISOString();

  const result = await env.DB.prepare(
    userId
      ? `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_log
         WHERE user_id = ? AND created_at >= ?`
      : `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_log
         WHERE created_at >= ?`
  )
    .bind(...(userId ? [userId, startStr] : [startStr]))
    .first<{ total: number }>();

  return result?.total ?? 0;
}

/**
 * 取得某使用者「今天」(Taipei 日界)累積成本。
 * 給「per 小孩每日聊天上限」用 —— 跨午夜自動歸零。
 * 註:硬編 +8 時區(Asia/Taipei 無 DST);此 bot 鎖台北,夠用且免 tz 函式庫。
 */
export async function getDailyCost(env: Env, userId: string): Promise<number> {
  const TPE_OFFSET_MS = 8 * 60 * 60 * 1000;
  const tpeNow = new Date(Date.now() + TPE_OFFSET_MS); // 平移後用 UTC getter 讀到的是台北牆鐘
  const startUtcMs =
    Date.UTC(tpeNow.getUTCFullYear(), tpeNow.getUTCMonth(), tpeNow.getUTCDate()) - TPE_OFFSET_MS;
  const startStr = new Date(startUtcMs).toISOString();

  const result = await env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_log
     WHERE user_id = ? AND created_at >= ?`
  )
    .bind(userId, startStr)
    .first<{ total: number }>();

  return result?.total ?? 0;
}

/**
 * 檢查是否在預算內
 * 回傳 true = OK,false = 超預算
 */
export async function isWithinBudget(env: Env, userId?: string): Promise<boolean> {
  const monthlyCost = await getMonthlyCost(env, userId);
  const limit = parseFloat(env.MONTHLY_BUDGET_USD);
  return monthlyCost < limit;
}

/**
 * 單次任務確認:估計成本超過閾值 → 需要確認
 */
export function needsConfirmation(estimatedCostUsd: number, env: Env): boolean {
  const threshold = parseFloat(env.SINGLE_TASK_CONFIRMATION_USD);
  return estimatedCostUsd >= threshold;
}

/**
 * 迴圈偵測:同任務 1 小時內觸發次數
 */
export async function getTaskTriggerCount(
  env: Env,
  taskContext: string,
  windowMinutes: number = 60
): Promise<number> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  const result = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM cost_log
     WHERE task_context = ? AND created_at >= ?`
  )
    .bind(taskContext, since)
    .first<{ cnt: number }>();

  return result?.cnt ?? 0;
}

/**
 * 檢查是否觸發迴圈
 */
export async function isLooping(env: Env, taskContext: string): Promise<boolean> {
  const count = await getTaskTriggerCount(env, taskContext);
  const threshold = parseInt(env.LOOP_DETECTION_THRESHOLD);
  return count >= threshold;
}

/**
 * 紀錄一筆成本
 */
export async function logCost(
  env: Env,
  params: {
    userId?: string;
    service: 'anthropic' | 'twilio' | 'line_push' | 'notion' | 'other';
    operation?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    callDurationSeconds?: number;
    costUsd: number;
    taskContext?: string;
  }
): Promise<void> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO cost_log
     (id, user_id, service, operation, model, input_tokens, output_tokens, cached_tokens,
      call_duration_seconds, cost_usd, task_context, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      params.userId ?? null,
      params.service,
      params.operation ?? null,
      params.model ?? null,
      params.inputTokens ?? null,
      params.outputTokens ?? null,
      params.cachedTokens ?? null,
      params.callDurationSeconds ?? null,
      params.costUsd,
      params.taskContext ?? null,
      new Date().toISOString()
    )
    .run();
}

/**
 * 完整的「預算檢查 + 動作」wrapper
 *
 * 用法:
 *   const result = await guardedAction(env, 'morning-brief-user-123', async () => {
 *     return await someApiCall();
 *   });
 *   if (!result.allowed) { ... 告訴使用者超預算/迴圈 ... }
 */
export async function guardedAction<T>(
  env: Env,
  taskContext: string,
  action: () => Promise<T>
): Promise<{ allowed: boolean; result?: T; reason?: string }> {
  // 1. 月度預算
  if (!(await isWithinBudget(env))) {
    return {
      allowed: false,
      reason: `本月預算已達上限 USD$${env.MONTHLY_BUDGET_USD},bot 將暫停運作直到下月或你提高上限`,
    };
  }

  // 2. 迴圈偵測
  if (await isLooping(env, taskContext)) {
    return {
      allowed: false,
      reason: `偵測到迴圈:任務「${taskContext}」1 小時內觸發超過 ${env.LOOP_DETECTION_THRESHOLD} 次,已暫停`,
    };
  }

  // 通過,執行。v226(Phase3 審查):包 try-catch — action 拋錯時回 allowed:false,
  //   不外拋(讓 guard 自包含;呼叫端如 chat() 會因 !allowed 回 null → 乾淨降級)。
  try {
    const result = await action();
    return { allowed: true, result };
  } catch (e: any) {
    console.error(`[guard] action 執行失敗 (${taskContext}):`, e?.message ?? e);
    return { allowed: false, reason: `執行失敗:${e?.message ?? e}` };
  }
}
