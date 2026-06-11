/**
 * Claude API + Tool Use loop
 *
 * 功能:
 * 1. 給 Claude 一組 tools(如 Notion 查詢、上網搜尋)
 * 2. Claude 自行決定要不要呼叫 tool
 * 3. 我們執行 tool → 把結果傳回 → Claude 整合回應
 * 4. 處理多輪 tool 呼叫(Claude 可能連續用多個工具)
 *
 * 安全限制:
 * - 最多 5 輪 tool use(避免無限迴圈)
 * - 每輪都檢查預算
 */

import type { Env, ClaudeModel } from '../types';
import { calculateClaudeCost, guardedAction, logCost } from '../safety/budget';
import { NOTION_TOOLS, executeNotionTool } from '../tools/notion-tools';
import { NOTION_WRITE_TOOLS, executeNotionWriteTool } from '../tools/notion-write-tools';
import { TAVILY_TOOLS, executeTavilyTool } from '../tools/tavily-tools';
import { PREFERENCES_TOOLS, executePreferencesTool } from '../tools/preferences-tools';
import { OUTING_TOOLS, OUTING_TOOL_NAMES, executeOutingTool } from '../tools/outing-tools';
import { PLANNING_TOOLS, PLANNING_TOOL_NAMES, executePlanningTool } from '../tools/planning-tools';
import { WEATHER_TOOLS, executeWeatherTool } from '../tools/weather-tools';
import { FAMILY_TOOLS, FAMILY_TOOL_NAMES, executeFamilyTool } from '../tools/family-tools';
import { isInternalMode } from '../config/runtime-config';

const MAX_TOOL_ROUNDS = 5;

// internal 模式(不接 Notion)要從工具表拿掉的工具:search/read Notion、所有 Notion 寫入、排工作。
// Claude 看不到 = 不會呼叫,根因處關掉,避免「給了工具一呼叫就 401」。
const NOTION_DEPENDENT_TOOL_NAMES = new Set<string>([
  ...NOTION_TOOLS.map((t) => t.name),
  ...NOTION_WRITE_TOOLS.map((t) => t.name),
  ...PLANNING_TOOL_NAMES,
]);

export interface ChatToolsOptions {
  taskContext: string;
  userId: string;
  system: string;
  history: Array<{ role: string; content: string }>;
  userMessage: string;
  model?: ClaudeModel;
  maxTokens?: number;
  // v117: extended thinking budget(0 = 關閉);Sonnet/Opus 支援,Haiku 不啟用
  thinkingBudget?: number;
  // v132: 圖片支援 — Phase 1 純 OCR / 看圖回覆
  imageBase64?: string;
  imageMediaType?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  // v229: 工具白名單 — 只給名單內的工具(未成年限制路徑用,只開放提醒工具)。不給=全部工具
  allowedToolNames?: Set<string>;
}

export interface ChatToolsResult {
  text: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  toolCalls: number;
  rounds: number;
  blockedReason?: string; // 若被預算/迴圈擋下,帶原因
}

/**
 * 跟 Claude 對話,支援 tool use
 */
export async function chatWithTools(
  env: Env,
  opts: ChatToolsOptions
): Promise<ChatToolsResult> {
  const model: ClaudeModel = opts.model ?? 'claude-sonnet-4-6';
  const allTools = [
    ...NOTION_TOOLS,
    ...NOTION_WRITE_TOOLS,
    ...PREFERENCES_TOOLS,
    ...OUTING_TOOLS,
    ...PLANNING_TOOLS,
    ...WEATHER_TOOLS,
    ...FAMILY_TOOLS,
    ...(env.TAVILY_API_KEY ? TAVILY_TOOLS : []),
  ];
  // internal 模式:先濾掉依賴 Notion 的工具(根因處關門,Claude 看不到就不會呼叫)
  const modeFiltered = isInternalMode(env)
    ? allTools.filter((t) => !NOTION_DEPENDENT_TOOL_NAMES.has(t.name))
    : allTools;
  // v229: 未成年限制路徑只給白名單內的工具(其餘工具 Claude 根本看不到,無從呼叫)
  const tools = opts.allowedToolNames
    ? modeFiltered.filter((t) => opts.allowedToolNames!.has(t.name))
    : modeFiltered;

  // 初始 messages
  // v132: 若有圖片,user content 改 multimodal array(image block + text block)
  const userContent: any = opts.imageBase64
    ? [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: opts.imageMediaType ?? 'image/jpeg',
            data: opts.imageBase64,
          },
        },
        { type: 'text', text: opts.userMessage },
      ]
    : opts.userMessage;

  let messages: any[] = [
    ...opts.history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userContent },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let toolCalls = 0;
  let finalText = '';

  console.log(`[claude-tools] Available tools: ${tools.map((t) => t.name).join(', ')}`);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    console.log(`[claude-tools] Round ${round + 1}, ${messages.length} messages`);

    // 燒錢防護
    const guard = await guardedAction(
      env,
      `${opts.taskContext}-round-${round}`,
      async () => {
        // Prompt caching:system + tools 標 cache_control,5 分鐘 TTL
        // 第二次起 cache hit → input tokens 只算 10%(省 rate limit + 70% 成本)
        const cachedSystem = [
          { type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } },
        ];
        const cachedTools = tools.map((t, i) => {
          // 最後一個 tool 加 cache_control(讓 tools 整段被 cache)
          if (i === tools.length - 1) {
            return { ...t, cache_control: { type: 'ephemeral' } };
          }
          return t;
        });

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            // v117: 開 thinking 時 max_tokens 必須 ≥ thinkingBudget + 預期 output
            max_tokens:
              (opts.thinkingBudget ?? 0) > 0
                ? Math.max(opts.maxTokens ?? 800, (opts.thinkingBudget ?? 0) + 2000)
                : opts.maxTokens ?? 800,
            system: cachedSystem,
            tools: cachedTools,
            messages,
            // v117: extended thinking(Sonnet/Opus 支援);Haiku 跳過
            ...((opts.thinkingBudget ?? 0) > 0 && model !== 'claude-haiku-4-5'
              ? { thinking: { type: 'enabled', budget_tokens: opts.thinkingBudget } }
              : {}),
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Claude API ${response.status}: ${errText.substring(0, 300)}`);
        }
        return await response.json();
      }
    );

    if (!guard.allowed) {
      console.warn('[claude-tools] Blocked:', guard.reason);
      return {
        text: '',
        totalInputTokens,
        totalOutputTokens,
        totalCostUsd,
        toolCalls,
        rounds: round,
        blockedReason: guard.reason,
      };
    }

    const data: any = guard.result;
    const usage = data.usage || {};
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cachedTokens = usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
    // v118: 修漏算 cache write tokens
    const costUsd = calculateClaudeCost(model, inputTokens, outputTokens, cachedTokens, cacheWriteTokens);
    console.log(`[claude-tools] tokens in=${inputTokens} cached=${cachedTokens} write=${cacheWriteTokens} out=${outputTokens} cost=$${costUsd.toFixed(4)}`);

    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalCostUsd += costUsd;

    await logCost(env, {
      userId: opts.userId,
      service: 'anthropic',
      operation: `chat-round-${round}`,
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      taskContext: opts.taskContext,
    });

    const stopReason = data.stop_reason;
    const contentBlocks = data.content || [];

    console.log(`[claude-tools] Round ${round + 1} stop_reason: ${stopReason}, blocks: ${contentBlocks.map((b: any) => b.type).join(',')}`);

    // 取出文字內容
    const textBlocks = contentBlocks.filter((b: any) => b.type === 'text');
    finalText = textBlocks.map((b: any) => b.text).join('\n');

    // 取出 tool_use 區塊
    const toolUseBlocks = contentBlocks.filter((b: any) => b.type === 'tool_use');

    if (stopReason !== 'tool_use' || toolUseBlocks.length === 0) {
      // 沒要用工具 → 結束
      console.log(`[claude-tools] Done in ${round + 1} rounds, ${toolCalls} tool calls`);
      break;
    }

    // 有要用工具 → 執行
    console.log(`[claude-tools] Round ${round + 1}: ${toolUseBlocks.length} tool calls`);

    // 把 assistant 的訊息加進歷史(包含 tool_use)
    messages.push({ role: 'assistant', content: contentBlocks });

    // 執行每個工具 + 收集結果
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (tb: any) => {
        toolCalls++;
        console.log(`[tool] ${tb.name}(${JSON.stringify(tb.input).substring(0, 100)})`);
        let result: string;
        try {
          if (tb.name === 'search_notion' || tb.name === 'read_notion_page') {
            result = await executeNotionTool(env, tb.name, tb.input);
          } else if (
            tb.name === 'add_to_today' ||
            tb.name === 'add_to_date' ||
            tb.name === 'append_to_page' ||
            tb.name === 'update_block' ||
            tb.name === 'delete_block' ||
            tb.name === 'propose_batch_action' ||
            tb.name === 'update_field_value' ||
            tb.name === 'mark_block_done' ||
            tb.name === 'mark_block_undone'
          ) {
            result = await executeNotionWriteTool(env, tb.name, tb.input, opts.userId);
          } else if (
            tb.name === 'get_user_preferences' ||
            tb.name === 'set_user_preferences'
          ) {
            result = await executePreferencesTool(env, tb.name, tb.input, opts.userId);
          } else if (OUTING_TOOL_NAMES.has(tb.name)) {
            result = await executeOutingTool(env, tb.name, tb.input, opts.userId);
          } else if (PLANNING_TOOL_NAMES.has(tb.name)) {
            result = await executePlanningTool(env, tb.name, tb.input, opts.userId);
          } else if (tb.name === 'get_weather' || tb.name === 'set_weather_location') {
            result = await executeWeatherTool(env, tb.name, tb.input, opts.userId);
          } else if (FAMILY_TOOL_NAMES.has(tb.name)) {
            result = await executeFamilyTool(env, tb.name, tb.input, opts.userId);
          } else if (tb.name === 'web_search') {
            result = await executeTavilyTool(env, tb.name, tb.input);
          } else {
            result = `Unknown tool: ${tb.name}`;
          }
        } catch (e: any) {
          result = `Tool error: ${e.message ?? e}`;
        }
        return {
          type: 'tool_result',
          tool_use_id: tb.id,
          content: result.substring(0, 10000),
        };
      })
    );

    // 把 tool_results 加進 messages,繼續下一輪
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    text: finalText,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    toolCalls,
    rounds: 0, // 簡化
  };
}
