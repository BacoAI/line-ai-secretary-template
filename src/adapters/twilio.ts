/**
 * Twilio 電話介入整合(v213)
 *
 * 用途:反拖延 / 重要提醒時,主動「打電話」給使用者,用人聲念出內容逼他行動。
 *        比 Pushover Critical Alerts 更強烈(Pushover 是被動響鈴,電話是主動催)。
 *
 * 架構重點:
 *   - 用 Twilio Programmable Voice 的 Call resource,**直接內嵌 TwiML**(Twiml 參數,優先於 Url)
 *     → Cloudflare Workers 不需要另外架 webhook endpoint,撥號時把要念的話塞進去即可。
 *   - 中文 TTS:Amazon Polly 不支援台灣中文(cmn-TW),只有大陸普通話(cmn-CN)。
 *     台灣中文要用 Google voice:<Say language="cmn-TW" voice="Google.cmn-TW-Standard-A">。
 *     (voice 名稱以 Twilio 官方 TTS 文件為準,若失效改用其他 cmn-TW Google voice 或 cmn-CN Polly)
 *
 * 啟用流程(MVP 個人版,走 env secret):
 *   1. 開發者註冊 Twilio 帳號,驗證自己的手機(trial 只能打已驗證號碼)
 *   2. 拿 Account SID / Auth Token / trial 號碼
 *   3. wrangler secret put TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER / USER_PHONE_NUMBER
 *
 * 預設行為:沒設齊 secret → isTwilioConfigured() 回 false,placeCall() no-op 回錯誤碼,不會炸。
 *
 * TODO(商品化):USER_PHONE_NUMBER 改成 per-user(users.phoneNumber + 設定指令),
 *                Twilio 帳號可共用(開發者的)或讓學員各自帶。
 */

import type { Env } from '../core/types';

// 台灣中文 TTS(Polly 無 cmn-TW,用 Google voice)
const TW_TTS_LANG = 'cmn-TW';
const TW_TTS_VOICE = 'Google.cmn-TW-Wavenet-A'; // 台灣腔 Wavenet(實測最自然;Standard 較生硬)

export interface PlaceCallResult {
  ok: boolean;
  sid?: string;
  error?: string; // 'twilio-not-configured' | 'no-user-number' | HTTP 錯誤字串
}

/** XML 跳脫,避免提醒內容含 & < > 把 TwiML 弄壞 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 組單向念稿 TwiML:念兩次 + 中間停頓,確保接通的人聽清楚 */
export function buildSayTwiml(message: string): string {
  const safe = escapeXml(message);
  const say = `<Say language="${TW_TTS_LANG}" voice="${TW_TTS_VOICE}">${safe}</Say>`;
  return `<Response>${say}<Pause length="1"/>${say}</Response>`;
}

/** 是否已設齊 Twilio 撥號需要的 secret(帳號 + token + 來電號碼) */
export function isTwilioConfigured(env: Env): boolean {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
}

/**
 * 撥打電話並用 TTS 念出 message。
 * @param toNumber E.164 格式(例 +886912345678);未給則用 env.USER_PHONE_NUMBER
 */
export async function placeCall(env: Env, message: string, toNumber?: string): Promise<PlaceCallResult> {
  if (!isTwilioConfigured(env)) return { ok: false, error: 'twilio-not-configured' };
  const to = toNumber || env.USER_PHONE_NUMBER;
  if (!to) return { ok: false, error: 'no-user-number' };

  const sid = env.TWILIO_ACCOUNT_SID!;
  const token = env.TWILIO_AUTH_TOKEN!;
  const from = env.TWILIO_PHONE_NUMBER!;
  const twiml = buildSayTwiml(message);
  const body = new URLSearchParams({ To: to, From: from, Twiml: twiml });
  const auth = btoa(`${sid}:${token}`);

  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!r.ok) {
      const txt = await r.text();
      console.warn('[twilio] call failed', r.status, txt.substring(0, 300));
      return { ok: false, error: `${r.status}: ${txt.substring(0, 300)}` };
    }
    const j: any = await r.json();
    return { ok: true, sid: j.sid };
  } catch (err: any) {
    console.error('[twilio] call exception', err?.message ?? err);
    return { ok: false, error: err?.message ?? String(err) };
  }
}
