/**
 * Notion 查詢工具(給 Claude 用)
 *
 * 提供 2 個工具給 Claude:
 * - search_notion: 搜尋頁面標題
 * - read_notion_page: 讀指定頁面內容
 *
 * Claude 看到使用者問「我 5 月評等如何」時,會:
 * 1. search_notion("工作記錄 5") → 找到頁面 ID
 * 2. read_notion_page(id) → 讀內容
 * 3. 整理回應
 */

import type { Env } from '../types';

export const NOTION_TOOLS = [
  {
    name: 'search_notion',
    description:
      '搜尋使用者 Notion workspace 內的頁面標題。返回相符的頁面 ID + 標題。' +
      '當使用者問及過去的工作記錄、會議、課程等需要從 Notion 找頁面時使用。' +
      '常見頁面:工作記錄(每月)、運動體重記錄、課程相關、會議記錄等。',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜尋關鍵字,例如「工作記錄 5 月」「會議記錄」',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_notion_page',
    description:
      '讀取 Notion 頁面的內容。會自動分頁讀完整頁(最多 300 個 block / 30000 字)。' +
      '回傳內容包含每一行,heading 以 ## 標示。請完整檢視整份回傳內容再回答,' +
      '不要看到開頭幾段就下結論說「沒有 X」 — 找不到時用 Ctrl-F 思維檢索整段。' +
      '先用 search_notion 取得 page_id,再用這個工具讀內容。',
    input_schema: {
      type: 'object',
      properties: {
        page_id: {
          type: 'string',
          description: 'Notion 頁面 ID(從 search_notion 回傳的 ID)',
        },
      },
      required: ['page_id'],
    },
  },
];

/**
 * 執行 Notion 工具呼叫
 */
export async function executeNotionTool(
  env: Env,
  toolName: string,
  input: any
): Promise<string> {
  if (toolName === 'search_notion') {
    return await searchNotion(env, input.query);
  }
  if (toolName === 'read_notion_page') {
    return await readNotionPage(env, input.page_id);
  }
  return `Unknown tool: ${toolName}`;
}

async function searchNotion(env: Env, query: string): Promise<string> {
  const response = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      query,
      page_size: 10,
      filter: { property: 'object', value: 'page' },
    }),
  });

  if (!response.ok) {
    return `搜尋失敗: ${response.status}`;
  }

  const data: any = await response.json();
  const results = data.results || [];

  if (results.length === 0) {
    return `找不到「${query}」相關頁面`;
  }

  const lines = results.map((r: any) => {
    let title = '(無標題)';
    const props = r.properties || {};
    for (const v of Object.values(props) as any[]) {
      if (v?.type === 'title' && v.title?.length > 0) {
        title = v.title.map((t: any) => t.plain_text).join('');
        break;
      }
    }
    const lastEdit = (r.last_edited_time || '').slice(0, 10);
    return `- ${title} | id: ${r.id} | edited: ${lastEdit}`;
  });

  return `找到 ${results.length} 個頁面:\n${lines.join('\n')}`;
}

/**
 * 判斷一行文字「整行就是一個日期標記」(如「6/4(四)」「06/03　星期三」「5月6日」)。
 * 用途:把 paragraph 形式的日期標記升級成 heading,讓日期分段邏輯認得 = 一天的分界。
 * 嚴格錨定 + 限長,避免把「5/26 要交報告」這種含日期的待辦誤判成日期標記。
 * 通用設計:學員的日期寫法不一(heading/paragraph、MM/DD、中文月日),都儘量認得。
 */
function isDateMarkerLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 14) return false;
  const suffix = '(?:[(（]\\s*[一二三四五六日]\\s*[)）]|星期[一二三四五六日]|[週周][一二三四五六日])?';
  // MM/DD(可選 星期X / 週X / (X))
  if (new RegExp(`^\\d{1,2}\\s*[/／]\\s*\\d{1,2}\\s*${suffix}$`).test(t)) return true;
  // 中文 N月N日
  if (new RegExp(`^\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]\\s*${suffix}$`).test(t)) return true;
  return false;
}

async function readNotionPage(env: Env, pageId: string): Promise<string> {
  // v211: 分頁讀完整頁(最多 10 頁 = 1000 blocks) — 舊版 3 頁(300)會把頁面底部的
  //        「每天固定/每月固定」等區段整段截掉(今日計畫頁有 350+ blocks),導致 Claude 看不到。
  let cursor: string | undefined;
  const allBlocks: any[] = [];
  for (let page = 0; page < 10; page++) {
    const url = new URL(`https://api.notion.com/v1/blocks/${pageId}/children`);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    });

    if (!response.ok) {
      return `讀取失敗: ${response.status}`;
    }
    const data: any = await response.json();
    allBlocks.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }

  const lines: string[] = [];
  for (const block of allBlocks) {
    const type = block.type;
    const content = block[type];
    const blockId = block.id;
    if (content?.rich_text) {
      const text = content.rich_text.map((t: any) => t.plain_text).join('');
      if (text.trim()) {
        const idSuffix = ` [block:${blockId}]`;
        if (type.startsWith('heading_')) {
          lines.push(`\n## ${text}${idSuffix}`);
        } else if (type === 'to_do') {
          const checked = content.checked ? '✓' : '☐';
          lines.push(`${checked} ${text}${idSuffix}`);
        } else if (type === 'bulleted_list_item' || type === 'numbered_list_item') {
          lines.push(`- ${text}${idSuffix}`);
        } else if (type === 'toggle') {
          lines.push(`▸ ${text}${idSuffix}`);
        } else if (isDateMarkerLine(text)) {
          // v229: paragraph 形式的日期標記(如「6/4(四)」)升級成 heading,讓「找今天 heading」
          //       分段邏輯認得它是一天的分界(否則前一天的體重/天氣會被誤算成今天的)。
          //       用 trim():paragraph 文字常帶前後換行,不清掉會變「## (換行) 日期」破壞 heading。
          lines.push(`\n## ${text.trim()}${idSuffix}`);
        } else {
          lines.push(`${text}${idSuffix}`);
        }
      }
    }
    // v211: 展開 toggle 內容 — 每天固定(星期X)、每月固定(N號前)的實際內容都在 toggle 子層,
    //        舊版只讀頂層 → 只看到 toggle 標題、看不到內容。對有子層的 toggle 抓一層子內容(縮排呈現)。
    if (block.type === 'toggle' && block.has_children) {
      try {
        const cResp = await fetch(`https://api.notion.com/v1/blocks/${block.id}/children?page_size=100`, {
          headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' },
        });
        if (cResp.ok) {
          const cData: any = await cResp.json();
          for (const cb of (cData.results || [])) {
            const cc = cb[cb.type];
            if (!cc?.rich_text) continue;
            const ctext = cc.rich_text.map((t: any) => t.plain_text).join('');
            if (!ctext.trim()) continue;
            const cPrefix = cb.type === 'to_do' ? (cc.checked ? '    ✓ ' : '    ☐ ') : '    · ';
            lines.push(`${cPrefix}${ctext} [block:${cb.id}]`);
          }
        }
      } catch { /* toggle 子層讀取失敗就略過,不影響其餘 */ }
    }
  }

  if (lines.length === 0) {
    return '頁面是空的';
  }
  // 開頭強制塞 heading 目錄 — Claude 看到列表就知道有哪些段,不會看前段就誤判「沒有 X」
  const headings = lines
    .filter((l) => l.startsWith('\n## '))
    .map((l) => l.trim().replace(/ \[block:[^\]]+\]$/, '').replace(/^## /, ''));
  const toc = headings.length > 0
    ? `[本頁 heading 目錄,共 ${headings.length} 段 — 回答前先掃這份目錄,確認問題對應段是否存在]\n${headings.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\n[完整內容]\n`
    : '';

  const joined = toc + lines.join('\n');
  // 字數上限 80000(夠塞 50+ 個 md 檔的同步頁)
  if (joined.length > 80000) {
    return joined.substring(0, 80000) +
      `\n\n[註:頁面太長(${allBlocks.length} 個 block / ${joined.length} 字),內容已截至前 80000 字。` +
      `若使用者問的段在開頭目錄裡但內容沒拿到,告訴使用者「這段在頁面後段被截掉,我要另外查」,不要說「找不到」`;
  }
  return joined;
}
