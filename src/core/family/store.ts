/**
 * 綁定提醒(功能 2)— family D1 store
 *
 * 三張表(見 db/migrations/0002_family.sql):
 *   family_links       主帳號 ↔ 子帳號 綁定關係(多主帳號/多子帳號皆可)
 *   invite_codes       一次性綁定碼
 *   assigned_reminders 主帳號指派給子帳號的提醒「模板」(只有主帳號能改/停)
 *
 * 防亂關核心:子帳號沒有任何路徑碰得到 assigned_reminders → 提醒停不掉、刪不掉。
 * 所有「改/停/刪」一律帶 creator_user_id 條件,確保只有主帳號本人能動自己建的提醒。
 */

import type { Env } from '../types';
import { setChildPolicy } from './child-policy';

export interface FamilyChild {
  childUserId: string;
  childLabel: string | null;
}

export interface AssignedReminder {
  id: string;
  creatorUserId: string;
  assigneeUserId: string;
  text: string;
  timeHhmm: string; // 'HH:MM'
  daysOfWeek: string | null; // null=每天;否則 '1,2,3,4,5'(1=Mon..7=Sun)
  onceDate: string | null; // null=循環;'YYYY-MM-DD'=一次性(臨時)
  enabled: boolean;
}

const CODE_TTL_HOURS = 24;

function gen6(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ============== 綁定碼 ==============

/** 主帳號產生一次性綁定碼(24h 有效)。回 code 字串。 */
export async function createInviteCode(
  env: Env,
  parentUserId: string,
  childLabel: string | null
): Promise<string> {
  const expiresAt = new Date(Date.now() + CODE_TTL_HOURS * 3600_000).toISOString();
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = gen6();
    try {
      await env.DB.prepare(
        `INSERT INTO invite_codes (code, parent_user_id, child_label, expires_at) VALUES (?, ?, ?, ?)`
      )
        .bind(code, parentUserId, childLabel, expiresAt)
        .run();
      return code;
    } catch {
      // PK 撞碼(極罕見)→ 重產
    }
  }
  throw new Error('產碼失敗,請再試一次');
}

export interface RedeemResult {
  ok: boolean;
  error?: string;
  parentUserId?: string;
  childLabel?: string | null;
}

/** 子帳號用碼綁定。驗證(存在/未過期/未使用)→ 建/重啟 family_link + 標記用過。 */
export async function redeemInviteCode(
  env: Env,
  code: string,
  childUserId: string
): Promise<RedeemResult> {
  const row = await env.DB.prepare(
    `SELECT code, parent_user_id, child_label, expires_at, used_at FROM invite_codes WHERE code = ?`
  )
    .bind(code)
    .first<{
      code: string;
      parent_user_id: string;
      child_label: string | null;
      expires_at: string;
      used_at: string | null;
    }>();

  if (!row) return { ok: false, error: '查無此綁定碼,請確認主帳號給的 6 位數字' };
  if (row.used_at) return { ok: false, error: '這個綁定碼已經用過了,請主帳號重新產一組' };
  if (new Date(row.expires_at).getTime() < Date.now())
    return { ok: false, error: '綁定碼已過期(超過 24 小時),請主帳號重新產一組' };

  const parentUserId = row.parent_user_id;
  // 允許「綁定自己」:單帳號測試(一人同時當主帳號+子帳號,兩種訊息都進自己這支手機),
  //   也支援「幫自己設固定提醒走家庭路徑」。正常親子情境 child≠parent,此情況不影響。

  // 建 link(已存在就忽略),再 UPDATE 確保 active + 更新暱稱(處理「曾解除後重綁」)
  await env.DB.prepare(
    `INSERT OR IGNORE INTO family_links (id, parent_user_id, child_user_id, child_label, status)
     VALUES (?, ?, ?, ?, 'active')`
  )
    .bind(crypto.randomUUID(), parentUserId, childUserId, row.child_label)
    .run();
  await env.DB.prepare(
    `UPDATE family_links SET status='active', child_label=? WHERE parent_user_id=? AND child_user_id=?`
  )
    .bind(row.child_label, parentUserId, childUserId)
    .run();

  await env.DB.prepare(`UPDATE invite_codes SET used_at=?, used_by_user_id=? WHERE code=?`)
    .bind(new Date().toISOString(), childUserId, code)
    .run();

  // v229:綁定時主帳號若宣告「成年」,產碼端會在 KV 標記 invite-adult:<code>。
  //   收碼成功 → 把該子帳號政策設成 isMinor=false(開放一般使用);否則維持預設未成年(保守)。
  if (env.CACHE) {
    try {
      if (await env.CACHE.get(`invite-adult:${code}`)) {
        await setChildPolicy(env, childUserId, { isMinor: false });
        await env.CACHE.delete(`invite-adult:${code}`);
      }
    } catch (e) {
      console.warn('[family] apply adult flag on redeem failed:', e);
    }
  }

  return { ok: true, parentUserId, childLabel: row.child_label };
}

// ============== 綁定關係查詢 ==============

/** 此 userId 是否為「已綁定的家庭成員」(主帳號或子帳號)。白名單放行用,只在白名單未命中時查。 */
export async function isKnownFamilyMember(env: Env, userId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS x FROM family_links WHERE status='active' AND (parent_user_id=? OR child_user_id=?) LIMIT 1`
    )
      .bind(userId, userId)
      .first();
    return !!row;
  } catch {
    return false;
  }
}

/** 主帳號的所有子帳號(active)。 */
export async function getChildrenOf(env: Env, parentUserId: string): Promise<FamilyChild[]> {
  const res = await env.DB.prepare(
    `SELECT child_user_id, child_label FROM family_links WHERE parent_user_id=? AND status='active' ORDER BY created_at`
  )
    .bind(parentUserId)
    .all<{ child_user_id: string; child_label: string | null }>();
  return (res.results || []).map((r) => ({ childUserId: r.child_user_id, childLabel: r.child_label }));
}

/** 解除綁定:標 link revoked + 刪掉該主帳號給該子帳號的所有指派提醒。 */
export async function revokeChild(env: Env, parentUserId: string, childUserId: string): Promise<void> {
  await env.DB.prepare(`UPDATE family_links SET status='revoked' WHERE parent_user_id=? AND child_user_id=?`)
    .bind(parentUserId, childUserId)
    .run();
  await env.DB.prepare(`DELETE FROM assigned_reminders WHERE creator_user_id=? AND assignee_user_id=?`)
    .bind(parentUserId, childUserId)
    .run();
}

/** 取某主帳號眼中某子帳號的暱稱(回報訊息用)。查無回「子帳號」。 */
export async function getChildLabel(env: Env, parentUserId: string, childUserId: string): Promise<string> {
  try {
    const r = await env.DB.prepare(
      `SELECT child_label FROM family_links WHERE parent_user_id=? AND child_user_id=? AND status='active'`
    )
      .bind(parentUserId, childUserId)
      .first<{ child_label: string | null }>();
    return r?.child_label || '子帳號';
  } catch {
    return '子帳號';
  }
}

/** 子帳號的所有主帳號 userId(active)。 */
export async function getParentsOf(env: Env, childUserId: string): Promise<string[]> {
  const res = await env.DB.prepare(
    `SELECT parent_user_id FROM family_links WHERE child_user_id=? AND status='active'`
  )
    .bind(childUserId)
    .all<{ parent_user_id: string }>();
  return (res.results || []).map((r) => r.parent_user_id);
}

/** 以暱稱解析主帳號底下的某個子帳號 → childUserId。找不到/模糊時回候選清單供工具提示。 */
export async function resolveChildByLabel(
  env: Env,
  parentUserId: string,
  label: string
): Promise<{ childUserId?: string; candidates?: FamilyChild[] }> {
  const kids = await getChildrenOf(env, parentUserId);
  if (kids.length === 0) return { candidates: [] };
  const l = label.trim();
  const exact = kids.filter((k) => (k.childLabel || '').trim() === l);
  if (exact.length === 1) return { childUserId: exact[0].childUserId };
  const partial = kids.filter(
    (k) => (k.childLabel || '').includes(l) || (l.length > 0 && l.includes((k.childLabel || '').trim()))
  );
  if (partial.length === 1) return { childUserId: partial[0].childUserId };
  if (partial.length > 1) return { candidates: partial };
  return { candidates: kids };
}

// ============== 指派提醒模板(只有主帳號能改/停/刪) ==============

function rowToAssigned(r: {
  id: string;
  creator_user_id: string;
  assignee_user_id: string;
  text: string;
  time_hhmm: string;
  days_of_week: string | null;
  once_date: string | null;
  enabled: number;
}): AssignedReminder {
  return {
    id: r.id,
    creatorUserId: r.creator_user_id,
    assigneeUserId: r.assignee_user_id,
    text: r.text,
    timeHhmm: r.time_hhmm,
    daysOfWeek: r.days_of_week,
    onceDate: r.once_date,
    enabled: !!r.enabled,
  };
}

type AssignedRow = Parameters<typeof rowToAssigned>[0];

export async function createAssignedReminder(
  env: Env,
  a: {
    creatorUserId: string;
    assigneeUserId: string;
    text: string;
    timeHhmm: string;
    daysOfWeek?: string | null;
    onceDate?: string | null;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO assigned_reminders (id, creator_user_id, assignee_user_id, text, time_hhmm, days_of_week, once_date, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  )
    .bind(id, a.creatorUserId, a.assigneeUserId, a.text, a.timeHhmm, a.daysOfWeek ?? null, a.onceDate ?? null)
    .run();
  return id;
}

/** 清掉所有過期的一次性提醒(once_date < today)。cron 每輪呼叫一次,維持表乾淨。 */
export async function deletePastOnceReminders(env: Env, today: string): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM assigned_reminders WHERE once_date IS NOT NULL AND once_date < ?`)
      .bind(today)
      .run();
  } catch (e) {
    console.warn('[family] cleanup past once reminders failed:', e);
  }
}

/** 列某主帳號指派的提醒(可選某子帳號)。 */
export async function listAssignedReminders(
  env: Env,
  creatorUserId: string,
  assigneeUserId?: string
): Promise<AssignedReminder[]> {
  const res = assigneeUserId
    ? await env.DB.prepare(
        `SELECT * FROM assigned_reminders WHERE creator_user_id=? AND assignee_user_id=? ORDER BY time_hhmm`
      )
        .bind(creatorUserId, assigneeUserId)
        .all<AssignedRow>()
    : await env.DB.prepare(
        `SELECT * FROM assigned_reminders WHERE creator_user_id=? ORDER BY assignee_user_id, time_hhmm`
      )
        .bind(creatorUserId)
        .all<AssignedRow>();
  return (res.results || []).map(rowToAssigned);
}

/** 取某子帳號所有「啟用中」的指派提醒(cron 物化用)。 */
export async function getEnabledAssignedForChild(
  env: Env,
  childUserId: string
): Promise<AssignedReminder[]> {
  const res = await env.DB.prepare(`SELECT * FROM assigned_reminders WHERE assignee_user_id=? AND enabled=1`)
    .bind(childUserId)
    .all<AssignedRow>();
  return (res.results || []).map(rowToAssigned);
}

/** 改提醒時間(限 creator)。 */
export async function updateAssignedTime(
  env: Env,
  creatorUserId: string,
  id: string,
  timeHhmm: string
): Promise<void> {
  await env.DB.prepare(`UPDATE assigned_reminders SET time_hhmm=?, updated_at=? WHERE id=? AND creator_user_id=?`)
    .bind(timeHhmm, new Date().toISOString(), id, creatorUserId)
    .run();
}

/** 啟用/停用(限 creator)。 */
export async function setAssignedEnabled(
  env: Env,
  creatorUserId: string,
  id: string,
  enabled: boolean
): Promise<void> {
  await env.DB.prepare(`UPDATE assigned_reminders SET enabled=?, updated_at=? WHERE id=? AND creator_user_id=?`)
    .bind(enabled ? 1 : 0, new Date().toISOString(), id, creatorUserId)
    .run();
}

/** 刪除(限 creator)。 */
export async function deleteAssigned(env: Env, creatorUserId: string, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM assigned_reminders WHERE id=? AND creator_user_id=?`)
    .bind(id, creatorUserId)
    .run();
}
