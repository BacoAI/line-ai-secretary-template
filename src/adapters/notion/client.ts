/**
 * Notion API 包裝層
 *
 * 提供統一介面給 3 種儲存模式:
 * - internal: 不使用 Notion(只用共享記憶)
 * - notion-new: bot 建立並管理新 DB
 * - notion-existing: 對應使用者既有的 DB
 *
 * 共享記憶(NOTION_SHARED_MEMORY_PAGE_ID)所有模式都會用,
 * 因為這是「跨裝置 AI 一致性」的關鍵。
 */

import { Client } from '@notionhq/client';
import type { Env } from '../../core/types';

/**
 * 建立 Notion client
 */
export function createNotionClient(env: Env): Client {
  return new Client({
    auth: env.NOTION_TOKEN,
  });
}

/**
 * 從共享記憶頁面讀取子頁面內容
 * 用於 LINE Bot 跟 Mac Claude Code 共用「對使用者的理解」
 */
export async function readSharedMemoryPage(
  env: Env,
  pageId: string
): Promise<string> {
  const client = createNotionClient(env);
  const blocks = await client.blocks.children.list({
    block_id: pageId,
    page_size: 100,
  });

  // 把所有 block 的文字串起來
  const texts: string[] = [];
  for (const block of blocks.results as any[]) {
    const type = block.type;
    const content = block[type];
    if (content?.rich_text) {
      texts.push(content.rich_text.map((t: any) => t.plain_text).join(''));
    }
  }
  return texts.join('\n');
}

/**
 * 寫入或更新共享記憶
 * 用 append-only 模式:加新段,不覆蓋舊的(保留 AI 學習軌跡)
 */
export async function appendToSharedMemory(
  env: Env,
  pageId: string,
  category: 'observation' | 'preference' | 'pattern' | 'project',
  content: string
): Promise<void> {
  const client = createNotionClient(env);
  const timestamp = new Date().toISOString();
  await client.blocks.children.append({
    block_id: pageId,
    children: [
      {
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: { content: `[${timestamp}] [${category}] ${content}` },
            },
          ],
        },
      },
    ],
  });
}

/**
 * 查詢任務 DB(模式 B/C 用)
 */
export async function queryTaskDb(
  env: Env,
  dbId: string,
  filter?: any
): Promise<any[]> {
  const client = createNotionClient(env);
  const response = await client.databases.query({
    database_id: dbId,
    filter,
    page_size: 100,
  });
  return response.results;
}

/**
 * 在 Notion 任務 DB 新增一筆任務(模式 B 用)
 */
export async function createTaskInNotion(
  env: Env,
  dbId: string,
  task: {
    title: string;
    status?: string;
    priority?: string;
    startTime?: string;
    endTime?: string;
    type?: string;
    project?: string;
    notes?: string;
  }
): Promise<string> {
  const client = createNotionClient(env);

  const properties: any = {
    任務名稱: { title: [{ text: { content: task.title } }] },
  };

  if (task.status) {
    properties.狀態 = { select: { name: task.status } };
  }
  if (task.priority) {
    properties.優先級 = { select: { name: task.priority } };
  }
  if (task.startTime) {
    properties.時間區段 = {
      date: { start: task.startTime, end: task.endTime ?? undefined },
    };
  }
  if (task.type) {
    properties.類型 = { select: { name: task.type } };
  }
  if (task.project) {
    properties.專案 = { rich_text: [{ text: { content: task.project } }] };
  }
  if (task.notes) {
    properties.備註 = { rich_text: [{ text: { content: task.notes } }] };
  }
  properties.來源 = { select: { name: 'LINE Bot' } };

  const page = await client.pages.create({
    parent: { database_id: dbId },
    properties,
  });
  return page.id;
}
