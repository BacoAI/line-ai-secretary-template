/**
 * NFC 主動提醒 — Worker 入口
 *
 * 使用者在門口/包包貼一個 NFC 標籤,標籤寫死本 bot 的網址:
 *   https://<worker>/go?k=<token>
 * 手機嗶一下 → 觸發這個 GET → bot 推「今天該帶的東西」到使用者 LINE。
 *
 * 身分辨識:token 不對應寫死的開發者 id,而是查 KV `nfc-go:<token>` → userId。
 *   - 自測(路線 A):手動 wrangler kv put 一筆 token→自己的 userId。
 *   - 產品(路線 B,未來):LINE 內綁定流程現場產 token + 寫 KV,學員零改 code。
 *
 * Phase 0:先推固定文字,純粹驗證「嗶 → LINE 叮」閉環。
 * Phase 1 起:改呼叫 assembleTodayBringList(today) 推今天整張單。
 */

import type { Context } from 'hono';
import type { Env } from '../core/types';
import { assembleTodayBringList, formatBringList } from '../core/outing/assemble';
import { overlayConfig } from '../core/config/runtime-config';

export async function handleNfcGo(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = await overlayConfig(c.env); // 2a 入口覆蓋:設定 D1 優先
  const k = (c.req.query('k') || '').trim();
  if (!k) return c.text('missing k', 400);

  // token → userId(per-user 綁定,不 fallback 開發者值)
  let userId: string | null = null;
  try {
    userId = env.CACHE ? await env.CACHE.get(`nfc-go:${k}`) : null;
  } catch {
    userId = null;
  }
  if (!userId) return c.text('invalid token', 403);

  // 限流(燒錢防護):防有效 token 被狂打 → 燒 LINE push 額度。
  //   ① 冷卻:同 token 60 秒內只准觸發一次(KV TTL 下限即 60s;擋連點 / 迴圈洗,迴圈狂打只有第一發會過)。
  //   ② 每日上限:同 token 一天最多 NFC_GO_DAILY_CAP 次(預設 40),超過直接擋,不推。
  if (env.CACHE) {
    const cdKey = `nfc-cd:${k}`;
    const onCooldown = await env.CACHE.get(cdKey);
    if (onCooldown) return c.text('OK (冷卻中,剛剛已推過)', 200);
    await env.CACHE.put(cdKey, '1', { expirationTtl: 60 });

    const cap = parseInt((env as any).NFC_GO_DAILY_CAP || '40', 10);
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: env.TIMEZONE || 'Asia/Taipei',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const dayKey = `nfc-day:${k}:${day}`;
    const used = parseInt((await env.CACHE.get(dayKey)) || '0', 10);
    if (used >= cap) {
      console.warn(`[nfc-go] daily cap hit token=${k.substring(0, 4)}… used=${used}`);
      return c.text('今天觸發次數已達上限', 429);
    }
    await env.CACHE.put(dayKey, String(used + 1), { expirationTtl: 36 * 3600 });
  }

  // Phase 1:組裝今天該帶的整張單(固定必帶 + 今日臨時加 + 今日承諾 + 今日計畫出門項)。
  let msg: string;
  // Phase 2 回饋圈:quick reply 按鈕。建議直接變一鍵(點「固定加 X」→ 送出 deterministic 指令)。
  const quickItems: any[] = [
    { type: 'action', action: { type: 'message', label: '✅ 都帶了', text: '都帶了' } },
  ];
  try {
    const list = await assembleTodayBringList(env, userId, { useAI: true }); // NFC 嗶=低頻高價值,開 AI 判語意
    msg = formatBringList(list);
    for (const s of (list.suggestions || []).slice(0, 2)) {
      const label = `📌 固定加${s.item}`.slice(0, 20); // LINE label 上限 20
      quickItems.push({ type: 'action', action: { type: 'message', label, text: `固定必帶加 ${s.item}` } });
    }
  } catch (e: any) {
    console.error('[nfc-go] assemble failed', e?.message ?? e);
    msg = '📦 收到你的 NFC 嗶,但組裝今日清單時出錯了,等等再試一次。';
  }

  try {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text: msg, quickReply: { items: quickItems } }],
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error('[nfc-go] LINE push failed', r.status, body.substring(0, 200));
      return c.text(`push failed (${r.status})`, 502);
    }
  } catch (e: any) {
    console.error('[nfc-go] push error', e?.message ?? e);
    return c.text('push error', 500);
  }

  return c.text('OK — 已推到你的 LINE');
}
