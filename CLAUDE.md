# CLAUDE.md — 給 Claude / AI 看的專案指南

這份文件給「**未來閱讀這個專案的 AI**」看,讓 AI 能快速理解專案結構、設計理念、如何協助使用者修改或擴充。

---

## 專案是什麼

**LINE AI Secretary** — 個人 LINE AI 助理,核心定位是「**主動式工作秘書**」。

- 不是被動回答的 chatbot
- 是主動推播、追任務、跨裝置一致的 AI 助理
- 跑在 Cloudflare Workers(雲端,24/7 運作)
- 透過 LINE 跟使用者互動
- 透過 Notion 共享記憶,確保使用者跨裝置體驗一致

---

## 商業背景(影響設計決策)

- 開發團隊:**貝克街**(線上 AI 應用課程)
- 這個 repo 是「**免費版 MVP**」,作為課程的入門引流
- 付費版含:反拖延深度模組、AI 客製化框架、Twilio 電話介入(免費版可選裝)、課程教學
- 學員會用他們自己的 Claude 安裝、客製化這個套件
- 因此程式碼必須「**對 AI 友善**」: 清晰、模組化、註解豐富

---

## 核心設計原則

1. **模組化**: 每個功能是獨立模組,可加可減,互不影響
2. **平台無關**: 訊息層 / AI 層 / 儲存層 完全解耦,未來可換 Telegram / Messenger
3. **配置外部化**: 所有可變設定放 config/ 或環境變數,不寫死
4. **零配置原則**: 能讓 AI 自動推測的設定,不要逼使用者自己選
5. **三層配置**: Layer 1 AI 推測 / Layer 2 快速精靈 / Layer 3 隨時口語修改
6. **升級保留**: 升級到付費版時,使用者既有的所有設定與資料 100% 保留
7. **燒錢防護**: 從第一天就有上限、迴圈偵測、單次確認

---

## 程式碼結構

```
src/
├─ core/           核心邏輯(永遠存在,所有模式都用)
│   ├─ ai/         Claude API 整合
│   ├─ memory/     記憶系統(讀寫 Notion 共享記憶)
│   ├─ scheduler/  Cron 排程觸發
│   ├─ safety/     燒錢防護、迴圈偵測
│   └─ logger/     操作日誌
├─ modules/        可選模組(免費版內含的)
│   ├─ basic-reminder/        基本提醒
│   ├─ natural-language/      自然語言加任務
│   ├─ rich-menu/             Rich Menu 客製化
│   └─ phone-intervention/    電話介入(可選)
├─ adapters/       平台適配器(對接外部服務)
│   ├─ line/       LINE Messaging API
│   ├─ notion/     Notion API
│   ├─ twilio/     Twilio(電話介入用)
│   └─ storage/    儲存層適配器(3 種模式)
├─ handlers/       Webhook handlers
│   ├─ line.ts     處理 LINE webhook
│   └─ cron.ts     處理 Cron 觸發
└─ index.ts        Hono entry point
```

---

## 3 種 Notion 模式(STORAGE_MODE)

**模式 A: internal**
- 完全用 Cloudflare D1 內建 DB
- 不依賴 Notion
- 適合「不用 Notion」或「最簡安裝」的使用者
- **此模式關閉所有 Notion 功能**(以 `isInternalMode(env)` 閘控,見 runtime-config.ts):
  - AI 工具表濾掉 Notion 讀寫 + 排工作工具(claude-with-tools.ts)
  - cron 跳過早安/晚安/7:00 簡報(都讀 Notion 今日計畫;cron.ts runPerUserScheduledPushes)
  - system prompt 不列 Notion 工具 + 加前置指令導向 set_self_reminder(line.ts buildSystemPrompt)
  - **此模式無早晚安自動簡報、無排工作**;但對話、天氣、出門提醒、自然語言設提醒(存內建 KV/D1)都正常

**模式 B: notion-new**
- bot 在使用者 Notion 建一個新 DB(任務專用)
- 使用者既有 Notion 頁面 0 影響
- 適合「有 Notion 但不想動現有結構」的使用者

**模式 C: notion-existing**
- bot 連到使用者既有的 task DB
- 需要對應欄位
- 適合「已有結構化 Notion」的使用者

→ 安裝時 setup wizard 會問使用者選哪個

---

## 共享記憶系統

放在 Notion 一個頂層頁面(env: `NOTION_SHARED_MEMORY_PAGE_ID`),結構:

```
📁 AI 秘書工作台
   ├─ 📄 個人檔案     使用者基本資訊、偏好、習慣
   ├─ 📄 進行中專案   目前在做的事
   ├─ 📄 AI 觀察       AI 對使用者的觀察、模式
   └─ 📄 對話歷史摘要 重要對話的精煉
```

讓 LINE Bot 跟 Mac 上的 Claude Code(開發者用)能讀同一份記憶,達到「一個 AI 體驗」。

---

## 升級路徑(免費版 → 付費版)

升級到付費版時,以下完全保留:
- Notion 共享記憶 + 任務 DB(原本就在 Notion)
- Bot 學到的個人化(在 D1 跟 Notion)
- Rich Menu 客製化
- 所有設定

加入的:
- 新模組放進 `modules/` 資料夾,在 config 啟用
- 可能新增 D1 欄位(透過 migration)
- AI 框架等進階功能

---

## 給 buyer 的 Claude 的指示

如果你是學員的 Claude,在幫他安裝/客製化這個套件:

1. **先讀** [docs/INSTALL.md](docs/INSTALL.md) — 完整安裝對話腳本
2. **參考** [docs/CUSTOMIZATION-RECIPES.md](docs/CUSTOMIZATION-RECIPES.md) — 常見客製化做法
3. **遇到不懂的功能** → 讀對應 `src/` 下的程式碼,每個檔頭都有 docstring 說明
4. **任何外部 API 操作前**(申請帳號、買 Twilio 號碼等)→ **先上網搜尋當下最新文件**,因為各家服務介面可能改版
5. **不要自己改 core/**(核心邏輯),只改 modules/ 或 config/
6. **遇到不確定** → 問使用者,不要猜測

---

## 給開發者(貝克街團隊 / 客製此套件的你)的提醒

- 改 core/ 要謹慎,可能影響升級相容性
- 加新功能優先用「新增 modules/」方式,不要動 core/
- 任何 schema 變更要寫 migration
- 部署前一定要跑 typecheck
- 燒錢防護的閾值改了要更新文件
- **買家更新路徑的兩條鐵則(2026-06-10)**:
  1. **schema 變更只能用「新增表」表達** — 已部署買家更新後唯一的 migration 是 ensureSchema(開 /setup 觸發),它對既有表是 no-op;要加欄位必須在 ensure-schema.ts 加冪等 ALTER + CHANGELOG 註明(詳見該檔檔頭)
  2. **wrangler.jsonc 對既有買家是凍結的** — 買家更新流程會保留他自己的 wrangler.jsonc(內含他專屬的 D1/KV id),範本改 [vars]/binding/cron 老買家拿不到,必須在 CHANGELOG 寫手動步驟(詳見 publish-template.sh 檔頭)
