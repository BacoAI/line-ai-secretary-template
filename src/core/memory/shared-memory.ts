/**
 * AI 共享記憶 — 讀取 Notion 上的「對使用者的理解」
 *
 * 每次對話前讀取 4 個 Notion 頁面,組合成 context 塞進 system prompt
 *
 * 用 KV cache 5 分鐘,避免每次都打 Notion API
 */

import type { Env } from '../types';
import { isOwner, isInternalMode } from '../config/runtime-config';

const CACHE_TTL_SECONDS = 300; // 5 分鐘

export async function loadSharedMemory(env: Env, userId?: string): Promise<string> {
  // internal 模式(不接 Notion)→ 不讀 Notion 共享記憶頁。否則 owner 在 internal 測試、env 仍帶
  //   NOTION_*_PAGE 時,每則訊息 / 每 5 分鐘 cache miss 會誤打 api.notion.com。
  if (isInternalMode(env)) return '';
  // 記憶隔離(feature 2 多使用者):共享記憶來源是「開發者本人的 Notion 頁」(寫死在 env)。
  //   只有開發者本人載入;其他任何使用者(學員擁有者、被綁定的小孩…)沒有自己的記憶來源,
  //   一律回空字串,【絕不】fallback 到開發者的 Notion 記憶 → 避免跨人記憶污染。
  if (!(await isOwner(env, userId || ''))) {
    return '';
  }
  const cacheKey = `shared-memory:${userId}`;

  // 試 KV 快取
  if (env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey);
      if (cached) return cached;
    } catch (e) {
      console.warn('KV cache read failed:', e);
    }
  }

  // 沒快取 → 從 Notion 讀
  // 注意:記憶同步頁可能很大(數萬字),不塞進 system prompt(會爆 rate limit)
  // 改成「需要時用 read_notion_page 查」,而非每次對話都載入
  const pages = [
    { id: env.NOTION_PROFILE_PAGE, label: '個人檔案' },
    { id: env.NOTION_PROJECTS_PAGE, label: '進行中專案' },
    { id: env.NOTION_OBSERVATIONS_PAGE, label: 'AI 觀察' },
    { id: env.NOTION_RECENT_PAGE, label: '最近 7 天重點' },
  ].filter((p) => p.id);

  const sections = await Promise.all(
    pages.map(async (p) => {
      try {
        const text = await readPageContent(env, p.id!);
        return `\n=== ${p.label} ===\n${text}`;
      } catch (e: any) {
        console.warn(`Failed to load ${p.label}:`, e);
        return `\n=== ${p.label} ===\n(讀取失敗)`;
      }
    })
  );

  const combined = sections.join('\n');

  // 寫進 KV 快取
  if (env.CACHE) {
    try {
      await env.CACHE.put(cacheKey, combined, { expirationTtl: CACHE_TTL_SECONDS });
    } catch (e) {
      console.warn('KV cache write failed:', e);
    }
  }

  return combined;
}

async function readPageContent(env: Env, pageId: string): Promise<string> {
  const response = await fetch(
    `https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`,
    {
      headers: {
        'Authorization': `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Notion API ${response.status}`);
  }

  const data: any = await response.json();
  const lines: string[] = [];
  for (const block of data.results || []) {
    const type = block.type;
    const content = block[type];
    if (content?.rich_text) {
      const text = content.rich_text.map((t: any) => t.plain_text).join('');
      if (text.trim()) {
        if (type.startsWith('heading_')) {
          lines.push(`\n# ${text}`);
        } else if (type === 'bulleted_list_item') {
          lines.push(`- ${text}`);
        } else {
          lines.push(text);
        }
      }
    }
  }
  return lines.join('\n');
}
