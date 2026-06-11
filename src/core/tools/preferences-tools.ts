/**
 * 偏好設定工具 — 給 Claude 查 / 改使用者偏好
 *
 * 讓 bot 可以:
 * - 使用者問「早安推播何時?」→ 真的查 KV
 * - 使用者說「改成早上 6 點」→ 真的改 KV(cron 會自動讀)
 */

import type { Env } from '../types';
import { getPreferences, setPreferences } from '../preferences/store';

export const PREFERENCES_TOOLS = [
  {
    name: 'get_user_preferences',
    description:
      '查詢使用者目前的偏好設定(早安推播 / 晚間總結 / 拖延偵測 / 卡住告知的開關 + 時間)。' +
      '使用者問「推播何時」「我的設定」「early bird」之類問題 → 用這個查實際 KV,**絕對不要憑記憶答**。',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_user_preferences',
    description:
      '修改使用者偏好設定。使用者說「改成早上 6 點」「早安改 7:30」「晚安推播改 22:30」「關掉早安」等 → 用這個改 KV。' +
      '改完 cron 會自動讀新設定(每 5 分鐘 check 一次)。' +
      'morningBriefHHMM 是台北時間 24 小時制 HH:MM(例:「早上 6 點」→ 06:00,「下午 7 點」→ 19:00)。',
    input_schema: {
      type: 'object',
      properties: {
        morningBriefHHMM: { type: 'string', description: '早安推播時間,格式 HH:MM(24 小時制),例:06:00、07:30' },
        eveningSummaryHHMM: { type: 'string', description: '晚間總結時間,格式 HH:MM,例:22:00、23:00' },
        morningBriefEnabled: { type: 'boolean', description: '早安推播 開/關' },
        eveningSummaryEnabled: { type: 'boolean', description: '晚間總結 開/關' },
        procrastinationDetectionEnabled: { type: 'boolean', description: '拖延偵測 開/關' },
        stuckAlertEnabled: { type: 'boolean', description: '卡住告知 開/關' },
      },
    },
  },
];

export async function executePreferencesTool(
  env: Env,
  toolName: string,
  input: any,
  userId?: string
): Promise<string> {
  if (!userId) return '錯誤:沒有 userId';

  if (toolName === 'get_user_preferences') {
    const p = await getPreferences(env, userId);
    return JSON.stringify(p, null, 2);
  }

  if (toolName === 'set_user_preferences') {
    // 過濾 undefined/null 欄位
    const patch: any = {};
    for (const key of [
      'morningBriefHHMM',
      'eveningSummaryHHMM',
      'morningBriefEnabled',
      'eveningSummaryEnabled',
      'procrastinationDetectionEnabled',
      'stuckAlertEnabled',
    ]) {
      if (input[key] !== undefined && input[key] !== null) {
        patch[key] = input[key];
      }
    }
    if (Object.keys(patch).length === 0) {
      return '沒有給任何要改的欄位';
    }
    const updated = await setPreferences(env, userId, patch);
    return `✓ 偏好已更新:\n${JSON.stringify(patch, null, 2)}\n\n當前完整偏好:\n${JSON.stringify(updated, null, 2)}`;
  }

  return `Unknown tool: ${toolName}`;
}
