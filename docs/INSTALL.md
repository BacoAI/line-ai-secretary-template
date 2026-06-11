# 安裝指南 — LINE AI Secretary 免費版

> **90% 的人用「方式 A:一鍵部署」就好** — 約 10～15 分鐘,不需要 Claude Code、不需要終端機、不需要 wrangler。
> 要本機開發 / 自己掌控部署的進階使用者,看最後的「方式 B:手動 CLI 安裝」。

---

## 你會需要(4 個免費帳號)

| 帳號 | 用途 | 申請 |
|---|---|---|
| **Cloudflare** | 跑你的 bot(24/7) | <https://dash.cloudflare.com/sign-up>(email 註冊,免信用卡) |
| **GitHub** | 一鍵部署會把程式複製到你的 GitHub | <https://github.com/signup> |
| **LINE Developer** | bot 的對話通道 | 用你現有 LINE 帳號登入即可 |
| **Anthropic** | bot 的大腦(Claude API key) | <https://console.anthropic.com/> |

> Notion 為選用。預設 `internal` 模式只用內建資料庫,不接 Notion 也完整可用。

---

# 方式 A:一鍵部署(推薦)

## Step 1 — 申請 LINE channel,拿 2 個 token

1. 打開 <https://developers.line.biz/console/>,用你的 LINE 帳號登入。
2. **Create a new provider** → 命名(例:你的名字)。
3. 進該 Provider → **Create channel** → 選 **Messaging API** → 填基本資訊建立。
4. 進該 channel:
   - **Basic settings** → 複製 **Channel secret**
   - **Messaging API** → **Channel access token** 點 **Issue** 後複製
5. 這 2 個 token 等一下貼到 /setup 頁,先存著。

## Step 2 — 申請 Anthropic API key

1. 打開 <https://console.anthropic.com/> 註冊(可跟 Claude Pro/Max 同 email,但為獨立 API 帳號)。
2. **Settings → Billing** → 綁信用卡 + 設「Workspace spend limit」(建議 NT$1000/月,燒錢防護)。
3. **Settings → API Keys → Create Key** → 複製。

## Step 3 — 按「Deploy to Cloudflare」按鈕

1. 回到專案 [README](../README.md),點 **Deploy to Cloudflare** 按鈕。
2. 依畫面用 **GitHub** + **Cloudflare** 登入授權。
3. 部署表單會要你填一個 **SETUP_TOKEN(安裝權杖)**:自己想一串**至少 12 碼的亂碼**(像密碼),**先記下來** —— Step 4 第一次打開 /setup 會用到一次。
   > 用途:防止「部署完成到你第一次打開 /setup 之間」被陌生人搶先設定、接管你的 bot。
4. Cloudflare 會自動:把程式複製到你的 GitHub、在你的帳號建好全新的 **D1 資料庫** 與 **KV 快取**、部署你的 worker。
5. 完成後拿到你的 worker 網址,長得像:
   `https://line-ai-secretary-bot.SUBDOMAIN.workers.dev`
   (把 `SUBDOMAIN` 換成你 Cloudflare 帳號的子網域;真實網址不含角括號。)

> 資料庫是全新空的沒關係 —— 下一步**打開 /setup 頁時**會自動建好所有資料表。

## Step 4 — 開設定頁(/setup)貼上金鑰

1. 瀏覽器開 `https://<你的worker網址>/setup`。
2. **第一次**會要你輸入**安裝權杖(SETUP_TOKEN,Step 3 部署表單填的那串)**,並設一組**設定密碼(至少 12 碼,跟權杖不要同一串)** —— 部署後請立刻設。設好就進設定頁。
3. 表單欄位由上到下(填好按儲存):
   - **你的 LINE userId(擁有者)**:這欄在最上面,但**先留空** —— 等 Step 5 拿到 userId 再回來填(見下)。
   - **LINE Channel Access Token**、**LINE Channel Secret**(Step 1 拿的)
   - **Anthropic API Key**(Step 2 拿的)
   - **儲存模式**:預設 `internal`(只用內建 DB,最簡單);用 Notion 再選 `notion-new` / `notion-existing`
     > `internal` 模式:對話、天氣、出門提醒、「提醒我X點做Y」都正常,但**沒有**早晚安自動簡報與 Notion 排工作(那些要 Notion)。之後想要可隨時改成 notion 模式。
   - (選用)**Notion Token**、**Notion 共享記憶頁 ID**:用 Notion 模式才要填
   - (選用)**使用者白名單**:預設只有你 + 綁定的子帳號能用,陌生人自動擋下;要讓家人朋友用,把他們的 userId 逗號分隔填這欄(有人被擋時 bot 會通知你、附上對方 userId)
4. 金鑰存進「你自己的」資料庫,立即生效。

## Step 5 — 設定 LINE Webhook、加好友、填擁有者 ID

1. /setup 頁面底部有你的 **Webhook URL**(`https://<你的worker網址>/webhook/line`),複製。
2. 回 **LINE Developers → 你的 channel → Messaging API**:
   - **Webhook URL** 貼上 → **Verify** 確認連線成功
   - 啟用 **Use webhook**
   - **Auto-reply messages** 設 **disabled**、**Greeting message** 可關(讓 bot 全權處理)
3. **Channel basic settings** 的 **QR Code** → 手機 LINE 掃 → 加 bot 為好友。
4. 對 bot 傳訊息 **「我的 userId」**(就傳這幾個字)→ bot 會回覆你的 **LINE userId**。
   - 若沒回,到 Cloudflare 該 worker 的 **Logs** 也查得到。
5. 複製該 userId → 回 `/setup` 填進最上面的「**你的 LINE userId(擁有者)**」並儲存。
   - ⚠ 這步很重要:填了 bot 才知道你是主人(否則你會被自己的 bot 當成一般使用者)。

## Step 6 — 完成

對 bot 說「你好」,它會自我介紹並開始服務。第一次對話它可能會問你的稱呼、推播時間、不打擾時段等偏好。

---

## 故障排除(方式 A)

**/setup 打不開(404)**
- 確認網址結尾是 `/setup`。
- 範本部署預設開啟 /setup;若你自行關過 `ENABLE_SETUP`,要設回 `1`。

**/setup 顯示「需要安裝權杖」或忘了 SETUP_TOKEN**
- 到 Cloudflare dashboard → **Workers & Pages** → 點你的 worker → **Settings** → **Variables and Secrets** → 新增或編輯名為 `SETUP_TOKEN` 的 **Secret**(值填一串至少 12 碼亂碼,記下來)→ 儲存後重開 /setup。
- Secret 存了就看不到原值,但**可以直接覆寫成新的一串**,忘了不用慌。
- (介面若與上述不同,以 Cloudflare 官方頁面為準。)

**/setup 顯示「已暫時鎖定」**
- 密碼或安裝權杖連錯 5 次會鎖 5 分鐘(防暴力破解),等鎖解除再試。
- 若不是你本人試的,代表有人在猜你的密碼 —— 建議登入後換一組更長的設定密碼。

**LINE Webhook Verify 失敗**
- 確認 URL 完整含 `/webhook/line`。
- 確認 /setup 已存好 **LINE Channel Secret**(簽章驗證要用)。

**bot 沒有回應**
- 到 Cloudflare 該 worker 的 **Logs**(即時)看錯誤。
- 確認 **Anthropic API Key** 有效且帳戶有額度。
- 確認 LINE 端 **Use webhook** 已啟用、**Auto-reply** 已關。

**設定頁資料初始化失敗**
- 通常是 worker 沒綁好 D1(binding 名須為 `DB`)。重跑一鍵部署,或在 Cloudflare 該 worker 的 **Settings → Bindings** 確認有 `DB`(D1)與 `CACHE`(KV)。

---

# 方式 B:手動 CLI 安裝(進階)

> 適合要在本機開發 / 自己掌控部署的人。需要 **Node 20+** 與終端機。

```bash
git clone <你的-repo-url> line-ai-secretary
cd line-ai-secretary
npm install
```

1. **登入 Cloudflare**:`npx wrangler login`(瀏覽器一鍵授權)。
2. **建資源**:
   ```bash
   npx wrangler d1 create line-ai-secretary       # 記下回傳的 database_id
   npx wrangler kv namespace create CACHE         # 記下回傳的 id
   ```
3. **設定檔**:複製 `wrangler.jsonc` 成你自己的設定 `wrangler.local.jsonc`(**保留 `.jsonc` 副檔名** —— wrangler 靠副檔名判格式,存成 `.toml` 會解析失敗),把 `database_id` / KV `id` 換成上一步拿到的真值,`account_id` 填你自己的(`npx wrangler whoami` 可看)。
   > 公開範本的 `wrangler.jsonc` 用的是「拋棄式假 id」(一鍵部署會自動換掉);手動安裝要換成你真的 id。範本已內含 `"vars"` 區塊的 `"ENABLE_SETUP": "1"`,複製過來即生效。
4. **建表**:`npx wrangler d1 migrations apply DB --remote -c wrangler.local.jsonc`(帶 `-c` 才會打到你 step 2 建的真 D1,否則會用假 id)
5. **部署**:`npx wrangler deploy -c wrangler.local.jsonc`
6. **設定金鑰**:有兩種做法 ——
   - (a)沿用 /setup 頁:先設安裝權杖 `npx wrangler secret put SETUP_TOKEN -c wrangler.local.jsonc`(沒設的話 /setup 會拒絕初始化),部署後開 `/setup` 貼 key(同方式 A 的 Step 4–5);或
   - (b)走 `npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN -c wrangler.local.jsonc`(及其它,含 `SETUP_TOKEN`)逐一設定。
7. **LINE Webhook**:同方式 A 的 Step 5。

> 開發者(本套件作者)自己的 prod 部署用 `npm run deploy:prod`(讀 gitignored 的 `wrangler.prod.toml`),不要 bare `wrangler deploy`。

### (可選)Twilio 電話介入

想要嚴重拖延時 bot 真的撥電話 → 見 [TWILIO-PHONE-SETUP.md](TWILIO-PHONE-SETUP.md)(註冊 → 驗證手機 → 拿 SID/Token → 存 secret → 測試;設完即時生效,不必重新部署)。

---

## 更新到新版範本

範本之後推出新版時(看[範本 CHANGELOG](../CHANGELOG.md)),照 **[UPDATING.md](UPDATING.md)** 把你的 bot 更新上去 — 你的設定與資料都保留。

## 升級到付費版

升級時你既有的所有資料都保留:
1. 安裝付費版套件(含 modules 進階模組)。
2. 跟你的 Claude 說「升級到付費版」。
3. 不動你既有 D1 資料、加入新模組、跑新 migration(若有)、重新部署。

## 客製化

進階客製見 [CUSTOMIZATION-RECIPES.md](CUSTOMIZATION-RECIPES.md)。
