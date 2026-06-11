/**
 * 綁定提醒(功能 2)— 綁定流程(fast-path 指令,不過 Claude)
 *
 *   主帳號:「綁定子帳號 小明」 → 產生 6 碼(24h),給子帳號
 *   子帳號:「綁定 123456」   → 驗碼 + 建關係 + 回報給主帳號
 *
 * 白名單(ALLOWED_LINE_USER_IDS)放行:未綁定的子帳號第一則「綁定 NNNNNN」必須能穿過白名單,
 *   否則子帳號連綁都綁不了 → isBindingCommand 供 handler 在白名單檢查時放行此 pattern。
 */

import type { Env } from '../types';
import { createInviteCode, redeemInviteCode, resolveChildByLabel, revokeChild } from './store';

const REDEEM_RE = /^綁定\s*(\d{6})$/;
const BARE_CODE_RE = /^(\d{6})$/; // 直接傳 6 位數字也能綁定
// 同時收新詞「子帳號」與舊詞「小孩」(向後相容:既有使用者習慣的「綁定小孩 X」不失效)
const GEN_RE = /^(?:綁定|新增|加|綁)(?:子帳號|小孩)\s*(.*)$/;
const UNBIND_RE = /^(?:解除綁定|取消綁定|解綁)\s*(.*)$/;

/** 白名單放行用:是否為子帳號收碼訊息(「綁定 123456」或直接「123456」)— 未綁定的子帳號第一則需放行。 */
export function isBindingCommand(text: string): boolean {
  const t = (text || '').trim();
  return REDEEM_RE.test(t) || BARE_CODE_RE.test(t);
}

export interface FamilyBindResult {
  matched: boolean;
  reply?: string;
  /** 綁定成功時,額外主動通知主帳號 */
  notifyParent?: { userId: string; text: string };
}

/** fast-path:處理主帳號產碼 + 子帳號收碼。 */
export async function tryFamilyBindCommand(
  env: Env,
  userId: string,
  text: string
): Promise<FamilyBindResult> {
  const t = (text || '').trim();

  // 主帳號產碼:「綁定子帳號 小明」
  const gen = t.match(GEN_RE);
  if (gen) {
    const label = (gen[1] || '').trim() || null;
    try {
      const code = await createInviteCode(env, userId, label);
      const who = label ? `「${label}」` : '子帳號';
      return {
        matched: true,
        reply:
          `✓ 已產生綁定碼(24 小時內有效):\n\n` +
          `　　${code}\n\n` +
          `把這組 6 位數字給${who},請${who}用 LINE 加我好友後,直接傳「${code}」給我就完成。\n` +
          (label ? '' : '(提示:打「綁定子帳號 小明」可順便幫他取暱稱,設提醒時比較好叫)'),
      };
    } catch (e: any) {
      return { matched: true, reply: `產碼失敗:${e?.message ?? e},請再試一次` };
    }
  }

  // 主帳號解綁:「解除綁定 小明」
  const unbind = t.match(UNBIND_RE);
  if (unbind) {
    const label = (unbind[1] || '').trim();
    if (!label) return { matched: true, reply: '要解除哪個子帳號?例:「解除綁定 小明」' };
    const r = await resolveChildByLabel(env, userId, label);
    if (!r.childUserId) {
      const names = (r.candidates || []).map((k) => k.childLabel || '(未命名)');
      return {
        matched: true,
        reply: names.length ? `找不到「${label}」。你綁定的有:${names.join('、')}。` : '你目前沒有綁定任何子帳號。',
      };
    }
    await revokeChild(env, userId, r.childUserId);
    return { matched: true, reply: `✓ 已解除與「${label}」的綁定,相關提醒一併移除。` };
  }

  // 子帳號收碼:「綁定 123456」或直接「123456」
  const red = t.match(REDEEM_RE);
  const bare = red ? null : t.match(BARE_CODE_RE);
  if (red || bare) {
    const code = (red || bare)![1];
    const r = await redeemInviteCode(env, code, userId);
    if (!r.ok) {
      // 純數字若查無此碼 → 不攔截,交回正常流程(避免把隨機 6 位數字當成綁定失敗)
      if (bare && (r.error || '').includes('查無')) return { matched: false };
      return { matched: true, reply: `綁定失敗:${r.error}` };
    }
    const childName = r.childLabel || '子帳號';
    return {
      matched: true,
      reply: `✓ 綁定成功!之後收到主帳號設的提醒,做完按「✓ 完成」就會回報給主帳號。`,
      notifyParent: {
        userId: r.parentUserId!,
        text:
          `✓ ${childName} 已完成綁定。\n` +
          `現在你可以對我說「每天早上 8 點提醒${r.childLabel || '他'}刷牙」這類,` +
          `我就會到點提醒${r.childLabel || '他'},做了沒也會回報給你。`,
      },
    };
  }

  return { matched: false };
}
