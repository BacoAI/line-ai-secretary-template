/**
 * LINE AI Secretary — Cloudflare Worker Entry Point
 *
 * 路由:
 * - POST /webhook/line  — 接收 LINE webhook
 * - GET  /health         — 健康檢查
 * - GET  /version        — 版本資訊
 *
 * Cron Triggers(在 wrangler.toml 設定):
 * - 每天 08:30 推今日總覽
 * - 每 15 分鐘檢查任務提醒
 * - 每天 22:00 推今日總結
 */

import { Hono } from 'hono';
import { handleLineWebhook } from './handlers/line';
import { handleCron } from './handlers/cron';
import { handleUsageWebhook } from './handlers/usage';
import { handleNfcGo } from './handlers/nfc';
import { handleSetup } from './handlers/setup';
import type { Env } from './core/types';

const app = new Hono<{ Bindings: Env }>();

// 健康檢查
app.get('/', (c) => {
  return c.text('LINE AI Secretary is running.');
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    timezone: c.env.TIMEZONE,
    storage_mode: c.env.STORAGE_MODE,
  });
});

app.get('/version', (c) => {
  return c.json({
    name: 'line-ai-secretary',
    version: '0.1.0',
    edition: 'free',
  });
});

// LINE Webhook
app.post('/webhook/line', async (c) => {
  return handleLineWebhook(c);
});

// v183: iOS Shortcuts 通報「使用者開了分心 app」
app.post('/api/usage', async (c) => {
  return handleUsageWebhook(c);
});
// GET 版(iOS Shortcuts 較好寫:Get Contents of URL → GET → 帶 query string)
app.get('/api/usage', async (c) => {
  return handleUsageWebhook(c);
});

// /setup — 安裝設定頁(自架版貼 key,bootstrap 密碼保護)
app.get('/setup', async (c) => handleSetup(c));
app.post('/setup', async (c) => handleSetup(c));

// NFC 嗶 → 推今天該帶的東西(Phase 0:先推固定文字驗證閉環)
// NFC 標籤寫死網址 https://<worker>/go?k=<token>,手機嗶一下觸發
app.get('/go', async (c) => {
  return handleNfcGo(c);
});

// 預設 404
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// 錯誤處理
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

export default {
  fetch: app.fetch,

  // Cron Trigger handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(event, env));
  },
};
