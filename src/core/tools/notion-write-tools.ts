/**
 * Notion 寫入工具 — v7:加 update / delete / propose_batch
 *
 * v7 新增:
 * - update_block:單筆修改現有 block
 * - delete_block:單筆刪除(Notion trash 30 天可救)
 * - propose_batch_action:批次操作(>=2 筆) → 寫進 KV 等使用者確認
 */

import type { Env } from '../types';
import { getTodayPageId } from '../planning/contract'; // v220(A-1): 今日計畫頁改走 per-user contract
import { parseHeadingDate } from '../reminders/store'; // v224: 寫入區段結束跟讀取(scan)對齊用

// v220(A-1): 移除寫死的今日計畫頁 id — 改各 helper 內 await getTodayPageId(env, userId) 取 per-user 值。
const DEDUP_TTL_SECONDS = 60;

// dedup:檢查 60 秒內同樣的寫入是否已經做過
async function checkAndMarkWrite(
  env: Env,
  toolName: string,
  type: string,
  text: string
): Promise<{ duplicate: boolean }> {
  if (!env.CACHE) return { duplicate: false };
  // KV key 限 512 bytes,text 截 200 字夠用
  const key = `write-dedup:${toolName}:${type}:${text.substring(0, 200)}`;
  try {
    const existing = await env.CACHE.get(key);
    if (existing) return { duplicate: true };
    await env.CACHE.put(key, '1', { expirationTtl: DEDUP_TTL_SECONDS });
  } catch (e) {
    console.warn('[write-dedup] KV failed:', e);
  }
  return { duplicate: false };
}

// 記錄今日寫入(給晚上 22:00 總結用)
function todayKey(env: Env): string {
  const now = new Date();
  const tpe = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.TIMEZONE || 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return `daily-writes:${tpe}`;
}

export async function logDailyWrite(
  env: Env,
  entry: { tool: string; type: string; text: string; position: string; blockId?: string | null }
): Promise<void> {
  if (!env.CACHE) return;
  const key = todayKey(env);
  try {
    const raw = await env.CACHE.get(key);
    const list = raw ? JSON.parse(raw) : [];
    list.push({ ...entry, at: new Date().toISOString() });
    // 保留 48 小時(隔天 22:00 才推,留時間給 cron)
    await env.CACHE.put(key, JSON.stringify(list), { expirationTtl: 48 * 3600 });
  } catch (e) {
    console.warn('[daily-log] failed:', e);
  }
}

export async function getTodayWrites(env: Env): Promise<any[]> {
  if (!env.CACHE) return [];
  try {
    const raw = await env.CACHE.get(todayKey(env));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * 撤回:刪除指定 block,並從 daily-writes 移除
 * idx = 1 表示「最後一筆」,2 = 倒數第二,以此類推
 */
export async function undoWrite(
  env: Env,
  idx: number = 1
): Promise<{ ok: boolean; message: string; removed?: any }> {
  if (!env.CACHE) return { ok: false, message: 'KV 不可用,無法撤回' };
  const writes = await getTodayWrites(env);
  if (writes.length === 0) {
    return { ok: false, message: '今天還沒有寫入紀錄,沒東西可撤回' };
  }
  if (idx < 1 || idx > writes.length) {
    return {
      ok: false,
      message: `編號超出範圍。今天共 ${writes.length} 筆,你想撤回第 ${idx} 筆`,
    };
  }
  // 從尾巴算回去
  const removeIdx = writes.length - idx;
  const target = writes[removeIdx];
  if (!target.blockId) {
    return {
      ok: false,
      message: `第 ${idx} 筆「${target.text}」沒記到 block_id(v33 前的寫入沒記),無法自動撤回。請手動進 Notion 刪除。`,
    };
  }
  // 呼叫 Notion API 刪 block
  const response = await fetch(`https://api.notion.com/v1/blocks/${target.blockId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
    },
  });
  if (!response.ok) {
    const errText = await response.text();
    return {
      ok: false,
      message: `Notion 刪除失敗 (${response.status}): ${errText.substring(0, 200)}`,
    };
  }
  // 從 list 移除
  writes.splice(removeIdx, 1);
  try {
    await env.CACHE.put(todayKey(env), JSON.stringify(writes), { expirationTtl: 48 * 3600 });
  } catch (e) {
    console.warn('[undo] KV update failed:', e);
  }
  return {
    ok: true,
    message: `已從 Notion 刪除:[${target.type}] ${target.text}`,
    removed: target,
  };
}

export const NOTION_WRITE_TOOLS = [
  {
    name: 'add_to_today',
    description:
      '在「今日計畫」加新內容,自動依時間排序插入適當位置。' +
      '若 text 含「HH:MM」時間(例:「14:00 回學生問題」)→ 插入對應時段。' +
      '若無時間 → 插今天區段末尾。',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['todo', 'note', 'heading'],
        },
        text: {
          type: 'string',
          description: '內容文字。若有時間請用「HH:MM」格式開頭(例:「14:00 回學生問題」)',
        },
      },
      required: ['type', 'text'],
    },
  },
  {
    name: 'append_to_page',
    description: '在指定 Notion 頁面末端加內容',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string' },
        type: { type: 'string', enum: ['todo', 'note', 'heading'] },
        text: { type: 'string' },
      },
      required: ['page_id', 'type', 'text'],
    },
  },
  {
    name: 'update_block',
    description:
      '修改現有 block 的文字內容(保留 block 類型與 to_do checked 狀態)。' +
      '必須先用 read_notion_page 取得 block_id。' +
      '**單筆修改可以直接呼叫;若要修改 2 筆以上,必須改用 propose_batch_action**',
    input_schema: {
      type: 'object',
      properties: {
        block_id: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['block_id', 'new_text'],
    },
  },
  {
    name: 'delete_block',
    description:
      '刪除一個 block(Notion 會放進 trash,30 天可救回)。' +
      '**單筆刪除可以直接呼叫;若要刪 2 筆以上,必須改用 propose_batch_action**',
    input_schema: {
      type: 'object',
      properties: {
        block_id: { type: 'string' },
      },
      required: ['block_id'],
    },
  },
  {
    name: 'add_to_date',
    description:
      '把事項加到「今日計畫」頁面內**指定日期的區段**。' +
      '使用者說「明天 X」「5/20 X」「下週一 X」→ 用這個。' +
      'date_keyword 接受:「today」/「tomorrow」/「YYYY-MM-DD」/「MM/DD」。' +
      '工具會自動找對應日期的 paragraph(例:「5/19（一）」)或 heading,插它後面。' +
      '⚠️ 若找不到對應日期區段 → **工具不會自己建立新區段**,會回報「請先在 Notion 加該日期標題」。' +
      '此時你要照實轉告使用者(別承諾你會自動建),或請他先去 Notion 加上那天的標題再試。' +
      '一般「今天」的事項仍用 add_to_today。',
    input_schema: {
      type: 'object',
      properties: {
        date_keyword: {
          type: 'string',
          description: '日期關鍵字:today / tomorrow / YYYY-MM-DD / MM/DD',
        },
        type: { type: 'string', enum: ['todo', 'note', 'heading'] },
        text: { type: 'string', description: '事項內容(不要含日期前綴,日期由工具處理)' },
      },
      required: ['date_keyword', 'type', 'text'],
    },
  },
  {
    name: 'mark_block_done',
    description:
      '把某個 Notion to_do block **打勾**(設 checked=true)。' +
      '使用者說「07:10 完成」「打勾盥洗」「✓ 14:00 看牙醫」「弄好了 14:00」這類 → 用這個。' +
      '**絕對不要**用 update_block 在文字前加「✓」字元,那只會讓文字多一個 ✓ 但 checkbox 還是空的。' +
      '先用 read_notion_page 找 block_id,然後用這個工具打勾。',
    input_schema: {
      type: 'object',
      properties: {
        block_id: { type: 'string', description: 'Notion to_do block 的 ID' },
      },
      required: ['block_id'],
    },
  },
  {
    name: 'mark_block_undone',
    description:
      '把某個 Notion to_do block **取消打勾**(設 checked=false)。' +
      '使用者說「07:10 取消打勾」「沒做 14:00」「重新打開 X」這類 → 用這個。' +
      '同樣不要用 update_block 改文字。',
    input_schema: {
      type: 'object',
      properties: {
        block_id: { type: 'string', description: 'Notion to_do block 的 ID' },
      },
      required: ['block_id'],
    },
  },
  {
    name: 'update_field_value',
    description:
      '更新今日計畫頁面內某個「欄位 paragraph」的值。' +
      '使用者說「記錄體重 X」「天氣 Y」「狀態 Z」「心情 W」這類屬性類資訊 → 用這個,**絕對不要用 add_to_today**。' +
      '工具會找含「{field}：」(全形冒號)或「{field}:」(半形)的 paragraph,把文字改成「{field}：{value}」。' +
      '找不到欄位 / 找到多個 → 報錯,不亂建立。',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: '欄位名稱,例:「體重」、「天氣」、「狀態」、「心情」' },
        value: { type: 'string', description: '欄位值,例:「79.5 kg」、「晴天」、「精神好」' },
      },
      required: ['field', 'value'],
    },
  },
  {
    name: 'propose_batch_action',
    description:
      '提出批次修改/刪除/勾選請使用者確認。' +
      '**只要動到 >= 2 筆,一律走這個工具,不可直接連呼 update_block / delete_block / mark_block_done**。' +
      '操作清單會顯示給使用者,使用者回「確認」才執行。' +
      'v175:支援 op=mark_done / mark_undone,**標記完成請務必用這兩個 op,不要用 op=update 把 ☐ 改 ✓(那只會改 text,不會勾 checkbox)**',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句話描述批次操作目的(例:「把今天排程往後延 30 分鐘」/「標記 12 點前未完成的 2 筆為完成」)' },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['update', 'delete', 'mark_done', 'mark_undone'],
                description: 'update=改文字 / delete=刪 block / mark_done=勾 checkbox 為完成 / mark_undone=取消勾選'
              },
              block_id: { type: 'string' },
              old_text: { type: 'string', description: '目前內容(顯示給使用者看)' },
              new_text: { type: 'string', description: 'update 時的新文字(其他 op 不需要)' },
            },
            required: ['op', 'block_id', 'old_text'],
          },
        },
      },
      required: ['summary', 'actions'],
    },
  },
];

export async function executeNotionWriteTool(
  env: Env,
  toolName: string,
  input: any,
  userId?: string
): Promise<string> {
  // 單筆 update / delete / 批次 propose:單獨處理
  if (toolName === 'update_block') {
    return await singleUpdateBlock(env, input.block_id, input.new_text);
  }
  if (toolName === 'delete_block') {
    return await singleDeleteBlock(env, input.block_id);
  }
  if (toolName === 'propose_batch_action') {
    if (!userId) return '錯誤:propose_batch_action 需要 userId,系統設定問題';
    return await proposeBatchAction(env, userId, input.summary, input.actions);
  }
  if (toolName === 'update_field_value') {
    return await updateFieldValueInTodayPlan(env, userId, input.field, input.value);
  }
  if (toolName === 'mark_block_done') {
    return await markBlockChecked(env, input.block_id, true);
  }
  if (toolName === 'mark_block_undone') {
    return await markBlockChecked(env, input.block_id, false);
  }

  // 以下是新增類工具的 dedup + 執行
  const dedupCheck = await checkAndMarkWrite(env, toolName, input.type ?? '?', input.text ?? '');
  if (dedupCheck.duplicate) {
    console.log(`[write-dedup] 擋下重複寫入: ${toolName} [${input.type}] ${input.text?.substring(0, 50)}`);
    return `⚠️ 60 秒內已執行過同樣的寫入,跳過此次(避免重複)。\n內容:[${input.type}] ${input.text}\n📍 位置:已在前一次寫入,未重複新增`;
  }

  let writeResult: { message: string; blockId: string | null; positionDesc: string };
  if (toolName === 'add_to_today') {
    writeResult = await smartAddToToday(env, userId, input.type, input.text);
  } else if (toolName === 'append_to_page') {
    const r = await appendBlock(env, input.page_id, input.type, input.text, null);
    writeResult = { message: r.message, blockId: r.blockId, positionDesc: '頁尾' };
  } else if (toolName === 'add_to_date') {
    writeResult = await smartAddToDate(env, userId, input.date_keyword, input.type, input.text);
  } else {
    return `Unknown tool: ${toolName}`;
  }

  const fullMessage = `${writeResult.message}\n📍 ${writeResult.positionDesc}`;

  if (!writeResult.message.includes('失敗')) {
    await logDailyWrite(env, {
      tool: toolName,
      type: input.type,
      text: input.text,
      position: writeResult.positionDesc,
      blockId: writeResult.blockId,
    });
  }

  return fullMessage;
}

// === 打勾 / 取消打勾(對 to_do block)===
async function markBlockChecked(env: Env, blockId: string, checked: boolean): Promise<string> {
  // 先讀拿 type 跟 rich_text
  const getRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
    },
  });
  if (!getRes.ok) return `失敗:讀 block 出錯 (${getRes.status})`;
  const block: any = await getRes.json();
  if (block.type !== 'to_do') return `失敗:該 block 不是 to_do 類型(是 ${block.type}),無法打勾`;
  const richText = block.to_do?.rich_text ?? [];
  const text = richText.map((t: any) => t.plain_text).join('');

  const patchRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({ to_do: { rich_text: richText, checked } }),
  });
  if (!patchRes.ok) {
    const errText = await patchRes.text();
    return `${checked ? '打勾' : '取消打勾'}失敗 (${patchRes.status}): ${errText.substring(0, 150)}`;
  }
  return `✓ 已${checked ? '打勾' : '取消打勾'}「${text}」(Notion checkbox 已${checked ? '勾選' : '取消'})`;
}

// === 更新欄位值(體重 / 天氣 等)===
async function updateFieldValueInTodayPlan(
  env: Env,
  userId: string | undefined,
  field: string,
  value: string
): Promise<string> {
  const TODAY_PAGE_ID = userId ? await getTodayPageId(env, userId) : null;
  if (!TODAY_PAGE_ID) return '⚠ 找不到你的「今日計畫」頁設定,請先完成 Notion 設定後再試。';
  // 讀今日計畫整頁
  const response = await fetch(
    `https://api.notion.com/v1/blocks/${TODAY_PAGE_ID}/children?page_size=100`,
    {
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    }
  );
  if (!response.ok) return `讀頁失敗 (${response.status})`;
  const data: any = await response.json();
  const blocks = data.results || [];

  // 找含「{field}：」或「{field}:」的 paragraph
  const matches: Array<{ idx: number; id: string; text: string }> = [];
  const pattern1 = `${field}：`; // 全形冒號
  const pattern2 = `${field}:`;  // 半形
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== 'paragraph') continue;
    const t = (b.paragraph?.rich_text ?? []).map((x: any) => x.plain_text).join('');
    if (t.includes(pattern1) || t.includes(pattern2)) {
      matches.push({ idx: i, id: b.id, text: t });
    }
  }

  if (matches.length === 0) {
    return `✗ 找不到「${field}」欄位的 paragraph,我不會自己建立\n📍 (找不到)`;
  }
  if (matches.length > 1) {
    const list = matches.map((m, i) => `  ${i + 1}. 「${m.text.substring(0, 40)}」`).join('\n');
    return `✗ 找到 ${matches.length} 個「${field}」欄位:\n${list}\n請整理 Notion 只留一個,或告訴我哪一個\n📍 (多個無法決定)`;
  }

  // 唯一一個 → update
  const target = matches[0];
  const newText = `${field}：${value}`;
  const patchRes = await fetch(`https://api.notion.com/v1/blocks/${target.id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      paragraph: { rich_text: [{ type: 'text', text: { content: newText } }] },
    }),
  });
  if (!patchRes.ok) {
    const errText = await patchRes.text();
    return `更新失敗 (${patchRes.status}): ${errText.substring(0, 150)}`;
  }
  return `✓ 已更新「${field}」欄位:\n原:「${target.text}」\n新:「${newText}」\n📍 在今日計畫頁的「${field}」欄位`;
}

// === 單筆 update ===
async function singleUpdateBlock(
  env: Env,
  blockId: string,
  newText: string
): Promise<string> {
  // 1. 讀 block 取得 type 與 to_do checked 狀態
  const getRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
    },
  });
  if (!getRes.ok) {
    return `修改失敗:讀取 block 出錯 (${getRes.status})`;
  }
  const block: any = await getRes.json();
  const blockType = block.type;
  const oldRichText = block[blockType]?.rich_text ?? [];
  const oldText = oldRichText.map((t: any) => t.plain_text).join('');

  // 2. 組 payload
  const payload: any = { [blockType]: {} };
  payload[blockType].rich_text = [{ type: 'text', text: { content: newText } }];
  if (blockType === 'to_do') {
    payload.to_do.checked = block.to_do?.checked ?? false;
  }

  // 3. PATCH
  const patchRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify(payload),
  });
  if (!patchRes.ok) {
    const errText = await patchRes.text();
    return `修改失敗 (${patchRes.status}): ${errText.substring(0, 200)}`;
  }
  return `✓ 已修改\n原:${oldText}\n新:${newText}`;
}

// === 單筆 delete ===
async function singleDeleteBlock(env: Env, blockId: string): Promise<string> {
  // 先讀內容(刪了就看不到)
  let oldText = '';
  try {
    const getRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    });
    if (getRes.ok) {
      const block: any = await getRes.json();
      oldText = block[block.type]?.rich_text?.map((t: any) => t.plain_text).join('') ?? '';
    }
  } catch {}

  const delRes = await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
    },
  });
  if (!delRes.ok) {
    const errText = await delRes.text();
    return `刪除失敗 (${delRes.status}): ${errText.substring(0, 200)}`;
  }
  return `✓ 已刪除:${oldText || blockId}\n(Notion trash 30 天內可救回)`;
}

// === 批次 propose — 工具內直接 push,不等 chatWithTools 跑完 ===
export async function proposeBatchAction(
  env: Env,
  userId: string,
  summary: string,
  actions: Array<{ op: 'update' | 'delete' | 'mark_done' | 'mark_undone'; block_id: string; old_text: string; new_text?: string }>
): Promise<string> {
  if (!env.CACHE) return '錯誤:KV 不可用,無法暫存待確認動作';
  if (!actions || actions.length === 0) return '錯誤:沒有動作可確認';

  const key = `pending-action:${userId}`;
  const data = {
    summary,
    actions,
    createdAt: new Date().toISOString(),
  };
  await env.CACHE.put(key, JSON.stringify(data), { expirationTtl: 90 });

  const lines = [`待確認:${summary}`, '━━━━━━━━━━━━'];
  actions.forEach((a, i) => {
    if (a.op === 'update') {
      lines.push(`${i + 1}. 改:「${a.old_text}」→「${a.new_text}」`);
    } else if (a.op === 'delete') {
      lines.push(`${i + 1}. 刪:「${a.old_text}」`);
    } else if (a.op === 'mark_done') {
      lines.push(`${i + 1}. 勾 ☑:「${a.old_text}」`);
    } else if (a.op === 'mark_undone') {
      lines.push(`${i + 1}. 取消勾選 ☐:「${a.old_text}」`);
    } else {
      lines.push(`${i + 1}. ${(a as any).op}:「${a.old_text}」`);
    }
  });
  lines.push('━━━━━━━━━━━━');
  lines.push(`共 ${actions.length} 筆。按「✓ 確認」執行,「✗ 取消」放棄。90 秒未回 = 取消。`);
  const text = lines.join('\n');

  // 直接 push LINE 訊息(不等 chatWithTools 結束,避免 waitUntil 超時被 cancel)
  try {
    const pushRes = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Line-Retry-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        to: userId,
        messages: [{
          type: 'text',
          text,
          quickReply: {
            items: [
              { type: 'action', action: { type: 'message', label: '✓ 確認', text: '確認' } },
              { type: 'action', action: { type: 'message', label: '✗ 取消', text: '取消' } },
              { type: 'action', action: { type: 'message', label: '說明', text: '/help' } },
            ],
          },
        }],
      }),
    });
    if (!pushRes.ok) {
      console.warn('[propose-batch] push failed', pushRes.status, await pushRes.text().then(t => t.substring(0, 200)));
    } else {
      console.log(`[propose-batch] 已直接 push 給 ${userId.substring(0, 8)}`);
    }
  } catch (e) {
    console.error('[propose-batch] push exception:', e);
  }

  return [
    '[提案已直接 push 給使用者,你不用再說。簡短回應「✓ 提案已送出,等待使用者確認/取消」即可,不要重複列出 actions]',
    `操作摘要:${summary}(${actions.length} 筆)`,
  ].join('\n');
}

// === 執行批次(收到「確認」時呼叫)===
export async function executePendingBatch(
  env: Env,
  userId: string
): Promise<{ ok: boolean; message: string }> {
  if (!env.CACHE) return { ok: false, message: 'KV 不可用' };
  const raw = await env.CACHE.get(`pending-action:${userId}`);
  if (!raw) return { ok: false, message: '沒有待確認的動作(可能已過 90 秒過期)' };

  const data = JSON.parse(raw);
  await env.CACHE.delete(`pending-action:${userId}`);

  const results: string[] = [];
  let okCount = 0;
  let failCount = 0;

  for (const a of data.actions) {
    let r: string;
    if (a.op === 'update') {
      r = await singleUpdateBlock(env, a.block_id, a.new_text);
    } else if (a.op === 'delete') {
      r = await singleDeleteBlock(env, a.block_id);
    } else if (a.op === 'mark_done') {
      r = await markBlockChecked(env, a.block_id, true);
    } else if (a.op === 'mark_undone') {
      r = await markBlockChecked(env, a.block_id, false);
    } else {
      r = `✗ 未知 op: ${a.op}`;
    }
    if (r.startsWith('✓')) okCount++;
    else failCount++;
    results.push(`[${a.op}] ${a.old_text}: ${r.split('\n')[0]}`);
  }

  return {
    ok: failCount === 0,
    message: [
      `批次執行結果(${okCount} 成功 / ${failCount} 失敗)`,
      '━━━━━━━━━━━━',
      ...results,
    ].join('\n'),
  };
}

export async function cancelPendingBatch(env: Env, userId: string): Promise<boolean> {
  if (!env.CACHE) return false;
  const raw = await env.CACHE.get(`pending-action:${userId}`);
  if (!raw) return false;
  await env.CACHE.delete(`pending-action:${userId}`);
  return true;
}

export async function hasPendingBatch(env: Env, userId: string): Promise<boolean> {
  if (!env.CACHE) return false;
  return !!(await env.CACHE.get(`pending-action:${userId}`));
}

// 取得 pending batch 完整資料(給 line.ts 直接組清單用,不靠 Claude 轉述)
export async function getPendingBatch(env: Env, userId: string): Promise<any | null> {
  if (!env.CACHE) return null;
  const raw = await env.CACHE.get(`pending-action:${userId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 把 pending batch 組成漂亮的訊息給使用者看
export function formatPendingBatchMessage(pending: {
  summary: string;
  actions: Array<{ op: 'update' | 'delete' | 'mark_done' | 'mark_undone'; old_text: string; new_text?: string }>;
}): string {
  const lines = [`待確認:${pending.summary}`, '━━━━━━━━━━━━'];
  pending.actions.forEach((a, i) => {
    if (a.op === 'update') {
      lines.push(`${i + 1}. 改:「${a.old_text}」→「${a.new_text}」`);
    } else if (a.op === 'mark_done') {
      lines.push(`${i + 1}. 勾 ☑:「${a.old_text}」`);
    } else if (a.op === 'mark_undone') {
      lines.push(`${i + 1}. 取消勾選 ☐:「${a.old_text}」`);
    } else {
      lines.push(`${i + 1}. 刪:「${a.old_text}」`);
    }
  });
  lines.push('━━━━━━━━━━━━');
  lines.push(`共 ${pending.actions.length} 筆。回「確認」執行,「取消」放棄。90 秒未回 = 取消。`);
  return lines.join('\n');
}

// 解析時間 "14:00" → 840 (分鐘數,方便比較)
function parseTime(text: string): number | null {
  const m = text.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1]);
  const min = parseInt(m[2]);
  return h * 60 + min;
}

// 取得 block 的文字內容
function blockText(block: any): string {
  const type = block.type;
  const content = block[type];
  if (!content?.rich_text) return '';
  return content.rich_text.map((t: any) => t.plain_text).join('');
}

async function smartAddToToday(
  env: Env,
  userId: string | undefined,
  type: string,
  text: string
): Promise<{ message: string; blockId: string | null; positionDesc: string }> {
  const TODAY_PAGE_ID = userId ? await getTodayPageId(env, userId) : null;
  if (!TODAY_PAGE_ID) return { message: '⚠ 找不到你的「今日計畫」頁設定,請先完成 Notion 設定。', blockId: null, positionDesc: '錯誤' };
  const newTimeMin = parseTime(text);

  // 讀今日計畫所有 block
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
    return { message: `讀頁失敗 (${response.status})`, blockId: null, positionDesc: '失敗' };
  }
  const data: any = await response.json();
  const blocks = data.results || [];

  // 找今天 heading 的 idx
  const now = new Date();
  const tpe = new Intl.DateTimeFormat('zh-TW', {
    timeZone: env.TIMEZONE || 'Asia/Taipei', // v226 商品化:不再寫死台北
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const monthDay = tpe; // "05/18"
  const shortDay = monthDay.replace(/^0/, ''); // "5/18"

  let todayHeadingIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (!blocks[i].type.startsWith('heading_')) continue;
    const t = blockText(blocks[i]);
    if (t.includes(monthDay) || t.includes(shortDay)) {
      todayHeadingIdx = i;
      break;
    }
  }

  // 找今天區段結束 — 必須跟 scanTodayPlanForReminders 對齊,否則寫進的 reminder scan 抓不到。
  // v114: 含 divider(不然寫到 divider 之後 scan 抓不到)。
  // v224: 再對齊 v221 讀取改動 — 只認 divider + 「日期 heading」,不認 child_page(使用者會在當天區段內嵌子頁)
  //       也不認非日期 heading。否則寫入會在子頁/子標題前提早截斷 → 插錯位置。
  let sectionEndIdx = blocks.length;
  if (todayHeadingIdx !== -1) {
    for (let i = todayHeadingIdx + 1; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === 'divider') { sectionEndIdx = i; break; }
      if (b.type.startsWith('heading_')) {
        const c = b[b.type];
        const t = c?.rich_text?.map((x: any) => x.plain_text).join('') ?? '';
        if (parseHeadingDate(t)) { sectionEndIdx = i; break; } // 下個日期 heading 才算結束
      }
    }
  }

  let afterBlockId: string | null = null;
  let positionDesc = '';

  if (todayHeadingIdx === -1) {
    // 找不到今天 heading
    // 常見習慣:前一晚排好明天計畫,所以 heading 可能是明天的
    // → 把「整頁」當有效區段,做時間排序找對的位置
    //   (避免插到頁尾,因為頁面內容其實就是當天/未來的計畫)
    if (newTimeMin !== null) {
      // 整頁掃描含時間的 block,找對的位置
      let insertBeforeIdx = -1;
      let lastTimedIdx = -1;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type !== 'to_do' && b.type !== 'paragraph') continue;
        const t = blockText(b);
        const bTime = parseTime(t);
        if (bTime === null) continue;
        lastTimedIdx = i;
        if (bTime > newTimeMin) {
          insertBeforeIdx = i;
          break;
        }
      }
      if (insertBeforeIdx > 0) {
        afterBlockId = blocks[insertBeforeIdx - 1].id;
        const beforeText = blockText(blocks[insertBeforeIdx]).substring(0, 30);
        positionDesc = `(無今日 heading)整頁時間排序,插在「${beforeText}...」之前`;
      } else if (lastTimedIdx !== -1) {
        afterBlockId = blocks[lastTimedIdx].id;
        const afterText = blockText(blocks[lastTimedIdx]).substring(0, 30);
        positionDesc = `(無今日 heading)新時間最晚,插在「${afterText}...」之後`;
      } else {
        positionDesc = '無今日 heading 且整頁無時段事項,插頁尾';
      }
    } else {
      // 無時間 → 找 AI 共享記憶 link 前 / 否則頁尾
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'child_page' && blocks[i].child_page?.title?.includes('AI 共享記憶')) {
          if (i > 0) {
            afterBlockId = blocks[i - 1].id;
            positionDesc = '無時間且無 heading,插 AI 共享記憶 link 前';
          }
          break;
        }
      }
      if (!afterBlockId) positionDesc = '無時間,插頁尾';
    }
  } else if (newTimeMin === null) {
    // 無時間 → 插今天區段末尾
    if (sectionEndIdx > todayHeadingIdx + 1) {
      afterBlockId = blocks[sectionEndIdx - 1].id;
    } else {
      afterBlockId = blocks[todayHeadingIdx].id;
    }
    positionDesc = '無時間,插今天區段末尾';
  } else {
    // 有時間 → 找今天區段內,第一個「時間 > 新時間」的 block,插它前面
    let insertBeforeIdx = -1;
    let lastTimedIdx = -1;
    for (let i = todayHeadingIdx + 1; i < sectionEndIdx; i++) {
      const t = blockText(blocks[i]);
      const blockTime = parseTime(t);
      if (blockTime === null) continue;
      lastTimedIdx = i;
      if (blockTime > newTimeMin) {
        insertBeforeIdx = i;
        break;
      }
    }

    if (insertBeforeIdx > 0) {
      // 插在 insertBeforeIdx 前面 → afterBlockId 是前一個 block 的 id
      afterBlockId = blocks[insertBeforeIdx - 1].id;
      const beforeText = blockText(blocks[insertBeforeIdx]).substring(0, 30);
      positionDesc = `時間排序插入(插在「${beforeText}...」之前)`;
    } else if (lastTimedIdx !== -1) {
      // 新時間比所有都晚 → 插最後一個有時間的 block 後
      afterBlockId = blocks[lastTimedIdx].id;
      const afterText = blockText(blocks[lastTimedIdx]).substring(0, 30);
      positionDesc = `時間排序插入(插在「${afterText}...」之後,排在所有時段最後)`;
    } else {
      // 今天區段沒有任何有時間的 block → 插 heading 後
      afterBlockId = blocks[todayHeadingIdx].id;
      positionDesc = '今天區段沒有時段事項,插在 heading 後';
    }
  }

  // 寫入
  const result = await appendBlock(env, TODAY_PAGE_ID, type, text, afterBlockId);
  return { message: result.message, blockId: result.blockId, positionDesc };
}

// 解析日期關鍵字 → MM/DD 跟 weekday
function resolveDateKeyword(keyword: string, env: Env): { mmdd: string; shortMmdd: string; weekday: string; iso: string } | null {
  const tz = env.TIMEZONE || 'Asia/Taipei';
  const now = new Date();
  let target = new Date(now);
  const k = keyword.toLowerCase().trim();
  if (k === 'today' || k === '今天' || k === '今日') {
    // target 不變
  } else if (k === 'tomorrow' || k === '明天' || k === '明日') {
    target.setDate(target.getDate() + 1);
  } else if (k === 'day_after_tomorrow' || k === '後天') {
    target.setDate(target.getDate() + 2);
  } else {
    // 試 YYYY-MM-DD 或 MM/DD
    const m1 = k.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const m2 = k.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (m1) {
      target = new Date(parseInt(m1[1]), parseInt(m1[2]) - 1, parseInt(m1[3]));
    } else if (m2) {
      target = new Date(now.getFullYear(), parseInt(m2[1]) - 1, parseInt(m2[2]));
      // 如果這日期已過今年,試明年
      if (target < now) target.setFullYear(now.getFullYear() + 1);
    } else {
      return null;
    }
  }
  const tpe = new Intl.DateTimeFormat('zh-TW', { timeZone: tz, month: '2-digit', day: '2-digit' }).format(target);
  const weekdayFull = new Intl.DateTimeFormat('zh-TW', { timeZone: tz, weekday: 'long' }).format(target);
  const weekdayShort = weekdayFull.replace('星期', '');
  const iso = target.toISOString().substring(0, 10);
  return {
    mmdd: tpe, // 05/19
    shortMmdd: tpe.replace(/^0/, ''), // 5/19
    weekday: weekdayShort, // 一
    iso,
  };
}

async function smartAddToDate(
  env: Env,
  userId: string | undefined,
  dateKeyword: string,
  type: string,
  text: string
): Promise<{ message: string; blockId: string | null; positionDesc: string }> {
  const TODAY_PAGE_ID = userId ? await getTodayPageId(env, userId) : null;
  if (!TODAY_PAGE_ID) return { message: '⚠ 找不到你的「今日計畫」頁設定,請先完成 Notion 設定。', blockId: null, positionDesc: '錯誤' };
  const d = resolveDateKeyword(dateKeyword, env);
  if (!d) {
    return {
      message: `無法解析日期「${dateKeyword}」`,
      blockId: null,
      positionDesc: '錯誤',
    };
  }
  // today 用既有 smartAddToToday 邏輯
  if (d.iso === new Date().toISOString().substring(0, 10)) {
    return await smartAddToToday(env, userId, type, text);
  }

  // v211: 讀今日計畫整頁 — 必須翻頁(Notion 一次最多回 100 個 block,
  //        「未來計畫」等區段常落在 100 之後;舊版只讀第一頁 → 整段看不到 → 永遠找不到該日期)
  const blocks: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const url = `https://api.notion.com/v1/blocks/${TODAY_PAGE_ID}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' },
    });
    if (!response.ok) {
      return { message: `讀頁失敗 (${response.status})`, blockId: null, positionDesc: '失敗' };
    }
    const data: any = await response.json();
    blocks.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }

  // v211: 用數字比對「行首日期」(paragraph 或 heading 都接受)
  //   舊版用 t.includes("06/05"/"6/05") 有兩個問題:
  //     (1) 個位數日「6/5」永遠比不中(只生 06/05 / 6/05)
  //     (2) 會誤抓內文裡的日期,例「提供名單…下次是6/30」也被當成 6/30 區段
  //   改成「行首 M/D 用數字比對」一次解決:6/5 對得到、內文日期不會誤抓。
  const dm = d.mmdd.match(/^(\d{1,2})\/(\d{1,2})$/);
  const targetMonth = dm ? parseInt(dm[1], 10) : -1;
  const targetDay = dm ? parseInt(dm[2], 10) : -1;
  const matches: Array<{ idx: number; text: string }> = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const c = b[b.type];
    if (!c?.rich_text) continue;
    const t = c.rich_text.map((x: any) => x.plain_text).join('');
    const mt = t.trim().match(/^(\d{1,2})\/(\d{1,2})/); // 只認行首日期
    if (mt && parseInt(mt[1], 10) === targetMonth && parseInt(mt[2], 10) === targetDay) {
      matches.push({ idx: i, text: t.substring(0, 50) });
    }
  }

  // 找不到 → 報錯,絕不亂建立(使用者明確要求)
  if (matches.length === 0) {
    return {
      message:
        `✗ 找不到 ${d.mmdd} 的區段。我不會自己建立新區段。\n` +
        `請先到 Notion 加上「${d.mmdd}（${d.weekday}）」標題,我再幫你寫進去。`,
      blockId: null,
      positionDesc: '找不到日期區段,未寫入',
    };
  }

  // 找到多個 → 報錯,讓使用者確認
  if (matches.length > 1) {
    const list = matches.map((m, i) => `  ${i + 1}. 第 ${m.idx} 個 block:「${m.text}」`).join('\n');
    return {
      message:
        `✗ 找到 ${matches.length} 個含 ${d.mmdd} 的區段,不確定該插哪個:\n${list}\n` +
        `請告訴我要插第幾個,或在 Notion 整理只保留一個。我絕不自己亂猜。`,
      blockId: null,
      positionDesc: `找到多個日期區段(${matches.length} 個),未寫入`,
    };
  }

  // 唯一一個 → 找該區段的結束,插在末尾
  const dateBlockIdx = matches[0].idx;
  let sectionEnd = blocks.length;
  for (let i = dateBlockIdx + 1; i < blocks.length; i++) {
    const b = blocks[i];
    const c = b[b.type];
    const t = (c?.rich_text?.map((x: any) => x.plain_text).join('') ?? '').trim();
    // v211: 下一個「行首日期」就是下一段的開始(跟比對邏輯一致)
    if (/^\d{1,2}\/\d{1,2}/.test(t)) {
      sectionEnd = i;
      break;
    }
    // v224: 拔掉 child_page — 內嵌子頁不是區段結束(同 v221/v222 讀取修正),否則插錯位置。
    if (b.type.startsWith('heading_') || b.type === 'divider') {
      sectionEnd = i;
      break;
    }
  }
  const afterBlockId = blocks[sectionEnd - 1].id;
  const result = await appendBlock(env, TODAY_PAGE_ID, type, text, afterBlockId);
  return {
    message: result.message,
    blockId: result.blockId,
    positionDesc: `已找到 ${d.mmdd} 區段,插在其末尾`,
  };
}

async function appendBlock(
  env: Env,
  pageId: string,
  type: string,
  text: string,
  afterBlockId: string | null
): Promise<{ message: string; blockId: string | null }> {
  // v211: AI 寫入的內容一律上色標示(藍字),讓使用者一眼分辨「助理寫的 vs 自己寫的」。
  //   用 Notion 文字顏色 → 不佔任何字、不會被排程/提醒解析器讀到(它們只看 plain_text)。
  //   想換色:改這個常數即可('blue'/'gray'/'green'… 或 'blue_background' 之類底色)。
  const AI_WRITE_COLOR = 'blue';
  const richText = [{ type: 'text', text: { content: text }, annotations: { color: AI_WRITE_COLOR } }];
  let block: any;
  if (type === 'todo') {
    block = { type: 'to_do', to_do: { rich_text: richText, checked: false } };
  } else if (type === 'heading') {
    block = { type: 'heading_3', heading_3: { rich_text: richText } };
  } else {
    block = { type: 'paragraph', paragraph: { rich_text: richText } };
  }

  const payload: any = { children: [block] };
  if (afterBlockId) payload.after = afterBlockId;

  const response = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    return {
      message: `寫入失敗 (${response.status}): ${errText.substring(0, 200)}`,
      blockId: null,
    };
  }

  const data: any = await response.json();
  const newBlockId = data?.results?.[0]?.id ?? null;
  return { message: `已寫入: [${type}] ${text}`, blockId: newBlockId };
}
