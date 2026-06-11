/**
 * Claude API 整合層
 *
 * 用 native fetch 直接呼叫 Anthropic API,避開 SDK 可能的 CF Workers 相容性問題
 */

import type { Env, ClaudeModel } from '../types';
import { calculateClaudeCost, guardedAction, logCost } from '../safety/budget';

export interface ChatOptions {
  taskContext: string;
  userId?: string;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: ClaudeModel;
  taskType?: 'simple' | 'normal' | 'deep';
  maxTokens?: number;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  model: ClaudeModel;
}

function pickModel(taskType: 'simple' | 'normal' | 'deep' = 'normal'): ClaudeModel {
  switch (taskType) {
    case 'simple': return 'claude-haiku-4-5';
    case 'deep':   return 'claude-opus-4-7';
    default:       return 'claude-sonnet-4-6';
  }
}

export async function chat(env: Env, opts: ChatOptions): Promise<ChatResult | null> {
  // v226(Phase3 審查):缺 key → 直接回 null(符合契約「缺 key 回 null」,避免白打一次 401)。
  //   商品化:學員沒設 ANTHROPIC_API_KEY 時,呼叫端自動降級(如 NFC 清單退回 keyword)。
  if (!env.ANTHROPIC_API_KEY) {
    console.warn('[Claude] ANTHROPIC_API_KEY 未設,跳過 AI 呼叫(降級)');
    return null;
  }
  const model = opts.model ?? pickModel(opts.taskType);

  const guard = await guardedAction(env, opts.taskContext, async () => {
    const requestBody = {
      model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: opts.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    console.log(`[Claude] Calling ${model} with ${opts.messages.length} messages`);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Claude] API error ${response.status}:`, errorText);
      throw new Error(`Claude API ${response.status}: ${errorText}`);
    }

    const data: any = await response.json();
    const usage = data.usage || {};
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cachedTokens = usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;

    // v118: 修漏算 cache write tokens
    const costUsd = calculateClaudeCost(model, inputTokens, outputTokens, cachedTokens, cacheWriteTokens);

    await logCost(env, {
      userId: opts.userId,
      service: 'anthropic',
      operation: 'chat',
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      taskContext: opts.taskContext,
    });

    // 取出文字
    const textContent = (data.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');

    console.log(`[Claude] Reply: ${textContent.substring(0, 100)}...`);

    return {
      text: textContent,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      model,
    };
  });

  if (!guard.allowed) {
    console.warn('[Claude] Blocked:', guard.reason);
    return null;
  }

  return guard.result ?? null;
}
