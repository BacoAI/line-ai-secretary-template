/**
 * v191: 出門/回家提醒 — Claude tools
 *
 * Bot 對話路徑用這組工具讀寫「出門模板 + 臨時提醒 + 承諾追蹤」。
 *
 * 對學員的 Claude 友善:
 *  - 每個 tool 描述都含 trigger 例(讓學員的 Claude 知道何時用)
 *  - 換 storage / 邏輯只改 store.ts,本檔只是接口
 */

import type { Env } from '../types';
import {
  getTemplates,
  setTemplate,
  addItemsToTemplate,
  removeItemsFromTemplate,
  deleteTemplate,
  getTemplate,
  seedTemplatesIfEmpty,
  addAdhocReminder,
  formatLocalTime,
  getAdhocList,
  cancelAdhocReminder,
  findAdhocByEvent,
  markAdhocFired,
  addCommitment,
  fulfillCommitment,
  listPendingCommitments,
} from '../outing/store';

export const OUTING_TOOLS = [
  // ============== 模板系列 ==============
  {
    name: 'list_outing_templates',
    description:
      '列出使用者所有出門模板(模板名 → 該模板要帶的東西清單)。' +
      '使用者問「我有哪些模板」「上班要帶什麼」「我設定過什麼」之類 → 用這個查 KV,**絕對不要憑記憶答**。' +
      '第一次呼叫時若 KV 是空,會自動 seed 預設模板(上班/接小孩/跑步/辦事/回家/夜出),不用擔心。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_outing_template',
    description:
      '查單一模板的 items。使用者問「上班模板有什麼」「接小孩要帶啥」之類 → 用這個。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '模板名,例:上班、接小孩、跑步' },
      },
      required: ['name'],
    },
  },
  {
    name: 'set_outing_template',
    description:
      '建新模板或完全覆蓋既有模板的 items。' +
      '使用者說「**新建模板 健身 = 毛巾 水壺 運動服**」「**上班模板重設為 X Y Z**」→ 用這個。' +
      '只是新增/刪除個別項目時,**不要用這個**,用 add_items_to_outing_template / remove_items_from_outing_template。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '模板名' },
        items: { type: 'array', items: { type: 'string' }, description: '完整 items 清單(會覆蓋既有)' },
      },
      required: ['name', 'items'],
    },
  },
  {
    name: 'add_items_to_outing_template',
    description:
      '在既有模板新增 items(不影響原本的)。' +
      '使用者說「**接小孩加圍兜**」「**上班再多加充電線**」「**跑步也要帶毛巾**」→ 用這個。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '模板名' },
        items: { type: 'array', items: { type: 'string' }, description: '要新增的項目' },
      },
      required: ['name', 'items'],
    },
  },
  {
    name: 'remove_items_from_outing_template',
    description:
      '從既有模板移除 items。' +
      '使用者說「**上班不要帶硬碟**」「**接小孩不需要玩具**」→ 用這個。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '模板名' },
        items: { type: 'array', items: { type: 'string' }, description: '要移除的項目' },
      },
      required: ['name', 'items'],
    },
  },
  {
    name: 'delete_outing_template',
    description:
      '刪除整個模板。' +
      '使用者說「**刪掉夜出模板**」之類 → 用這個。少用,只刪整個模板時。',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: '要刪的模板名' } },
      required: ['name'],
    },
  },

  // ============== Ad-hoc 提醒 ==============
  {
    name: 'set_reminder',
    description:
      '設定一則「一般的一次性定時提醒」(不是帶東西、也不寫進 Notion)。' +
      '使用者說「**明天早上8點提醒我詢問綠界能不能刷國外卡**」「**30 分鐘後提醒我**」「**下午3點提醒我打給房東**」' +
      '這種**單純到某個時間提醒一句話**的需求 → 用這個。' +
      '\n\n' +
      '⚠️ time_iso 一律用「未來」的絕對時間(含 +08:00 時區)。現在時間在 system prompt 有,' +
      '**務必算對「明天/後天」的日期**(把明天設成今天會立刻誤觸發)。系統會擋過去時間並提示你重設。' +
      '\n\n' +
      '帶東西 / 出門 / 回家相關 → 改用 add_adhoc_outing_reminder,不要用這個。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要提醒的內容(一句話,照使用者講的)' },
        time_iso: { type: 'string', description: 'ISO 未來時間(含時區)。例:2026-06-03T08:00:00+08:00' },
      },
      required: ['text', 'time_iso'],
    },
  },
  {
    name: 'add_adhoc_outing_reminder',
    description:
      '加一條「臨時 + 一次性」的出門提醒(**僅限帶東西 / 出門場景**;一般定時提醒請用 set_reminder)。' +
      '使用者說「**提醒我今天回家帶筆電充電器蛋糕**」「**等下要去公司,提醒我帶硬碟**」「**下班前提醒我帶 X**」→ 用這個。' +
      '\n\n' +
      'trigger_type:\n' +
      '  - "time" = 指定時間 push(必填 time_iso,可選 notify_before_min)\n' +
      '  - "event" = 等使用者講某句話再 push(必填 event_keyword,例:"下班了"|"到家了"|"出門了")\n' +
      '\n' +
      'template_merge:若使用者要在某個場合連同某模板一起提醒(例「今天回家除了模板還要帶 X」),' +
      '填模板名(回家|上班|接小孩...)。push 時會把模板 items + adhoc items 合併顯示。\n' +
      '\n' +
      '⚠️ 使用者沒講具體時間時(「不確定幾點下班」),**先問**或**幫他猜合理時間 + 給按鈕確認**,' +
      '不要硬塞一個時間就丟進 KV。',
    input_schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' }, description: '要帶的東西(臨時加的)' },
        trigger_type: { type: 'string', enum: ['time', 'event'], description: 'time = 時間到 push;event = 等使用者講話再 push' },
        time_iso: { type: 'string', description: 'ISO 時間字串(含時區),trigger_type=time 時必填。例:2026-05-28T18:00:00+08:00' },
        notify_before_min: { type: 'number', description: '提前 N 分鐘 push(例:30)。預設 0 = 準時' },
        event_keyword: { type: 'string', description: 'trigger_type=event 時必填。例:"下班了"|"到家了"|"出門了"' },
        template_merge: { type: 'string', description: '可選:合併某模板的 items 一起提醒(模板名)' },
        note: { type: 'string', description: '可選:備註(例「給小明的蛋糕」)' },
      },
      required: ['items', 'trigger_type'],
    },
  },
  {
    name: 'list_adhoc_outing_reminders',
    description:
      '列出目前所有臨時提醒(尚未 fire、未過期)。使用者問「我設了什麼提醒」「等下要做啥」之類 → 查 KV。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_adhoc_outing_reminder',
    description:
      '取消單一臨時提醒。使用者說「取消下班提醒」之類 → 先 list 找 id,再用這個。',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: '臨時提醒的 id(從 list 拿)' } },
      required: ['id'],
    },
  },
  {
    name: 'trigger_outing_event',
    description:
      '觸發事件型 ad-hoc 提醒。使用者講「**下班了**」「**到家了**」「**出門了**」「**走囉**」之類 → 用這個,' +
      '把 event_keyword 對到對應 ad-hoc(這些都應該歸類成標準關鍵字之一:出門了 / 下班了 / 到家了 / 回家了)。' +
      '\n\n' +
      '同時:若使用者只是「我要出門了」沒帶模板資訊,**還要呼叫 list_outing_templates** 列模板給使用者選' +
      '(例:「要做什麼?上班 / 接小孩 / 跑步 / ...」)。',
    input_schema: {
      type: 'object',
      properties: {
        event_keyword: {
          type: 'string',
          enum: ['出門了', '下班了', '到家了', '回家了'],
          description: '事件關鍵字(歸類後)',
        },
      },
      required: ['event_keyword'],
    },
  },

  // ============== 承諾追蹤 ==============
  {
    name: 'add_commitment',
    description:
      '記下「答應誰要帶什麼」的承諾(半結構化)。' +
      '使用者說「**我答應小明下週帶烘焙樣品給他**」「**跟妹講過要帶咖啡豆**」「**老闆要我下次拿那份文件**」→ 用這個。' +
      '\n\n' +
      '為什麼要存:bot 會在接近 due_by 時主動提醒,真人助理就是這樣不會忘。' +
      '\n\n' +
      'due_by:若使用者講「下週」「月底」「明天」之類,**自行轉成 ISO 日期**。完全沒給時間 → 不填(就不會主動推).',
    input_schema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: '答應給誰(人名 / 稱謂)' },
        item: { type: 'string', description: '要帶/給什麼' },
        occasion: { type: 'string', description: '可選:場合(例「下次見面」「下週聚餐」)' },
        due_by: { type: 'string', description: '可選:ISO 日期(YYYY-MM-DD),例 2026-06-03' },
      },
      required: ['person', 'item'],
    },
  },
  {
    name: 'list_pending_commitments',
    description:
      '列出所有未兌現的承諾。' +
      '使用者問「我答應過誰什麼」「最近承諾」「待辦人情」之類 → 用這個查。' +
      '使用者要出門時(任何 trigger_outing_event 之後),**也要呼叫這個**,主動提醒:' +
      '「順問:你會見到誰?以下是還沒兌現的承諾 ... 要不要帶?」',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'fulfill_commitment',
    description:
      '標記某承諾已兌現。使用者說「**已經給小明了**」「**烘焙樣品交了**」→ 先 list 找 id,再用這個標完成。',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: '承諾的 id(從 list 拿)' } },
      required: ['id'],
    },
  },
];

export async function executeOutingTool(
  env: Env,
  toolName: string,
  input: any,
  userId: string
): Promise<string> {
  if (!userId) return '錯誤:沒有 userId';

  try {
    switch (toolName) {
      case 'list_outing_templates': {
        const t = await seedTemplatesIfEmpty(env, userId);
        if (Object.keys(t).length === 0) return '無任何模板';
        return JSON.stringify(t, null, 2);
      }
      case 'get_outing_template': {
        const items = await getTemplate(env, userId, input.name);
        if (!items) return `模板「${input.name}」不存在`;
        return JSON.stringify({ name: input.name, items }, null, 2);
      }
      case 'set_outing_template': {
        const t = await setTemplate(env, userId, input.name, input.items);
        return `✓ 模板「${input.name}」已設定:${t[input.name].join('、')}`;
      }
      case 'add_items_to_outing_template': {
        const next = await addItemsToTemplate(env, userId, input.name, input.items);
        return `✓「${input.name}」現在含:${next.join('、')}`;
      }
      case 'remove_items_from_outing_template': {
        const next = await removeItemsFromTemplate(env, userId, input.name, input.items);
        return `✓「${input.name}」移除完成,現在含:${next.join('、') || '(空)'}`;
      }
      case 'delete_outing_template': {
        await deleteTemplate(env, userId, input.name);
        return `✓ 已刪除模板「${input.name}」`;
      }
      case 'set_reminder': {
        // v223: 一般定時提醒(非帶東西)。時間驗證在 addAdhocReminder 內(過去時間會 throw 或自動 roll)。
        if (!input.text || !input.time_iso) {
          return '錯誤:set_reminder 必須帶 text 與 time_iso';
        }
        try {
          const r = await addAdhocReminder(env, userId, {
            items: [input.text],
            triggerType: 'time',
            timeISO: input.time_iso,
            kind: 'general',
          });
          return `✓ 已設定提醒 (id=${r.id}):「${input.text}」\n  時間:${formatLocalTime(env, r.trigger.timeISO!)}`;
        } catch (e: any) {
          return `設定失敗:${e?.message ?? e}`;
        }
      }
      case 'add_adhoc_outing_reminder': {
        // 驗證
        if (input.trigger_type === 'time' && !input.time_iso) {
          return '錯誤:trigger_type=time 必須帶 time_iso';
        }
        if (input.trigger_type === 'event' && !input.event_keyword) {
          return '錯誤:trigger_type=event 必須帶 event_keyword';
        }
        let r;
        try {
          r = await addAdhocReminder(env, userId, {
            items: input.items,
            triggerType: input.trigger_type,
            timeISO: input.time_iso,
            eventKeyword: input.event_keyword,
            notifyBeforeMin: input.notify_before_min,
            templateMerge: input.template_merge,
            note: input.note,
            kind: 'outing',
          });
        } catch (e: any) {
          return `設定失敗:${e?.message ?? e}`;
        }
        const triggerDesc =
          r.trigger.type === 'time'
            ? `${formatLocalTime(env, r.trigger.timeISO!)}${r.trigger.notifyBeforeMin ? ` (提前 ${r.trigger.notifyBeforeMin} 分)` : ''}`
            : `事件「${r.trigger.eventKeyword}」`;
        return `✓ 已加臨時提醒 (id=${r.id}):\n  項目:${r.items.join('、')}\n  觸發:${triggerDesc}\n  ${r.templateMerge ? `會併入模板:${r.templateMerge}` : ''}`;
      }
      case 'list_adhoc_outing_reminders': {
        const list = await getAdhocList(env, userId);
        const active = list.filter((r) => !r.firedAt);
        if (active.length === 0) return '目前無臨時提醒';
        return JSON.stringify(active, null, 2);
      }
      case 'cancel_adhoc_outing_reminder': {
        const ok = await cancelAdhocReminder(env, userId, input.id);
        return ok ? `✓ 已取消提醒 ${input.id}` : `找不到 id=${input.id}`;
      }
      case 'trigger_outing_event': {
        const list = await getAdhocList(env, userId);
        const matched = findAdhocByEvent(list, input.event_keyword);
        // 標記 fired
        for (const r of matched) {
          await markAdhocFired(env, userId, r.id);
        }
        // 同時拿出對應模板(如果關鍵字是出門/回家系列)
        const templateKeyword = input.event_keyword === '出門了' ? null :
                                input.event_keyword === '下班了' ? '回家' :
                                (input.event_keyword === '到家了' || input.event_keyword === '回家了') ? null : null;
        const templateItems = templateKeyword ? await getTemplate(env, userId, templateKeyword) : null;

        const adhocItems = matched.flatMap((r) => r.items);
        const allTemplateItems = new Set<string>(templateItems || []);
        // 若 adhoc 有指定 templateMerge,也合進來
        for (const r of matched) {
          if (r.templateMerge) {
            const t = await getTemplate(env, userId, r.templateMerge);
            if (t) t.forEach((x) => allTemplateItems.add(x));
          }
        }

        return JSON.stringify({
          event: input.event_keyword,
          matched_adhoc_count: matched.length,
          adhoc_items: adhocItems,
          adhoc_notes: matched.map((r) => r.note).filter(Boolean),
          template_used: templateKeyword,
          template_items: Array.from(allTemplateItems),
        }, null, 2);
      }
      case 'add_commitment': {
        const c = await addCommitment(env, userId, {
          person: input.person,
          item: input.item,
          occasion: input.occasion,
          dueBy: input.due_by,
        });
        return `✓ 已記下承諾 (id=${c.id}):${c.person} - ${c.item}${c.occasion ? ` (${c.occasion})` : ''}${c.dueBy ? `,due ${c.dueBy}` : ''}`;
      }
      case 'list_pending_commitments': {
        const list = await listPendingCommitments(env, userId);
        if (list.length === 0) return '無待兌現的承諾';
        return JSON.stringify(list, null, 2);
      }
      case 'fulfill_commitment': {
        const ok = await fulfillCommitment(env, userId, input.id);
        return ok ? `✓ 已標記承諾 ${input.id} 兌現` : `找不到 id=${input.id}`;
      }
      default:
        return `Unknown outing tool: ${toolName}`;
    }
  } catch (e: any) {
    return `Tool error: ${e?.message ?? e}`;
  }
}

// 給 dispatch 用的工具名集合(避免 if-else 鏈寫太亂)
export const OUTING_TOOL_NAMES = new Set(OUTING_TOOLS.map((t) => t.name));
