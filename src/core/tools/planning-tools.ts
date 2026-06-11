/**
 * v204: 排計畫 — 簡化版(只保留 READ-ONLY 查詢)
 *
 * 2026-05-28 拍板:user 偏好「備份 + 挪明日 自己手動做更安全」,
 * 所以刪掉自動寫 Notion 的 backup + integrate,
 * 只留下 read-only 的「節日提醒 + 卡很久」查詢工具。
 *
 * Bot 可以隨時被叫來掃 + 報告,但不會主動改你的 Notion。
 */

import type { Env } from '../types';
import {
  getContract,
  seedDefaultContract,
  listCandidates,
} from '../planning/contract';
import { isOwner, isInternalMode } from '../config/runtime-config';
import { scanFestivals, appendAIMarker } from '../planning/festival';
import { scanStuckTodos } from '../planning/stuck';
import { getTomorrowReport } from '../planning/tomorrow';

export const PLANNING_TOOLS = [
  {
    name: 'prepare_tomorrow_workplan',
    description:
      'user 講「排工作 / 排計畫 / 看明天 / 明日工作 / 規劃明日」之類 → 一次掃齊明日該做的事,給 user 看清單(他自己手動複製到 Notion)。' +
      '\n\n' +
      '回傳:(a) 明日 todos(從未來計畫 + 每天固定 + 週期性 + 每月固定 合併去重,按時間排序);' +
      '(b) 節日提前提醒(toRemindNow + 待估天數 needingMarker);(c) 卡很久待辦清單。' +
      '\n\n' +
      '完全 read-only,不會改 user 的 Notion。' +
      '\n\n' +
      '回傳後你要做的事:' +
      '1. 把該日 todos 整理成「方便複製」的清單(每行一筆,有時間的在上面)' +
      '2. 列節日 toRemindNow + 卡很久 stuckTodos(條列)' +
      '3. 對 needingMarker 每筆自己估天數(節日 7/生日 3/報稅 14/訂蛋糕 5/其他自判),呼叫 set_festival_ai_marker 寫回' +
      '\n\n' +
      '⚡ 排哪一天:user 講「今天/今日」帶 offsetDays=0,「後天」帶 2,「明天/明日」或沒指定帶 1(預設)。' +
      '回覆時照工具回傳的 date 欄講實際日期,不要自己假設是明天。',
    input_schema: {
      type: 'object',
      properties: {
        offsetDays: {
          type: 'number',
          description: '排哪一天:0=今天,1=明天(預設),2=後天。依 user 講的日期帶。',
        },
      },
    },
  },
  {
    name: 'set_festival_ai_marker',
    description:
      '把你 AI 估的提前天數寫回 Notion 該項目(append [AI:提前 N 天] 在原文後)。' +
      'user 永遠可改 / 去掉「AI:」前綴表示「我親自確認」。',
    input_schema: {
      type: 'object',
      properties: {
        block_id: { type: 'string', description: '節日項目的 Notion block id' },
        days: { type: 'number', description: '你估的提前天數' },
      },
      required: ['block_id', 'days'],
    },
  },
  {
    name: 'list_notion_candidates_for_contract',
    description:
      '安裝精靈用:列學員 Notion 主頁所有 H1/H2/H3/sub-page,讓他選哪個對應「節日生日」「待辦事項」等契約欄位。',
    input_schema: {
      type: 'object',
      properties: { page_id: { type: 'string', description: '學員主頁 id' } },
      required: ['page_id'],
    },
  },
];

export const PLANNING_TOOL_NAMES = new Set(PLANNING_TOOLS.map((t) => t.name));

export async function executePlanningTool(
  env: Env,
  toolName: string,
  input: any,
  userId: string
): Promise<string> {
  if (!userId) return '錯誤:沒有 userId';

  // internal 模式不接 Notion → 排工作/節日標記/契約列舉都沒對象。
  // 正常情況下 internal 模式根本不會把 planning 工具給 Claude(claude-with-tools 已過濾);
  // 這裡是 defense-in-depth,萬一被呼叫到,回友善訊息而非「去設定 Notion」(他就是不想用才選這模式)。
  if (isInternalMode(env)) {
    return '目前是「內建模式(internal)」— 不接 Notion,沒有「今日計畫 / 排工作」功能。' +
      '要用排工作,到 /setup 把儲存模式改成 notion-new 或 notion-existing 即可。';
  }

  try {
    switch (toolName) {
      case 'prepare_tomorrow_workplan': {
        const offsetDays = typeof input?.offsetDays === 'number' ? input.offsetDays : 1;
        let c = await getContract(env, userId);
        if (!c) {
          // 缺契約:owner 有「設定提供的預設契約」才 seed;否則(含買家)回「請先設定」,絕不 fallback 別人的值。
          if (await isOwner(env, userId)) {
            try {
              c = await seedDefaultContract(env, userId);
            } catch (e: any) {
              return `契約 seed 失敗:${e.message ?? e}`;
            }
          }
          if (!c) {
            return '還沒設定你的「今日計畫」Notion 頁(排工作要先知道去哪讀)。請先完成安裝設定把你的 Notion 結構接上,設好就能排工作了。';
          }
        }

        // 3 件事平行:明日 todos + 節日 + 卡很久
        const [tomorrow, festivalResult, stuckItems] = await Promise.all([
          getTomorrowReport(env, {
            todayPagePageId: c.todayPlanPageId,
            futurePlanBlockId: c.futurePlanBlockId,
            dailyFixedBlockId: c.dailyFixedBlockId,
            monthlyFixedBlockId: c.monthlyFixedBlockId,
            recurringBlockId: c.recurringBlockId,
            offsetDays,
          }),
          c.festivalBlockId
            ? scanFestivals(env, {
                todayPagePageId: c.todayPlanPageId,
                festivalBlockId: c.festivalBlockId,
              })
            : Promise.resolve({ itemsToRemind: [], itemsNeedingMarker: [], allItems: [] }),
          c.todoListBlockId
            ? scanStuckTodos(env, {
                pageId: c.todayPlanPageId,
                todoListAnchorId: c.todoListBlockId,
              })
            : Promise.resolve([]),
        ]);

        return JSON.stringify({
          tomorrow: {
            date: `${tomorrow.mmdd}(${tomorrow.weekday})`,
            byTime: tomorrow.byTime.map((x) => x.text),
            noTime: tomorrow.noTime.map((x) => x.text),
            totalCount: tomorrow.totalCount,
            countsBySource: tomorrow.countsBySource,
          },
          festivals: {
            toRemindNow: festivalResult.itemsToRemind,
            needingMarker: festivalResult.itemsNeedingMarker,
          },
          stuckTodos: stuckItems,
        }, null, 2);
      }

      case 'set_festival_ai_marker': {
        await appendAIMarker(env, input.block_id, input.days);
        return `✓ 已在 block ${input.block_id} 加 [AI:提前 ${input.days} 天]`;
      }

      case 'list_notion_candidates_for_contract': {
        const items = await listCandidates(env, input.page_id);
        return JSON.stringify(items, null, 2);
      }

      default:
        return `Unknown planning tool: ${toolName}`;
    }
  } catch (e: any) {
    return `Tool error: ${e?.message ?? e}`;
  }
}
