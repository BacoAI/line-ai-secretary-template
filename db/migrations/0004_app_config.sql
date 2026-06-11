-- 安裝商品化(自架版):執行期設定 key-value 表。
-- 買家在 worker 的 /setup 頁貼上 key → 存這裡;程式讀設定時「先讀這表、讀不到才退回 env」。
-- 這讓買家不必碰 wrangler secret / 編設定檔;擁有者自己的 instance 無資料列 → 走 env,照舊運作。
--
-- 常見 key(value 一律存字串):
--   owner_user_id              擁有者的 LINE userId(取代寫死的開發者前綴)
--   line_channel_access_token  LINE Messaging API token
--   line_channel_secret        LINE channel secret
--   anthropic_api_key          Claude API key(bot 的大腦)
--   notion_token               Notion 整合 token(用 Notion 模式才需要)
--   notion_shared_memory_page_id
--   storage_mode               internal / notion-new / notion-existing
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT
);
