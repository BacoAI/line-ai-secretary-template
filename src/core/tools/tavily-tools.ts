/**
 * Tavily 上網搜尋工具(給 Claude 用)
 *
 * 一個工具:web_search
 * Claude 看到需要即時資訊(天氣、新聞、查事實)時觸發
 */

import type { Env } from '../types';

export const TAVILY_TOOLS = [
  {
    name: 'web_search',
    description:
      '上網搜尋即時資訊。當需要查天氣、新聞、最新事件、不確定的事實時使用。' +
      '不要用於使用者個人資料(那應該查 Notion)。',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜尋查詢,用簡短關鍵字',
        },
      },
      required: ['query'],
    },
  },
];

export async function executeTavilyTool(
  env: Env,
  toolName: string,
  input: any
): Promise<string> {
  if (toolName !== 'web_search') return `Unknown tool: ${toolName}`;
  if (!env.TAVILY_API_KEY) return '上網功能未啟用(TAVILY_API_KEY 未設定)';

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query: input.query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: true,
    }),
  });

  if (!response.ok) {
    return `搜尋失敗: ${response.status} ${await response.text()}`;
  }

  const data: any = await response.json();

  let result = '';
  if (data.answer) {
    result += `【快答】${data.answer}\n\n`;
  }
  if (data.results && data.results.length > 0) {
    result += '【相關來源】\n';
    for (const r of data.results.slice(0, 5)) {
      result += `- ${r.title}\n  ${r.url}\n  ${(r.content || '').substring(0, 200)}\n\n`;
    }
  }

  return result || '沒有搜尋結果';
}
