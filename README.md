# LINE AI Secretary

主動式 AI 工作助理 — LINE 版(免費版)

> 在 LINE 裡有一個會主動找你的 AI 秘書,跟你對話、提醒行程、整合 Notion。

## 一鍵部署(10 分鐘,免終端機)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/BacoAI/line-ai-secretary-template)


按下按鈕 → 用 GitHub + Cloudflare 登入授權 → 部署表單填一個**安裝權杖(SETUP_TOKEN,自己想一串至少 12 碼的亂碼,先記下來)** → Cloudflare 會**自動**:把程式複製到你的 GitHub、在你的帳號建好一個全新資料庫(D1)與快取(KV)、部署你的 bot。完成後開 `https://你的worker網址/setup` 輸入安裝權杖、設定密碼,貼上你的 LINE 與 Anthropic 金鑰即可開始用。

**不需要** Claude Code、不需要終端機、不需要 wrangler。完整步驟見 **[docs/INSTALL.md](docs/INSTALL.md)**。

### 你需要 4 個免費帳號

| 帳號 | 用途 | 費用 |
|---|---|---|
| **Cloudflare** | 跑你的 bot(24/7) | 免費額度個人用足夠 |
| **GitHub** | 一鍵部署會把程式複製到你的 GitHub | 免費 |
| **LINE Developer** | bot 的對話通道 | 免費 |
| **Anthropic** | bot 的大腦(Claude API key) | 有免費額度,之後綁卡 |

> Notion 為選用(預設 `internal` 模式只用內建資料庫,不接 Notion 也能跑)。

## 特色

- 🗣️ **自然語言**: 在 LINE 講「明天 3 點開會」自動加入任務
- 🔔 **主動推播**: 早晚自動推送行程,任務前 15 分鐘提醒
- 🎛️ **可客製化 Rich Menu**: 6 顆按鈕對應你的常用功能
- 📝 **Notion 整合**: 支援 3 種模式(內建 DB / 獨立 Notion DB / 整合既有 DB)
- 📞 **真實電話介入(可選)**: Twilio 撥電話到你手機,適合嚴重拖延者
- 🛡️ **燒錢防護**: 月度上限、迴圈偵測、單次任務確認

## 技術架構

```
[你的 LINE] ↔ [LINE Messaging API] → Cloudflare Workers (Hono)
                                          ↓
              ┌───────────────────────────┼───────────────────┐
              ↓                           ↓                   ↓
    @anthropic-ai/sdk (Claude)   @notionhq/client (Notion)   D1 SQLite
```

- **Runtime**: Cloudflare Workers(邊緣運算,免費額度足夠個人用)
- **語言**: TypeScript ／ **Web 框架**: Hono ／ **資料庫**: Cloudflare D1(SQLite)
- **資料驗證**: Zod ／ **ORM**: Drizzle ORM ／ **排程**: Cloudflare Cron Triggers

## 進階:手動安裝 / 本機開發

要本機開發或自己掌控部署 → 見 [docs/INSTALL.md](docs/INSTALL.md) 的「方式 B:手動 CLI 安裝」。

## 商業模式

- **免費版(本 repo)**: 核心功能,給個人使用
- **付費課程**: 教你建你自己的版本 + 進階模組(反拖延深度、AI 客製化框架等)

## 授權

MIT License — 你可以自由使用、修改、分發。詳見 [LICENSE](LICENSE)。
