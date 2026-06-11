/**
 * /setup — 安裝設定頁(自架版,取代 wrangler secret / 編設定檔)。
 *
 * 買家一鍵部署到自己的 Cloudflare 後,開這頁貼 key → 存進「他自己的 D1」(app_config)。
 * 不需要 CLI、不需要 Claude Code。
 *
 * 存取控制(bootstrap 密碼):
 *   - 首次(D1 無 setup_password_hash)→ 輸入 SETUP_TOKEN(安裝權杖)+ 設定一組設定密碼。
 *   - 之後 → 輸密碼登入 → session 存 KV(setup-session:<token>,TTL 1h)→ cookie(HttpOnly/Secure/SameSite=Strict)。
 *
 * 加固(2026-06-10,健檢項 2+5):
 *   - SETUP_TOKEN 必設(fail-closed):尚未設密碼且 env 沒有 SETUP_TOKEN → 拒絕初始化、顯示補設指引。
 *     堵「部署到首次設密碼之間被搶設」的空窗;範本部署表單會強制買家填(.env.example 機制)。
 *   - 暴力破解鎖定:密碼或權杖連錯 LOGIN_MAX_FAILS 次 → 全域鎖 LOGIN_LOCK_TTL_SEC 秒(KV)。
 *     此鎖只擋「低速循序騷擾」:KV 計數是非原子 read-modify-write 且最終一致,蓄意高併發 /
 *     跨節點分散爆破可大幅衝破上限(放行量遠不止幾次),鎖近乎失效。真正的防線是下層強度 ——
 *     密碼 ≥12 碼 + PBKDF2 10 萬次 + 權杖 ≥12 碼亂碼,即使完全無鎖,線上爆破仍不可行。
 *     單租戶 hobby bot 不值得為此上 Durable Object 原子計數,故維持 KV 輕量鎖。
 *
 * 安全:secret 欄位只顯示「已設定 / 留空不變」、不回顯原值;reflected 值一律 escapeHtml;
 *       cookie 走 KV session 不簽 cookie(token 隨機 + server 端驗);
 *       密碼雜湊與權杖比對走 SHA-256 摘要 + 恆定時間比較(不漏長度與前綴);
 *       登入後可在設定頁底部「變更設定密碼」(驗舊密碼 → 換新 salt+hash)。
 */

import type { Context } from 'hono';
import type { Env } from '../core/types';
import { getConfig, getConfigValue, setConfigValue, CONFIG_KEYS } from '../core/config/runtime-config';
import { ensureSchema } from '../core/db/ensure-schema';

const SESSION_TTL_SEC = 3600;
const COOKIE = 'setup_session';

// 暴力破解鎖定(密碼 / 安裝權杖共用一個計數):連錯 5 次 → 鎖 300 秒
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_TTL_SEC = 300;
const LOGIN_FAIL_WINDOW_SEC = 600; // 失敗計數的存活窗;窗內沒再錯就自動歸零
const KEY_LOCK = 'setup-lock';
const KEY_FAILS = 'setup-fails';

// 表單欄位定義(key 對應 app_config 主鍵)
const FIELDS: Array<{
  key: string;
  label: string;
  kind: 'text' | 'password' | 'select';
  options?: string[];
  hint?: string;
}> = [
  { key: CONFIG_KEYS.ownerUserId, label: '你的 LINE userId(擁有者)', kind: 'text',
    hint: '⚠ 填錯你會被自己的 bot 當成一般使用者。設好 LINE 後傳「我的 userId」給 bot,它會回你的 userId,複製過來。' },
  { key: CONFIG_KEYS.lineChannelAccessToken, label: 'LINE Channel Access Token', kind: 'password' },
  { key: CONFIG_KEYS.lineChannelSecret, label: 'LINE Channel Secret', kind: 'password' },
  { key: CONFIG_KEYS.anthropicApiKey, label: 'Anthropic API Key(bot 的大腦)', kind: 'password' },
  { key: CONFIG_KEYS.storageMode, label: '儲存模式', kind: 'select', options: ['internal', 'notion-new', 'notion-existing'] },
  { key: CONFIG_KEYS.notionToken, label: 'Notion Token(選填,用 Notion 模式才要)', kind: 'password' },
  { key: CONFIG_KEYS.notionSharedMemoryPageId, label: 'Notion 共享記憶頁 ID(選填)', kind: 'text' },
  { key: CONFIG_KEYS.allowedLineUserIds, label: '使用者白名單(選填,進階)', kind: 'text',
    hint: '預設只有「你(擁有者)+ 綁定的子帳號」能用這個 bot,陌生人會被自動擋下。要讓其他人(家人朋友)也能用,把他們的 LINE userId 用逗號隔開填這裡。' },
];

// 各欄位的「怎麼拿?」圖文指引(折疊式;文字步驟 + 官方連結,平台 UI 改版時以官方為準)。
const GUIDE_NOTE = '<div class="note">各平台介面可能改版,實際以官方頁面為準。</div>';
const GUIDES: Record<string, string> = {
  [CONFIG_KEYS.ownerUserId]: `<details class="guide"><summary>怎麼拿我的 LINE userId?</summary>
<ol>
<li>先完成下方「LINE Webhook」設定,並用手機加 bot 為好友</li>
<li>對 bot 傳訊息 <b>「我的 userId」</b>(就傳這幾個字)</li>
<li>bot 會回覆你的 userId → 複製貼到這欄、按儲存</li>
</ol></details>`,
  [CONFIG_KEYS.lineChannelAccessToken]: `<details class="guide"><summary>怎麼拿 LINE 的 Token 與 Secret?</summary>
<ol>
<li>到 <a href="https://developers.line.biz/console/" target="_blank" rel="noopener">LINE Developers Console</a>,用你的 LINE 帳號登入</li>
<li><b>Create a new provider</b> → 取個名字</li>
<li>進該 provider → <b>Create channel</b> → 選 <b>Messaging API</b> → 填基本資料建立</li>
<li><b>Messaging API</b> 分頁 → <b>Channel access token</b> 點 <b>Issue</b> 後複製(貼這欄)</li>
<li><b>Basic settings</b> 分頁 → 找 <b>Channel secret</b>(貼下面那欄)</li>
</ol>${GUIDE_NOTE}</details>`,
  [CONFIG_KEYS.lineChannelSecret]: `<details class="guide"><summary>Channel Secret 在哪?</summary>
<ol>
<li>同一個 LINE channel → <b>Basic settings</b> 分頁</li>
<li>找 <b>Channel secret</b> 複製貼這欄</li>
</ol></details>`,
  [CONFIG_KEYS.anthropicApiKey]: `<details class="guide"><summary>怎麼拿 Anthropic API Key?</summary>
<ol>
<li>到 <a href="https://console.anthropic.com/" target="_blank" rel="noopener">Anthropic Console</a> 註冊</li>
<li><b>Settings → Billing</b> 綁信用卡,建議設每月花費上限(燒錢防護)</li>
<li><b>Settings → API Keys → Create Key</b> → 複製貼這欄</li>
</ol>${GUIDE_NOTE}</details>`,
  [CONFIG_KEYS.storageMode]: `<details class="guide"><summary>三種儲存模式差在哪?</summary>
<ul>
<li><b>internal</b>:只用內建資料庫,最簡單、不接 Notion(建議先用這個)</li>
<li><b>notion-new</b>:bot 在你的 Notion 開一個新的任務資料庫</li>
<li><b>notion-existing</b>:接你既有的 Notion 任務資料庫</li>
</ul>
<p style="font-size:12px;color:#666;margin:4px 0 0">internal 模式:對話、查天氣、出門提醒、「提醒我X點做Y」(自然語言設提醒)都正常;但<b>沒有</b>「今日計畫整合 / 早晚安自動簡報 / 排工作」(那些需要 Notion)。想要這些就選 notion 模式。</p></details>`,
  [CONFIG_KEYS.allowedLineUserIds]: `<details class="guide"><summary>白名單怎麼運作?別人的 userId 怎麼拿?</summary>
<ul>
<li><b>留空(預設)</b>:只有你和綁定的子帳號能用,其他人傳訊息一律自動擋下(不會消耗你的 AI 額度)</li>
<li>有人被擋下時,bot 會發 LINE 通知你,<b>內含對方的 userId</b> → 想放行就把那串 id 複製進這欄(多人用逗號分隔)</li>
<li>你自己(擁有者)永遠不會被擋,不用把自己加進來</li>
</ul></details>`,
  [CONFIG_KEYS.notionToken]: `<details class="guide"><summary>怎麼拿 Notion Token?(用 Notion 模式才要)</summary>
<ol>
<li>到 <a href="https://www.notion.so/profile/integrations" target="_blank" rel="noopener">Notion Integrations</a> → <b>New integration</b>(類型選 Internal)</li>
<li>建立後在 Configuration 拿 <b>Internal Integration Token</b>(貼這欄)</li>
<li>到你要分享的 Notion 頁面 → 右上 <b>...</b> → <b>Connections</b> → 加上這個 integration</li>
</ol>${GUIDE_NOTE}</details>`,
};

// 設定頁底部的「怎麼把 Webhook URL 設到 LINE」指引(預設展開,因為是必做且最常被漏)。
const WEBHOOK_GUIDE = `<details class="guide" open><summary>怎麼把這個 Webhook URL 設到 LINE?(必做)</summary>
<ol>
<li>複製上面那條 Webhook URL</li>
<li>到 LINE Developers → 你的 channel → <b>Messaging API</b> 分頁 → <b>Webhook settings</b></li>
<li>貼上 URL → 按 <b>Verify</b> 確認連線成功</li>
<li>開啟 <b>Use webhook</b></li>
<li><b>Auto-reply messages</b> 設 disabled、<b>Greeting message</b> 可關(讓 bot 全權回覆)</li>
</ol>${GUIDE_NOTE}</details>`;

// ---------- 工具 ----------
function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// PBKDF2(10 萬次)— 比裸 SHA-256 抗離線爆破(設定密碼把守 API key 設定頁)
async function deriveHash(password: string, salt: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 恆定時間字串比較:兩邊先 SHA-256(等長 32 bytes,不漏原文長度)再逐 byte XOR。
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function isLockedOut(env: Env): Promise<boolean> {
  if (!env.CACHE) return false;
  try {
    return (await env.CACHE.get(KEY_LOCK)) === '1';
  } catch {
    return false;
  }
}

// 失敗 +1;達上限 → 上鎖並清計數。回傳「這次是否觸發鎖定」讓呼叫端當次就回鎖定頁。
// KV 故障時靜默略過(密碼仍要對,只是暫無鎖定)。注意:非原子計數,僅擋低速騷擾(見檔頭)。
async function recordAuthFailure(env: Env): Promise<boolean> {
  if (!env.CACHE) return false;
  try {
    const n = parseInt((await env.CACHE.get(KEY_FAILS)) || '0', 10) + 1;
    if (n >= LOGIN_MAX_FAILS) {
      await env.CACHE.put(KEY_LOCK, '1', { expirationTtl: LOGIN_LOCK_TTL_SEC });
      await env.CACHE.delete(KEY_FAILS);
      return true;
    }
    await env.CACHE.put(KEY_FAILS, String(n), { expirationTtl: LOGIN_FAIL_WINDOW_SEC });
    return false;
  } catch {
    /* 同上:鎖定是輔助防線,不因 KV 故障擋住正常登入 */
    return false;
  }
}

async function clearAuthFailures(env: Env): Promise<void> {
  if (!env.CACHE) return;
  try {
    await env.CACHE.delete(KEY_FAILS);
  } catch {
    /* 清不掉頂多讓殘留計數早一點觸鎖,無安全影響 */
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

async function isAuthed(c: Context<{ Bindings: Env }>): Promise<boolean> {
  if (!c.env.CACHE) return false;
  const token = parseCookies(c.req.header('cookie'))[COOKIE];
  if (!token) return false;
  try {
    return (await c.env.CACHE.get(`setup-session:${token}`)) === '1';
  } catch {
    return false;
  }
}

async function newSession(c: Context<{ Bindings: Env }>): Promise<string> {
  const token = crypto.randomUUID();
  await c.env.CACHE.put(`setup-session:${token}`, '1', { expirationTtl: SESSION_TTL_SEC });
  return token;
}

function sessionCookie(token: string, maxAge: number): string {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/setup; Max-Age=${maxAge}`;
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
 body{font-family:system-ui,-apple-system,"PingFang TC",sans-serif;max-width:560px;margin:32px auto;padding:0 16px;color:#1a1a1a;line-height:1.6}
 h1{font-size:20px} label{display:block;margin:14px 0 4px;font-weight:600;font-size:14px}
 input,select{width:100%;padding:9px;border:1px solid #ccc;border-radius:8px;font-size:15px;box-sizing:border-box}
 .hint{font-size:12px;color:#666;margin-top:3px} button{margin-top:18px;padding:11px 18px;border:0;border-radius:8px;background:#06c755;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
 .ok{background:#e7f7ec;border:1px solid #06c755;padding:10px;border-radius:8px;font-size:14px}
 .warn{background:#fff6e5;border:1px solid #f0a500;padding:10px;border-radius:8px;font-size:13px}
 code{background:#f2f2f2;padding:2px 5px;border-radius:4px;word-break:break-all}
 details.guide{margin:5px 0 2px}
 details.guide summary{cursor:pointer;color:#06c755;font-weight:600;font-size:13px;list-style:none}
 details.guide summary::before{content:"📍 ";}
 details.guide ol,details.guide ul{margin:6px 0;padding-left:20px;font-size:13px;color:#444}
 details.guide li{margin:3px 0}
 details.guide a{color:#0a66c2}
 details.guide .note{font-size:12px;color:#999;margin-top:4px}
</style></head><body>${body}</body></html>`;
}

// ---------- 主 handler ----------
export async function handleSetup(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  // 安全 gate:預設關閉。只有買家版(模板 wrangler.toml 內建 ENABLE_SETUP='1')才開放。
  //   擁有者 instance 不設此 var → /setup 一律 404 → 公開 URL 也無從用 /setup 蓋掉他的 env 設定。
  if (env.ENABLE_SETUP !== '1') return c.text('Not Found', 404);

  // 全新空 D1 自動建表(冪等)。Deploy 按鈕 provision 的 D1 是空的、沒跑 migration,
  //   沒這步 → 首次寫 app_config(設密碼/存 key)會因表不存在而失敗。
  try {
    await ensureSchema(env);
  } catch (e: any) {
    return c.html(
      page('資料庫初始化失敗', `<h1>資料庫初始化失敗</h1><div class="warn">無法建立資料表:${escapeHtml(e?.message ?? String(e))}<br>請確認此 worker 已正確綁定 D1(binding 名 <code>DB</code>)。</div>`),
      500
    );
  }

  const method = c.req.method;
  const hasPassword = !!(await getConfigValue(env, 'setup_password_hash'));
  // 權杖兩端都 trim(買家從部署表單 / 密碼管理器貼上常夾尾端空白或換行);
  // trim 後為空字串視同未設(fail-closed),避免純空白權杖讓空輸入過關。
  const setupToken = env.SETUP_TOKEN?.trim() || '';

  // ===== POST:處理 action =====
  if (method === 'POST') {
    const form = await c.req.parseBody();
    const action = String(form.action || '');

    // 暴力破解鎖定:鎖定中一律拒收登入 / 初始化嘗試(其餘 action 不受影響)
    if ((action === 'init' || action === 'login') && (await isLockedOut(env))) {
      return c.html(page('已暫時鎖定', renderLocked()), 429);
    }

    if (action === 'init') {
      if (hasPassword) return c.html(page('已設定', `<p>設定密碼已存在,請改用登入。</p><a href="/setup">回設定</a>`), 400);
      // SETUP_TOKEN 必設(fail-closed):沒設就拒絕初始化,堵「部署到首次設密碼之間被搶設」的空窗。
      // 一鍵部署的買家一定有(部署表單必填);fork 後 CLI 部署漏設的人會看到補設指引。
      if (!setupToken) return c.html(page('需要安裝權杖', renderTokenMissing()), 403);
      if (!(await safeEqual(String(form.setup_token || '').trim(), setupToken))) {
        if (await recordAuthFailure(env)) return c.html(page('已暫時鎖定', renderLocked()), 429);
        return c.html(page('建立設定密碼', renderInit('安裝權杖(SETUP_TOKEN)不正確')), 403);
      }
      const pw = String(form.password || '');
      if (pw.length < 12) return c.html(page('建立設定密碼', renderInit('密碼至少 12 碼')), 400);
      const salt = crypto.randomUUID();
      await setConfigValue(env, 'setup_password_salt', salt);
      await setConfigValue(env, 'setup_password_hash', await deriveHash(pw, salt));
      await clearAuthFailures(env);
      const token = await newSession(c);
      return new Response('', { status: 302, headers: { Location: '/setup', 'Set-Cookie': sessionCookie(token, SESSION_TTL_SEC) } });
    }

    if (action === 'login') {
      const pw = String(form.password || '');
      const salt = (await getConfigValue(env, 'setup_password_salt')) || '';
      const hash = (await getConfigValue(env, 'setup_password_hash')) || '';
      if (hash && (await safeEqual(await deriveHash(pw, salt), hash))) {
        await clearAuthFailures(env);
        const token = await newSession(c);
        return new Response('', { status: 302, headers: { Location: '/setup', 'Set-Cookie': sessionCookie(token, SESSION_TTL_SEC) } });
      }
      if (await recordAuthFailure(env)) return c.html(page('已暫時鎖定', renderLocked()), 429);
      return c.html(page('登入', renderLogin('密碼錯誤')), 401);
    }

    // 變更設定密碼(需已登入):驗目前密碼 → 換新 salt+hash。讓鎖定頁/文件的「換密碼」指引有著落。
    if (action === 'changepw') {
      if (!(await isAuthed(c))) return c.html(page('登入', renderLogin('請先登入')), 401);
      const cur = String(form.current_password || '');
      const next = String(form.new_password || '');
      const salt = (await getConfigValue(env, 'setup_password_salt')) || '';
      const hash = (await getConfigValue(env, 'setup_password_hash')) || '';
      if (!hash || !(await safeEqual(await deriveHash(cur, salt), hash))) {
        return c.html(page('設定', await renderConfig(c, '目前密碼錯誤,密碼未變更。', true)), 401);
      }
      if (next.length < 12) {
        return c.html(page('設定', await renderConfig(c, '新密碼至少 12 碼,密碼未變更。', true)), 400);
      }
      const newSalt = crypto.randomUUID();
      await setConfigValue(env, 'setup_password_salt', newSalt);
      await setConfigValue(env, 'setup_password_hash', await deriveHash(next, newSalt));
      return c.html(page('設定', await renderConfig(c, '✓ 設定密碼已更新。')), 200);
    }

    if (action === 'logout') {
      if (c.env.CACHE) {
        const token = parseCookies(c.req.header('cookie'))[COOKIE];
        if (token) await c.env.CACHE.delete(`setup-session:${token}`).catch(() => {});
      }
      return new Response('', { status: 302, headers: { Location: '/setup', 'Set-Cookie': sessionCookie('', 0) } });
    }

    if (action === 'save') {
      if (!(await isAuthed(c))) return c.html(page('登入', renderLogin('請先登入')), 401);
      let saved = 0;
      for (const f of FIELDS) {
        const v = String(form[f.key] ?? '').trim();
        if (v) { await setConfigValue(env, f.key, v); saved++; } // 留空 = 不動原值
      }
      return c.html(page('已儲存', await renderConfig(c, `✓ 已儲存 ${saved} 項設定,立即生效。`)), 200);
    }

    return c.html(page('錯誤', `<p>未知動作</p>`), 400);
  }

  // ===== GET:依狀態渲染 =====
  if (!hasPassword) {
    // SETUP_TOKEN 必設(fail-closed):沒設不開放初始化(理由同 POST init)
    if (!setupToken) return c.html(page('需要安裝權杖', renderTokenMissing()), 403);
    return c.html(page('建立設定密碼', renderInit()));
  }
  if (!(await isAuthed(c))) return c.html(page('登入', renderLogin()));
  return c.html(page('設定', await renderConfig(c)));
}

// ---------- 畫面 ----------
function renderInit(err?: string): string {
  // 走到這裡保證 SETUP_TOKEN 已設(handleSetup 的 fail-closed gate),權杖欄固定顯示
  return `<h1>建立設定密碼</h1>
<div class="warn">這是你的 bot 設定頁(已啟用安裝權杖保護)。<b>請在部署後立刻設定密碼</b>。設定後填入各項 API key 即可開始使用。</div>
${err ? `<p style="color:#c00">${escapeHtml(err)}</p>` : ''}
<form method="POST"><input type="hidden" name="action" value="init">
<label>安裝權杖(SETUP_TOKEN)</label><input type="password" name="setup_token" autocomplete="off" required><div class="hint">部署表單(或 wrangler secret)設定的那串安裝權杖,防止他人搶先設定。</div>
<label>設定一組密碼(至少 12 碼,日後管理設定用)</label>
<input type="password" name="password" autocomplete="new-password" required>
<button type="submit">建立並進入設定</button></form>`;
}

function renderTokenMissing(): string {
  return `<h1>需要安裝權杖(SETUP_TOKEN)</h1>
<div class="warn">這個 bot 還沒設定安裝權杖,為了避免被他人搶先設定,初始化已暫停。</div>
<p>請先到 Cloudflare 後台補設一個名為 <code>SETUP_TOKEN</code> 的 Secret(機密變數),再重新整理本頁:</p>
<ol style="font-size:14px;color:#444">
<li>開 <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener">Cloudflare dashboard</a> → <b>Workers &amp; Pages</b> → 點你的 worker</li>
<li><b>Settings</b> → <b>Variables and Secrets</b> → <b>Add</b></li>
<li>Type 選 <b>Secret</b>,名稱填 <code>SETUP_TOKEN</code>,值填一串自己想的亂碼(至少 12 碼,先記下來)</li>
<li>儲存部署後回到本頁重新整理,輸入同一串權杖即可開始設定</li>
</ol>
<div class="hint">介面若與上述不同,以 Cloudflare 官方頁面為準。一鍵部署的使用者不會看到這頁(部署表單已必填)。<br>
本機開發(wrangler dev)看到這頁:改在專案的 <code>.dev.vars</code> 加一行 <code>SETUP_TOKEN=你的亂碼</code> 後重啟 wrangler dev。</div>`;
}

function renderLocked(): string {
  return `<h1>已暫時鎖定</h1>
<div class="warn">密碼或安裝權杖錯誤次數過多,已暫時鎖定 ${Math.round(LOGIN_LOCK_TTL_SEC / 60)} 分鐘,稍後再試。</div>
<p class="hint">若不是你本人嘗試,代表有人正在猜你的設定密碼 — 建議登入後換一組更長的密碼。</p>`;
}

function renderLogin(err?: string): string {
  return `<h1>登入設定頁</h1>
${err ? `<p style="color:#c00">${escapeHtml(err)}</p>` : ''}
<form method="POST"><input type="hidden" name="action" value="login">
<label>設定密碼</label>
<input type="password" name="password" autocomplete="current-password" required>
<button type="submit">登入</button></form>`;
}

async function renderConfig(c: Context<{ Bindings: Env }>, notice?: string, noticeIsError = false): Promise<string> {
  const env = c.env;
  const cfg = await getConfig(env);
  const current: Record<string, string> = {
    [CONFIG_KEYS.ownerUserId]: cfg.ownerUserId,
    [CONFIG_KEYS.lineChannelAccessToken]: cfg.lineChannelAccessToken,
    [CONFIG_KEYS.lineChannelSecret]: cfg.lineChannelSecret,
    [CONFIG_KEYS.anthropicApiKey]: cfg.anthropicApiKey,
    [CONFIG_KEYS.storageMode]: cfg.storageMode,
    [CONFIG_KEYS.notionToken]: cfg.notionToken,
    [CONFIG_KEYS.notionSharedMemoryPageId]: cfg.notionSharedMemoryPageId,
    [CONFIG_KEYS.allowedLineUserIds]: cfg.allowedLineUserIds,
  };
  const host = new URL(c.req.url).origin;
  const webhook = `${host}/webhook/line`;

  const rows = FIELDS.map((f) => {
    const val = current[f.key] || '';
    const guide = GUIDES[f.key] ?? ''; // 折疊式「怎麼拿?」圖文指引
    if (f.kind === 'select') {
      const opts = (f.options || []).map((o) => `<option value="${escapeHtml(o)}"${o === val ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
      return `<label>${escapeHtml(f.label)}</label><select name="${f.key}">${opts}</select>` + guide;
    }
    if (f.kind === 'password') {
      const ph = val ? '(已設定,留空 = 不變)' : '(尚未設定)';
      return `<label>${escapeHtml(f.label)}</label><input type="password" name="${f.key}" placeholder="${escapeHtml(ph)}" autocomplete="off">` +
        (f.hint ? `<div class="hint">${escapeHtml(f.hint)}</div>` : '') + guide;
    }
    return `<label>${escapeHtml(f.label)}</label><input type="text" name="${f.key}" value="${escapeHtml(val)}">` +
      (f.hint ? `<div class="hint">${escapeHtml(f.hint)}</div>` : '') + guide;
  }).join('');

  return `<h1>設定</h1>
${notice ? `<div class="${noticeIsError ? 'warn' : 'ok'}">${escapeHtml(notice)}</div>` : ''}
<p class="hint">secret 欄位只顯示是否已設定,留空表示不變更。</p>
<form method="POST"><input type="hidden" name="action" value="save">${rows}
<button type="submit">儲存</button></form>
<hr style="margin:24px 0">
<label>LINE Webhook URL(貼到 LINE Developers → Messaging API → Webhook URL)</label>
<p><code>${escapeHtml(webhook)}</code></p>
${WEBHOOK_GUIDE}
<hr style="margin:24px 0">
<details class="guide"><summary>變更設定密碼</summary>
<form method="POST" style="margin-top:8px"><input type="hidden" name="action" value="changepw">
<label>目前密碼</label><input type="password" name="current_password" autocomplete="current-password" required>
<label>新密碼(至少 12 碼)</label><input type="password" name="new_password" autocomplete="new-password" required>
<button type="submit">更新密碼</button></form></details>
<form method="POST" style="margin-top:24px"><input type="hidden" name="action" value="logout">
<button type="submit" style="background:#888">登出</button></form>`;
}
