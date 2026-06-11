/**
 * v191: 出門/回家提醒 — 模板 + ad-hoc + 承諾追蹤
 *
 * KV keys:
 *   outing-templates:{userId}    = JSON Record<string, string[]>(模板名 → items)
 *   outing-adhoc:{userId}        = JSON AdhocReminder[](臨時提醒)
 *   commitments:{userId}         = JSON Commitment[](承諾誰帶什麼)
 *
 * 學員相容:KV 沒值 → 第一次用會 seed 預設模板(中性骨架);
 *           商品化時學員自行對 bot 講「改成 X」即可,不需要重新部署。
 *
 * 對學員的 Claude 友善:
 *  - 所有資料結構集中此檔
 *  - 模板預設值 separate 抽出 templates.ts,改起來不會誤動邏輯
 *  - 換 KV/storage 後端只需改本檔
 */

import type { Env } from '../types';
import { DEFAULT_OUTING_TEMPLATES } from './templates';

// ============== Types ==============

export type OutingTemplates = Record<string, string[]>;

export interface AdhocReminder {
  id: string;
  items: string[];
  // v223: 區分提醒種類 — 'outing'=帶東西/出門(📦 卡片);'general'=一般定時提醒(🔔 卡片)。
  //   舊資料無此欄 → 視為 'outing'(向後相容)。
  kind?: 'outing' | 'general';
  trigger: {
    type: 'time' | 'event';
    timeISO?: string;
    eventKeyword?: string;
    notifyBeforeMin?: number;
  };
  templateMerge?: string;
  note?: string;
  createdAt: string;
  firedAt?: string;
  expiresAt: string;
}

export interface Commitment {
  id: string;
  person: string;
  item: string;
  occasion?: string;
  dueBy?: string;
  createdAt: string;
  fulfilledAt?: string;
  lastRemindedAt?: string;
}

// ============== Helpers ==============

function shortId(): string {
  return Math.random().toString(36).slice(2, 9);
}

function nowISO(): string {
  return new Date().toISOString();
}

function plusHoursISO(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

// v223: 把 ISO 時間格式成當地(預設台北)可讀字串,給確認訊息/錯誤訊息用。
export function formatLocalTime(env: Env, iso: string): string {
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: env.TIMEZONE || 'Asia/Taipei',
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// v211: 「今天結束(當地時區 23:59:59)」的 ISO — 事件型出門提醒用,讓它隔天自動過期清掉
// P0-13: 時區改讀 env.TIMEZONE(預設 'Asia/Taipei'),不再寫死 UTC+8
function endOfTodayLocalISO(env: Env): string {
  const tz = env.TIMEZONE || 'Asia/Taipei';
  const now = new Date();
  // 取得當地時區的「現在」年/月/日 + 與 UTC 的偏移(分鐘),據此算當地當天 23:59:59 的 UTC 時間
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || '0', 10);
  const y = get('year'), mo = get('month'), d = get('day');
  let h = get('hour'); if (h === 24) h = 0; // Intl 在某些環境午夜回 24
  const mi = get('minute'), s = get('second');
  // 當地此刻對應的 UTC 毫秒(用當地 wall-clock 反推),用以求出此時區與 UTC 的偏移
  const asUtcForLocalNow = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetMs = asUtcForLocalNow - (now.getTime() - (now.getTime() % 1000));
  // 當地當天 23:59:59 的 wall-clock,扣掉偏移 → UTC
  const endLocalWall = Date.UTC(y, mo - 1, d, 23, 59, 59);
  return new Date(endLocalWall - offsetMs).toISOString();
}

// ============== Templates ==============

export async function getTemplates(env: Env, userId: string): Promise<OutingTemplates> {
  if (!env.CACHE) return {};
  try {
    const v = await env.CACHE.get(`outing-templates:${userId}`);
    if (!v) return {};
    return JSON.parse(v);
  } catch {
    return {};
  }
}

export async function seedTemplatesIfEmpty(env: Env, userId: string): Promise<OutingTemplates> {
  const cur = await getTemplates(env, userId);
  if (Object.keys(cur).length > 0) return cur;
  await setTemplates(env, userId, DEFAULT_OUTING_TEMPLATES);
  return DEFAULT_OUTING_TEMPLATES;
}

export async function setTemplates(env: Env, userId: string, t: OutingTemplates): Promise<void> {
  if (!env.CACHE) return;
  await env.CACHE.put(`outing-templates:${userId}`, JSON.stringify(t));
}

export async function setTemplate(env: Env, userId: string, name: string, items: string[]): Promise<OutingTemplates> {
  const t = await getTemplates(env, userId);
  const norm = Array.from(new Set(items.map((s) => s.trim()).filter(Boolean)));
  t[name] = norm;
  await setTemplates(env, userId, t);
  return t;
}

export async function addItemsToTemplate(env: Env, userId: string, name: string, add: string[]): Promise<string[]> {
  const t = await getTemplates(env, userId);
  const cur = t[name] || [];
  const next = Array.from(new Set([...cur, ...add.map((s) => s.trim()).filter(Boolean)]));
  t[name] = next;
  await setTemplates(env, userId, t);
  return next;
}

export async function removeItemsFromTemplate(env: Env, userId: string, name: string, remove: string[]): Promise<string[]> {
  const t = await getTemplates(env, userId);
  if (!t[name]) return [];
  const rmSet = new Set(remove.map((s) => s.trim()));
  const next = t[name].filter((x) => !rmSet.has(x));
  t[name] = next;
  await setTemplates(env, userId, t);
  return next;
}

export async function deleteTemplate(env: Env, userId: string, name: string): Promise<void> {
  const t = await getTemplates(env, userId);
  delete t[name];
  await setTemplates(env, userId, t);
}

export async function getTemplate(env: Env, userId: string, name: string): Promise<string[] | null> {
  const t = await getTemplates(env, userId);
  return t[name] ?? null;
}

// ============== Base kit(固定必帶)==============
// v225: 「無論去哪都帶」的底層清單(鑰匙/錢包/手機),情境模板只放 delta。
//   抽出來讓 bot 知道你的「絕對必需品」(懂你的第一步)+ 模板更乾淨 + 學員最好問的個人化起點。
//   KV key: outing-basekit:{userId};未設過 → 回中性預設(可對 bot 講「固定必帶加 X」修改)。
export const DEFAULT_BASE_KIT = ['鑰匙', '錢包', '手機'];

export async function getBaseKit(env: Env, userId: string): Promise<string[]> {
  if (!env.CACHE) return [...DEFAULT_BASE_KIT];
  try {
    const v = await env.CACHE.get(`outing-basekit:${userId}`);
    if (v == null) return [...DEFAULT_BASE_KIT];
    return JSON.parse(v);
  } catch {
    return [...DEFAULT_BASE_KIT];
  }
}

export async function setBaseKit(env: Env, userId: string, items: string[]): Promise<string[]> {
  const norm = Array.from(new Set(items.map((s) => s.trim()).filter(Boolean)));
  if (env.CACHE) await env.CACHE.put(`outing-basekit:${userId}`, JSON.stringify(norm));
  return norm;
}

// ============== 回饋圈:常帶頻率(Phase 2「懂你」)==============
// v226: 每次使用者臨時加帶東西就 +1;達門檻且還沒固定 → 主動建議加進 base kit / 模板。
//   KV key: bring-freq:{userId} = { item: count }(單一 key,好讀好列)。
export const BRING_REGULAR_THRESHOLD = 3;

export async function getBringFreq(env: Env, userId: string): Promise<Record<string, number>> {
  if (!env.CACHE) return {};
  try {
    const v = await env.CACHE.get(`bring-freq:${userId}`);
    return v ? JSON.parse(v) : {};
  } catch {
    return {};
  }
}

export async function recordBringItems(env: Env, userId: string, items: string[]): Promise<void> {
  if (!env.CACHE) return;
  const map = await getBringFreq(env, userId);
  for (const it of items) {
    const k = it.trim();
    if (k) map[k] = (map[k] || 0) + 1;
  }
  await env.CACHE.put(`bring-freq:${userId}`, JSON.stringify(map));
}

/** 已固定的東西(base kit + 所有模板)→ 建議時要排除這些 */
export async function getAlreadyRegularItems(env: Env, userId: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    (await getBaseKit(env, userId)).forEach((s) => set.add(s.trim()));
    const tpls = await getTemplates(env, userId);
    Object.values(tpls).forEach((arr) => arr.forEach((s) => set.add(s.trim())));
  } catch (e: any) {
    // v226(Phase2 審查):別靜默 — 失敗回空集合會讓「排除已固定」失效 → 可能建議已固定的東西。
    console.warn('[bring] getAlreadyRegularItems 失敗,排除集合為空:', e?.message ?? e);
  }
  return set;
}

/** 達門檻、又還沒固定的「常帶」項目(給主動建議用) */
export async function getSuggestedRegulars(env: Env, userId: string): Promise<Array<{ item: string; count: number }>> {
  const [freq, already] = await Promise.all([getBringFreq(env, userId), getAlreadyRegularItems(env, userId)]);
  return Object.entries(freq)
    .filter(([item, count]) => count >= BRING_REGULAR_THRESHOLD && !already.has(item.trim()))
    .map(([item, count]) => ({ item, count }))
    .sort((a, b) => b.count - a.count);
}

// ============== Ad-hoc reminders ==============

export async function getAdhocList(env: Env, userId: string): Promise<AdhocReminder[]> {
  if (!env.CACHE) return [];
  try {
    const v = await env.CACHE.get(`outing-adhoc:${userId}`);
    if (!v) return [];
    return JSON.parse(v);
  } catch {
    return [];
  }
}

export async function setAdhocList(env: Env, userId: string, list: AdhocReminder[]): Promise<void> {
  if (!env.CACHE) return;
  await env.CACHE.put(`outing-adhoc:${userId}`, JSON.stringify(list));
}

export async function addAdhocReminder(
  env: Env,
  userId: string,
  opts: {
    items: string[];
    triggerType: 'time' | 'event';
    timeISO?: string;
    eventKeyword?: string;
    notifyBeforeMin?: number;
    templateMerge?: string;
    note?: string;
    expiresHours?: number;
    kind?: 'outing' | 'general';
  }
): Promise<AdhocReminder> {
  // v223: 時間型一律驗證,避免「過去時間 → 下一個 cron tick 立刻誤觸發」(LINE 提醒沒響的根因)。
  let finalTimeISO = opts.timeISO;
  if (opts.triggerType === 'time' && opts.timeISO) {
    const t = Date.parse(opts.timeISO);
    if (Number.isNaN(t)) throw new Error(`時間格式無法解析:${opts.timeISO}`);
    const before = (opts.notifyBeforeMin ?? 0) * 60 * 1000;
    const now = Date.now();
    const fireAt = t - before;
    if (fireAt <= now) {
      const pastByMs = now - fireAt;
      if (pastByMs < 24 * 3600 * 1000) {
        // 常見錯誤:把「明天 X 點」誤算成「今天 X 點」(已過)→ 自動往後滾一天,救回使用者真正要的時間。
        finalTimeISO = new Date(t + 24 * 3600 * 1000).toISOString();
      } else {
        // 過去超過一天 → 多半是日期算錯較離譜,報錯逼上層(Claude)用正確未來時間重設。
        throw new Error(
          `指定的時間已經過了(${formatLocalTime(env, opts.timeISO)}),現在是 ${formatLocalTime(env, new Date().toISOString())}。請改用未來的時間,並算對「明天/後天」的日期。`
        );
      }
    }
  }
  const list = await getAdhocList(env, userId);
  const r: AdhocReminder = {
    id: shortId(),
    items: opts.items.map((s) => s.trim()).filter(Boolean),
    kind: opts.kind ?? 'outing',
    trigger: {
      type: opts.triggerType,
      timeISO: finalTimeISO,
      eventKeyword: opts.eventKeyword,
      notifyBeforeMin: opts.notifyBeforeMin,
    },
    templateMerge: opts.templateMerge,
    note: opts.note,
    createdAt: nowISO(),
    // v211: 事件型(出門了/到公司…)預設「當天結束就過期」— 昨天的出門清單不該留到今天還活著。
    // v223: 時間型過期改「以觸發時間為基準 +6h」(原本寫死 +24h → 設更遠的提醒會在觸發前就被 cleanup 清掉)。
    //   有顯式 expiresHours 就照給。
    expiresAt: opts.expiresHours != null
      ? plusHoursISO(opts.expiresHours)
      : (opts.triggerType === 'event'
          ? endOfTodayLocalISO(env)
          : (finalTimeISO
              ? new Date(Date.parse(finalTimeISO) + 6 * 3600 * 1000).toISOString()
              : plusHoursISO(24))),
  };
  list.push(r);
  await setAdhocList(env, userId, list);
  // v226 回饋圈:帶東西類(非一般定時提醒)記頻率,供「常帶 → 建議固定」。
  if (r.kind !== 'general' && r.items.length) {
    try { await recordBringItems(env, userId, r.items); } catch { /* 記錄失敗不影響主流程 */ }
  }
  return r;
}

export async function cancelAdhocReminder(env: Env, userId: string, id: string): Promise<boolean> {
  const list = await getAdhocList(env, userId);
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  await setAdhocList(env, userId, next);
  return true;
}

export async function markAdhocFired(env: Env, userId: string, id: string): Promise<void> {
  const list = await getAdhocList(env, userId);
  const item = list.find((r) => r.id === id);
  if (!item) return;
  item.firedAt = nowISO();
  await setAdhocList(env, userId, list);
}

/** 清掉過期 / 已 fired 的 ad-hoc(每分鐘 cron 順手跑) */
export async function cleanupExpiredAdhoc(env: Env, userId: string): Promise<number> {
  const list = await getAdhocList(env, userId);
  const now = Date.now();
  const next = list.filter((r) => {
    if (r.firedAt) return false; // 已 fire,清掉
    const exp = new Date(r.expiresAt).getTime();
    if (exp < now) return false; // 過期,清掉
    return true;
  });
  if (next.length !== list.length) {
    await setAdhocList(env, userId, next);
  }
  return list.length - next.length;
}

/** Cron 找該 fire 的時間型 ad-hoc(notifyBeforeMin 已扣) */
export function findDueAdhocByTime(list: AdhocReminder[], nowMs: number): AdhocReminder[] {
  return list.filter((r) => {
    if (r.firedAt) return false;
    if (r.trigger.type !== 'time') return false;
    if (!r.trigger.timeISO) return false;
    const t = new Date(r.trigger.timeISO).getTime();
    const before = (r.trigger.notifyBeforeMin ?? 0) * 60 * 1000;
    return nowMs >= (t - before);
  });
}

/** 事件型 ad-hoc:user 講「下班了」之類 → 找匹配的 */
export function findAdhocByEvent(list: AdhocReminder[], eventKeyword: string): AdhocReminder[] {
  const norm = eventKeyword.trim();
  const now = Date.now();
  return list.filter((r) => {
    if (r.firedAt) return false;
    if (r.expiresAt && new Date(r.expiresAt).getTime() < now) return false; // v211: 過期的事件提醒不觸發(隔天的別跳)
    if (r.trigger.type !== 'event') return false;
    if (!r.trigger.eventKeyword) return false;
    return r.trigger.eventKeyword === norm;
  });
}

// ============== Commitments ==============

export async function getCommitments(env: Env, userId: string): Promise<Commitment[]> {
  if (!env.CACHE) return [];
  try {
    const v = await env.CACHE.get(`commitments:${userId}`);
    if (!v) return [];
    return JSON.parse(v);
  } catch {
    return [];
  }
}

export async function setCommitments(env: Env, userId: string, list: Commitment[]): Promise<void> {
  if (!env.CACHE) return;
  await env.CACHE.put(`commitments:${userId}`, JSON.stringify(list));
}

export async function addCommitment(
  env: Env,
  userId: string,
  opts: { person: string; item: string; occasion?: string; dueBy?: string }
): Promise<Commitment> {
  const list = await getCommitments(env, userId);
  const c: Commitment = {
    id: shortId(),
    person: opts.person.trim(),
    item: opts.item.trim(),
    occasion: opts.occasion?.trim(),
    dueBy: opts.dueBy,
    createdAt: nowISO(),
  };
  list.push(c);
  await setCommitments(env, userId, list);
  return c;
}

export async function fulfillCommitment(env: Env, userId: string, id: string): Promise<boolean> {
  const list = await getCommitments(env, userId);
  const c = list.find((x) => x.id === id);
  if (!c) return false;
  c.fulfilledAt = nowISO();
  await setCommitments(env, userId, list);
  return true;
}

export async function listPendingCommitments(env: Env, userId: string): Promise<Commitment[]> {
  const list = await getCommitments(env, userId);
  return list.filter((c) => !c.fulfilledAt);
}

export async function markCommitmentReminded(env: Env, userId: string, id: string): Promise<void> {
  const list = await getCommitments(env, userId);
  const c = list.find((x) => x.id === id);
  if (!c) return;
  c.lastRemindedAt = nowISO();
  await setCommitments(env, userId, list);
}

/** Cron 找該提醒的承諾:接近 due_by 24h 內 + 過期 1 天內 */
export function findCommitmentsToRemind(list: Commitment[], nowMs: number): { type: 'due_soon' | 'overdue'; c: Commitment }[] {
  const out: { type: 'due_soon' | 'overdue'; c: Commitment }[] = [];
  for (const c of list) {
    if (c.fulfilledAt) continue;
    if (!c.dueBy) continue;
    const due = new Date(c.dueBy).getTime();
    // 1 天內提醒過就不再提
    const lastRemind = c.lastRemindedAt ? new Date(c.lastRemindedAt).getTime() : 0;
    if (nowMs - lastRemind < 24 * 3600 * 1000) continue;
    // 24h 前到 due_by 之間
    if (due - nowMs > 0 && due - nowMs <= 24 * 3600 * 1000) {
      out.push({ type: 'due_soon', c });
    } else if (nowMs - due > 0 && nowMs - due <= 24 * 3600 * 1000) {
      // 過期 1 天內
      out.push({ type: 'overdue', c });
    }
  }
  return out;
}
