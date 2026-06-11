# 安裝過程的踩坑紀錄

> 這份文件記錄原型開發者在安裝過程中遇到的所有「**官方沒寫但會卡關**」的問題。
> 未來給學員的安裝精靈會用這些坑來預先告知或自動處理。

---

## 🟥 Cloudflare 相關

### 坑 #1:「Edit Cloudflare Workers」模板**不包含 D1 權限**

**現象**:
建立 API Token 時選了 Cloudflare 推薦的「Edit Cloudflare Workers」模板,
以為涵蓋 Workers 所有功能,但建立 D1 資料庫時報錯:
```
"code": 10000, "message": "Authentication error"
```

**原因**:
- 模板包含:Workers Scripts / KV / R2 / Pages / Routes / Builds / Agents / Observability / Containers
- 模板**沒包含**:D1 Database

**解法**:
編輯既有 token,在 Permissions 加上:
- Account → D1 → Edit

**自動處理建議**(給未來的安裝精靈):
建立 token 時引導使用者用 **Custom Token**,明確包含:
- Workers Scripts: Edit
- Workers KV Storage: Edit
- D1: Edit
- Account Settings: Read

---

### 坑 #2:Cloudflare 註冊後預設導向「建站精靈」

**現象**:
新建 Cloudflare 帳號後,會跳出「**How would you like to start building?**」精靈,
列出 6 個選項(Workers Compute、Workers AI、R2、Domain 等)。

新手可能不知道要選哪個 → 容易卡住。

**解法**:
- 選「**Connect git repo or use template**」(Workers Compute)
- 或直接 Skip(去 Dashboard)
- 我們之後用 wrangler CLI 部署,不會走這個 UI

**自動處理建議**:
告訴 buyer 「**這個畫面可以略過,直接到 Dashboard**」。

---

## 🟥 LINE 相關

### 坑 #3:**LINE OA Manager vs LINE Developers Console** 兩個系統混淆

**現象**:
LINE 有兩個後台:
- **LINE Official Account Manager**(`manager.line.biz`)- 給「行銷 / 客服」用
- **LINE Developers Console**(`developers.line.biz`)- 給「**開發**」用

新手不知道要去哪個。文件裡寫「LINE Developer」可能讓人誤以為只有後者。

實際上 2026 年的 LINE OA Manager 已經整合:
- 可從 OA Manager 直接啟用 Messaging API(不需要先去 Developers Console)
- 但 Channel Access Token 仍然只能在 Developers Console 取得

**解法**:
引導路徑:
```
1. 先去 LINE Official Account Manager 建 OA + 啟用 Messaging API
2. 設定 → Messaging API → 取 Channel Secret + 設 Webhook URL
3. 去 LINE Developers Console → 對應的 Channel → 取 Channel Access Token
```

**自動處理建議**:
分階段引導,**明確告知「**現在在哪個系統**」**。

---

### 坑 #4:**啟用 Messaging API 時要選 Provider**

**現象**:
啟用 Messaging API 時跳出「選擇服務提供者」對話框,
新手不知道「服務提供者」(Service Provider)是什麼。

**解法**:
解釋:**Provider = bot 的「擁有者組織」**(個人就是個人)
建議:選「建立新的服務提供者」,命名為「使用者名 個人」

**自動處理建議**:
帶 buyer 命名為「`<姓名> 個人`」。

---

### 坑 #5:**「隱私權政策 / 服務條款」是選填**

**現象**:
啟用 Messaging API 時跳出「隱私權政策及服務條款」,新手以為一定要填。

**解法**:
個人 bot 兩個都留空,直接點確定。
未來商業化才需要填。

---

### 坑 #6:**LINE OA 預設「自動回應」會蓋過 Webhook** ⭐ 最重要的坑

**現象**:
所有設定都對、Webhook URL 都填了、bot 也部署了 ——
但傳訊息給 bot,只收到 LINE 預設的:
- 「<你的帳號名>您好!感謝您加入好友...」(歡迎訊息)
- 「感謝您的訊息!很抱歉,本帳號無法個別回覆...」(自動回應)

完全沒收到我們 bot 寫好的回應。

**原因**:
LINE OA 預設「自動回應」是開啟的,**它會優先處理使用者訊息**,
不會把訊息送到 Webhook → 我們的 bot 永遠收不到訊息。

**解法**:
到 LINE OA Manager **設定 → 回應設定**(或對應位置):
- 加入好友的問候 → **停用**
- 自動回應訊息 → **停用** ⭐
- Webhook → **啟用** ⭐⭐⭐ 最重要

或在 LINE Developers Console 的 Channel 設定:
- Use webhook → **On**
- Auto-reply messages → **Disabled**
- Greeting messages → **Disabled**

**自動處理建議**:
- 安裝精靈安裝完 webhook 後,**強制提醒 buyer 去檢查回應設定**
- 提供截圖 + 步驟
- 最好 setup wizard 完成後跑「自動測試」(用 LINE Push API 傳訊息給 OA 帳號本身來確認 webhook 真的接通了)

---

### 坑 #7:**Channel Access Token 不在 OA Manager,要去 Developers Console**

**現象**:
OA Manager 的 Messaging API 頁面顯示:
- Channel ID
- Channel Secret
- Webhook URL

但**沒有 Channel Access Token**。

**原因**:
Channel Access Token(長期版)只在 LINE Developers Console 顯示與發行。

**解法**:
1. 點 OA Manager 頁面下方「您可由 LINE Developers Console 進行其他設定」
2. 進到 Developers Console
3. 對應的 Channel → Messaging API 分頁
4. 找「Channel access token」→ 點 Issue 發行
5. 複製回來

**自動處理建議**:
明確指引 buyer「**這個 token 不在 OA Manager 拿,要切換到 Developers Console**」。

---

### 坑 #37:**Deploy 按鈕把 `.env.example` 的每個 key 變成部署時「必填」欄位** ⭐ 影響範本設計

**現象**(2026-06-09 真機實測):
公開範本若帶 dev 用的完整 `.env.example`(列 LINE / Anthropic / Notion / Twilio 共 9 個 key),
「Deploy to Cloudflare」按鈕會把**每一個 key 都變成部署表單的必填欄位**,
買家還沒申請完就被逼著一次填 9 個(含其實選用的 Notion / Twilio)→ 卡在部署第一步。

**原因**:
Deploy 按鈕讀 `.dev.vars.example` / `.env.example`(dotenv 格式)當「部署時要收集的 secret 清單」,
且目前**不分必填 / 選用**,有列就要求填值才能按 Deploy(Cloudflare 官方已知 UX 問題)。

**解法(本套件採用)**:
- dev repo 的完整 `.env.example`**不進**公開範本(白名單排除)。
- `scripts/publish-template.sh` 改為**生成一份只含 `SETUP_TOKEN` 的 `.env.example`** 進範本 ——
  反過來利用這個「必填」行為,**強制買家部署時設安裝權杖**,堵 `/setup` 搶註空窗(健檢項 2)。
- 買家其餘的 key(LINE / Anthropic / Notion)改成部署後在 `/setup` 頁貼,存進自己的 D1。

**自動處理建議 / 注意**:
- 日後要改範本要收集哪些 secret,就是改 `publish-template.sh` 的 1b heredoc(不是改 dev repo 的 `.env.example`)。
- 想讓某個 key 選填,目前無乾淨解 → 一律走 `/setup`,別加進範本 `.env.example`。
- 官方參考:<https://developers.cloudflare.com/workers/platform/deploy-buttons/>(secret 也可在 `package.json` 的 `cloudflare.bindings.<KEY>.description` 加說明文字,顯示在部署表單)。

---

## 🟧 Notion 相關

### 坑 #8:**Internal Integration 不能建頂層頁面**

**現象**:
試圖用 Notion API 建立 workspace-level page,API 回:
```
"Internal integrations aren't owned by a single user,
 so creating workspace-level private pages is not supported."
```

**原因**:
Notion 的 Internal Integration(內部整合)是「組織擁有」,
不允許建立沒有 owner 的頂層頁面。

**解法**:
請 buyer **手動建一個空白頂層頁面**,然後分享給 integration:
1. 在 Notion sidebar 點「+ Add page」
2. 命名(例:AI 秘書工作台)
3. 在該頁面點「...」→ 連接 → 加入「使用者建的 integration 名」
4. 把該頁面 ID 給 bot(從 URL 截取)

**自動處理建議**:
安裝精靈引導 buyer 在 Notion 手動建頁面 + 分享 connection,
然後讓 buyer 把頁面 URL 貼回來,系統自動解析 page ID。

---

### 坑 #9:**Notion connection 不會「繼承到新頁面」除非加在頂層**

**現象**:
Integration 加到某個頁面後,該頁面的**子頁面會自動繼承**;
但**未來在 workspace 別處新建的頁面**不會自動共享。

**解法**:
告訴 buyer:
- 「加在頂層 = 該頂層內所有子頁面都自動共享」
- 「但你在 workspace 別處新建頁面,bot 看不到,要再加 connection」

或建議集中化:把所有 bot 相關內容放在「AI 秘書工作台」這個頂層下。

---

## 🟧 共通 / 其他

### 坑 #10:**Wrangler 部署成功但 secrets 還沒上傳**

**現象**:
第一次部署 worker 成功(因為程式碼沒實際呼叫到 secret),
但開始接 LINE 訊息時 worker 拋錯「`LINE_CHANNEL_SECRET is undefined`」。

**原因**:
`wrangler deploy` 不會自動上傳 secrets,要分別跑:
```
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
wrangler secret put LINE_CHANNEL_SECRET
...
```

**自動處理建議**:
安裝精靈在 deploy 之前**先檢查所有必要 secrets 都已 put**。

---

### 坑 #11:**Webhook URL 填了但忘記按「儲存」**

**現象**:
LINE OA Manager Webhook URL 欄位填了我們的 Cloudflare URL,但沒按綠色「儲存」按鈕。
→ LINE 不知道 URL 變動 → 還是把訊息送到「沒有 webhook」狀態。

**自動處理建議**:
明確告知「**填完後一定要按綠色儲存按鈕**」。

---

### 坑 #12:**APAC region 對台灣使用者最快**

**現象**:
建立 D1 / Worker 時可以選 region,預設可能是其他地區。

**解法**:
台灣使用者選 APAC(實際 region 可能在日本 KIX),延遲最低。
我們建立時系統自動選 APAC,符合預期。

---

### 坑 #13:**@anthropic-ai/sdk 在 Cloudflare Workers 失效**

**現象**:
用官方 SDK `@anthropic-ai/sdk` 寫 Worker,部署後 bot 完全沒回應。
看 log 找不到明顯錯誤,但 Claude API call 沒成功。

**原因(推測)**:
SDK 依賴某些 Node.js 特定 API(如 stream / EventTarget polyfill),
即使開了 nodejs_compat,在 CF Workers 環境仍有問題。

**解法**:
用 **native fetch** 直接呼叫 Anthropic REST API:
```typescript
await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
  body: JSON.stringify({ model, max_tokens, system, messages }),
});
```

**自動處理建議**:
套件預設用 native fetch,不用 SDK,避開此坑。
給 buyer 的安裝精靈不要建議裝 @anthropic-ai/sdk。

---

### 坑 #15:**迴圈偵測誤判 LINE 聊天**

**現象**:
使用者連續傳 10 則訊息(很正常的聊天頻率),bot 突然回:
「API 配額已達上限或偵測到異常,bot 暫停回應」

**原因**:
所有 LINE 訊息共用同一個 taskContext = `line-message-{userId}`,
迴圈偵測器查到 1 小時內同 task >10 次 → 觸發保護 → 拒絕請求。
但其實這 10 則訊息是「10 個不同任務」,不應該算迴圈。

**解法**:
每則 LINE 訊息用獨立 taskContext:
```typescript
taskContext: `chat-${userId}-${event.message.id}` // 用 message ID 確保唯一
```

對 cron 任務、escalation 等「**真的可能迴圈**」的場景,
仍保留 user 級別的 taskContext 進行偵測。

**自動處理建議**:
迴圈偵測的 taskContext 設計原則:
- user-initiated chat → 用 message ID 確保唯一
- scheduled cron → 用 cron type + date 確保 1 天 1 次
- escalation → 用 task ID + escalation level

---

### 坑 #14:**LINE webhook timeout(必須用 Ack+Push 架構)** ⭐ 重要

**現象**:
Claude 回應稍微久(超過 ~3 秒)就 timeout,LINE webhook 顯示 "Canceled"。
連發訊息特別容易卡(第 2 則以後沒回應)。
某些問題(需要深度推理或長回應)永遠沒回應。

**原因**:
LINE webhook 有「短時間內必須回 200」的硬性要求(觀察約 3~5 秒)。
Worker 等 Claude 慢慢回 → LINE 沒等到 200 → 標記失敗 → 整個 reply 鏈中斷。
就算 worker 後來回了 LINE reply,LINE 端已當失敗。

**單純換模型不能解決**:
Haiku 也要 2.4 秒(網路延遲到 Anthropic 是主要瓶頸,非模型生成速度)。

**唯一解法:Ack + Push 架構**:
```typescript
export async function handleLineWebhook(c) {
  // 1. 立刻 ack
  const events = parseEvents(...);
  for (const event of events) {
    ctx.waitUntil(processInBackground(event, env));
  }
  return c.json({ ok: true }); // < 100ms 回 LINE

}

async function processInBackground(event, env) {
  const reply = await callClaude(...); // 慢慢跑
  try {
    await client.replyMessage({ replyToken, ... }); // 先試 reply
  } catch {
    await client.pushMessage({ to: userId, ... }); // 過期 fallback push
  }
}
```

**代價**:
- Push API 吃 LINE 推播額度(免費 200/月)
- 若需要更多,升級 LINE 進階用量 NT$800/月(3000 則)

**自動處理建議**:
套件預設用 Ack + Push 架構,不要用同步 reply。

---

### 坑 #14 舊版:**LINE webhook 5 秒 timeout(實際更短)**(已被 #14 取代)

---

### 坑 #16:**LINE 純文字訊息不支援 Markdown**

**現象**:
Claude 回應用了 `**粗體**`、`# 標題`、`*斜體*` 等 markdown 語法,
LINE 端**原樣顯示星號井號**,使用者看到一堆 ** 符號很醜。

**原因**:
LINE Messaging API 的純文字訊息(type=text)是「**純字串**」,
不解析任何 markdown / HTML 格式。

要 rich format 必須用 Flex Message(JSON 結構 + 自訂排版),
但 Flex Message 寫起來複雜(每個按鈕、區塊都要 JSON 定義)。

**解法**:
在 system prompt 明確禁止 Claude 用 markdown:
```
【LINE 訊息格式重要規則】
- 絕對不要用 **粗體** / # 標題 / *斜體* / `代碼`
- 強調用【】→ ● ━━━ 這類純文字符號
```

**自動處理建議**:
- 系統提示明確禁止 markdown(這個套件預設要做)
- 進階版可在「需要 rich UI」場景才用 Flex Message
- 簡單條列用純文字 - 即可,別用 markdown bullet

---

### 坑 #17:**Bot 不知道使用者特定 Notion 頁面用途**

**現象**:
使用者問「我今天有什麼事」,
bot 用 search_notion("工作記錄") 找到月度紀錄頁,
但發現「今天」還沒進去 → 回「沒有今天的記錄」。

實際上使用者**今天的事**寫在「**今日計畫**」這個獨立頁面,
bot 不知道這頁存在。

**原因**:
使用者的 Notion 結構是個人化的,bot 沒有先驗知識。
單靠 `search_notion` 不夠 — Notion search 只搜「頁面標題」,
不會理解「**今天 vs 月度歸檔**」的語意差異。

**解法**:
在 system prompt 加「**Notion 結構導航**」:
- 列出使用者主要頁面 + 用途 + page_id
- 例:「『今日計畫』(id: xxx)是每天主要書寫處,問『今天』要讀這個」

**自動處理建議**:
安裝精靈 setup 時:
1. 引導使用者列出主要 Notion 頁面用途
2. bot 把這些寫進「Notion 結構」共享記憶頁面
3. 每次對話前 system prompt 帶入這份結構

或更聰明:bot 主動偵測「使用者常用哪些頁面 + 內容類型」,自動建索引。

---

## 預計還會碰到的坑(等遇到再補)

- [ ] Anthropic API 信用卡綁定 / 月度上限設定
- [ ] Anthropic API rate limit
- [ ] Twilio 號碼申請的 KYC 流程
- [ ] Twilio 在台灣的號碼可用性
- [ ] LINE 訊息免費額度耗盡的處理
- [ ] Cloudflare Workers 免費額度耗盡

---

---

## 🟥 2026-05-18 大幅更新 — bot 行為層級的坑(v28~v41)

開發到 v41 階段累積的「**Claude 行為**」與「**Notion 工具設計**」相關坑。
這些不是「安裝」坑,但會影響商品化版的「**default system prompt**」與「**工具規格**」設計。

---

### 坑 #18:Claude 會根據對話歷史「自作主張補做動作」

**現象**:使用者只說「電腦版測試一下動畫」,bot 卻把對話歷史中提過要加的「14:00 回學生」「17:00 回學生」自動再次寫進 Notion。等於對歷史請求重複執行。

**根因**:Claude 看到 conversation history 含可執行任務時,會誤判為「現在要做」。

**v32 解法**:system prompt 最前面加「最重要規則」:
```
- 對話歷史只能用來理解語境,絕對不能拿來重做動作
- 模糊請求(「測試」「看看」「再說一次」)→ 直接回應,不要呼叫任何寫入工具
```

**商品化版必做**:這條規則寫進 default system prompt 模板,所有 buyer 的 bot 預設有這條保護。

---

### 坑 #19:Claude 在 tool loop 內連呼兩次同一個寫入工具

**現象**:使用者說「加 14:00 看牙醫」,Notion 出現兩筆「14:00 看牙醫」。

**根因**:Claude 不確定第一次是否成功,於是 retry。Tool loop 沒有 dedup 機制。

**v30 解法**:tool 級 dedup,KV 標記「同 toolName+type+text 60 秒內擋下」。

**商品化版必做**:寫入類工具預設都套這個 dedup pattern。

---

### 坑 #20:LINE webhook 偶發 retry 同一則訊息

**現象**:使用者只傳一則,bot 處理兩次。

**根因**:LINE 對沒及時回 200 的 webhook 會重送。

**v30 解法**:webhook 級 dedup,KV 用 `event.message.id` 標記已處理(TTL 5 分鐘)。

**商品化版必做**:webhook handler 預設帶這個 dedup。

---

### 坑 #21:Claude 編造 Notion block_id 導致 update / delete 全 404

**現象**:批次操作執行時 11 筆全部 `404 Not Found`。

**根因**:`read_notion_page` 工具回傳給 Claude 時**只給文字,不給 block_id**。Claude 收到「☐ 14:00 看牙醫」但不知 id,呼叫 update_block 時只能編造 → Notion API 拒絕。

**v38 解法**:`read_notion_page` 每行結尾加 `[block:xxx-xxx-...]`;system prompt 強調「block_id 必須從標記抓,絕不可編造」。

**商品化版必做**:**任何讀取工具,若搭配對應的寫入工具,read 結果都要把對應 id 一起 expose 給 Claude**。這是通則,不限 Notion。

---

### 坑 #22:Claude 呼叫工具前寫「我來用 propose_batch_action 讓你確認」開場白,被 maxTokens 截斷

**現象**:bot reply 顯示「以上是本次要修改的 11 筆排程⋯」但「以上」沒有內容,清單缺失。

**根因**:
1. Claude 講「我來用 XXX」這種開場白 → 多消耗 output token
2. propose_batch_action 的 input 是大 JSON,加上開場白後超過 maxTokens 800 → tool_use 區塊輸出不完整 → 等於沒呼叫
3. 即使呼叫成功,Claude 之後 reply 也偷懶寫「以上⋯」假裝有清單

**v36 + v37 解法**:
- maxTokens 從 800 → 2000
- system prompt 加「呼叫工具前不要寫『我來⋯』開場白,直接呼叫」
- line.ts 不靠 Claude 轉述,直接從 KV 撈 pending 內容覆寫 reply

**商品化版必做**:
- 預設 maxTokens 至少 1500
- system prompt 強調「直接呼叫工具,不寫開場白」
- 批次/長清單類工具,reply 不靠 Claude 轉述,server-side 組訊息

---

### 坑 #23:把大型 Notion 頁面塞進 system prompt 導致 rate limit

**現象**:bot 一直回 `429 rate_limit_error`,使用者根本沒辦法對話。

**根因**:把整個大型記憶同步頁(數萬字 = ~72K tokens)放進 shared memory。每次對話 input 60K+ tokens,直接超過 Sonnet 4.6 的 30K tokens/min 限額。

**v40 解法**:shared memory 只放 4 個精煉頁(總計 ~10K 字),大型頁面改成「Claude 需要時用 read_notion_page 工具按需讀」。

**商品化版必做**:
- shared memory 上限警告:在 setup wizard 計算所選頁面總字數,超過 10K 字警告 buyer
- 預設 system prompt 大小監控:每次部署前估算
- 文件明寫「Anthropic rate limit 知識」給 buyer 的 Claude 看

---

### 坑 #24:LINE 5 秒 webhook timeout 配 Claude 慢回應

**現象**:訊息送出後 bot 沒回,LINE 訊息中心顯示 "Canceled"。

**根因**:LINE webhook 要求 5 秒內回 200。Claude API 經常 3~8 秒才回,常常超時。

**早期 v17 解法**:Ack+Push 架構 — webhook handler 收到後立刻回 200,真實處理放 `ctx.waitUntil`。處理完用 push API 送(若 reply token 還沒過期就用 reply,過期 fallback push)。

**商品化版必做**:預設架構就是 Ack+Push,不給 buyer 選擇用同步處理。

---

### 坑 #25:@anthropic-ai/sdk 在 Cloudflare Workers 失敗(silent)

**現象**:用官方 SDK 呼叫 Claude,沒錯誤訊息但 bot 完全沒回應。

**根因**:SDK 內部用了 Node-only API,在 Cloudflare Workers runtime 不相容,但 fail 是 silent。

**早期解法**:全面改用 `fetch` 直呼 Anthropic API。

**商品化版必做**:
- 程式碼模板**不安裝 @anthropic-ai/sdk**,只用 fetch
- INSTALL.md 明寫「絕對不要裝 SDK」

---

### 坑 #26:LINE 不支援 markdown,**bold** 顯示成字面 ** 符號

**現象**:bot 回 `**重要**`,使用者看到 `**重要**` 字面。

**根因**:LINE 訊息純文字,不渲染 markdown / HTML。

**解法**:system prompt 禁止 markdown,用「【】」「━━━」「→」等純文字符號做視覺強調。

**商品化版必做**:這條規則寫進 default system prompt。

---

### 坑 #27:LINE OA 預設「自動回應訊息」會蓋掉 webhook

**現象**:webhook 已部署且簽章 OK,但使用者只收到 LINE 預設「感謝您的訊息」,沒收到 bot 回應。

**根因**:LINE Official Account Manager → 回應設定 → 預設「自動回應訊息」開啟,優先於 webhook。

**解法**:LINE OA Manager → 設定 → 回應設定:
- 關閉「自動回應訊息」
- 開啟「Webhook」

**商品化版必做**:setup wizard 提示這一步,並提供截圖步驟。

---

### 坑 #28:Cloudflare token 缺 Workers AI 權限(Whisper 用)

**現象**:語音訊息傳給 bot,bot 不回應(內部 Whisper 呼叫失敗)。

**根因**:「Edit Cloudflare Workers」模板沒含 Workers AI 權限。

**解法**:Custom Token,加 Account → Workers AI → Edit。

**商品化版必做**:setup wizard 列權限清單一定包含 Workers AI。

---

### 坑 #29:Notion 頁面要先 Share 給 integration 才能讀寫

**現象**:Notion API 回 `object_not_found` 或 `unauthorized`。

**根因**:Notion 預設 integration 沒有任何頁面權限,要逐頁 Share。

**解法**:在 Notion 頁面右上 ⋯ → Connections → 加 integration。**或**:加 integration 到一個 root 頁面,所有子頁面自動繼承。

**商品化版必做**:setup wizard 教 buyer 把 integration 加到 root 頁面(一次解決所有子頁)。

---

### 坑 #30:LINE 桌面版(Mac/Windows/iPad)缺多項手機獨享功能

**功能 vs 平台**:
| 功能 | iOS/Android | Mac/Win | iPad |
|---|---|---|---|
| Rich Menu | ✓ | ✗ | ✗ |
| Loading Indicator(輸入中⋯) | ✓ | ✗ | ✗ |
| Quick Reply | ✓ | ✓ | ✓ |
| Flex Message | ✓ | ✓ | ✓ |

**影響**:若 buyer 主要用桌面 LINE,Rich Menu 跟 Loading 動畫的價值近 0。

**解法**:用 Quick Reply 取代 Rich Menu;告知桌面用戶 bot 回應慢時不會有動畫但會有訊息。

**商品化版必做**:setup wizard 問 buyer「主要用手機還是桌面?」,主要桌面就跳過 Rich Menu 設定。

---

### 坑 #31:bot 對使用者承諾「可撤回」但實際沒實作

**現象**:bot 訊息結尾寫「如要撤回,跟我說『撤回剛才那筆』」,使用者真的打了卻沒任何反應(或 Claude 亂猜怎麼做)。

**根因**:先寫了 prompt 提示,後寫的功能還沒到位 → 中間狀態被使用者踩到。

**v34 解法**:撤回功能 → KV 記每次寫入的 block_id → 「撤回剛才那筆」直接走 Notion API DELETE,不靠 Claude。

**商品化版必做**:**system prompt 中的所有「使用者可以做 X」提示,對應功能都必須完整實作**。否則就是欺騙。

---

### 坑 #32:Anthropic API 沒寫好錯誤格式提示給使用者

**現象**:使用者看到「(內部錯誤 5827ms) Claude API 429: {"type":"error","error":{...}」一大串 JSON。

**根因**:錯誤直接吐給使用者,沒人話翻譯。

**待修**:把 429/500/timeout 等常見錯誤翻成人話。例:
```
⚠️ bot 暫時繁忙,1 分鐘後再試
(技術原因:本月 API 用量短時間集中,等 token 額度補回)
```

**商品化版必做**:error message 一律翻成人話,技術細節寫在 log 不給使用者看。

---

## 🟥 2026-05-19 大幅更新 — Notion 讀取 + memory sync 的坑(v100~v107)

### 坑 #33:Tool description 寫死的數字 Claude 會當真(自我設限)

**現象**:`read_notion_page` 工具實作早就支援 300 block / 30000 字(分頁讀),但 description 還停留在「最多 50 blocks」。Claude 讀完 75 個 block 後,信了 description 描述,回使用者「我只看到前 50」「沒看到後面的 X」,使用者氣得問「為什麼找不到?」。

**根因**:Claude 把 tool description 當作自身能力的權威說明,**不會去驗證實際 tool 回傳長度**。即使 tool 回傳的內容明顯超過 description 寫的上限,Claude 仍會以 description 為準下判斷。

**v105 解法**:description 跟實作對齊,並補一句指令:「請完整檢視整份回傳內容再回答,不要看到開頭幾段就下結論說『沒有 X』」。

**通用原則**(寫進新 buyer playbook):
- 改 tool 實作時,**同步改 description**(尤其是上限、能力、行為描述)
- description 不只描述「能做什麼」,還要描述「Claude 該如何使用回傳結果」
- 改完後實測一次「Claude 是否真的會用滿能力」
- 同類風險:token 上限、結果筆數上限、支援格式、超時時間

---

### 坑 #34:Notion delete + append race condition — sync 回報成功但實際失敗

**現象**:`sync.sh` 跑完報告 `已寫入 75 / 75 === 同步完成 ===`,5 分鐘後從 Notion API 拉同一頁,**實際只剩 3 個 block**。全部 30 個 .md 檔的內容消失。

**根因**(推測):Notion API 在「同一個 page 先 DELETE 後 PATCH append」的時序場景有 race:
1. `DELETE /blocks/{id}` × 73 個舊 block
2. 緊接著 `PATCH /blocks/{page}/children` append 75 個新 block
3. Notion 後端 indexer 的 race 可能把 append 的也算進 delete 範圍

不是每次都發生,但會發生。

**v107 + 後續解法**:
- sync.sh 跑完務必驗證 Notion 實際 block 數,跟預期一致才算成功
- 實際 < 預期 70% → 自動重試一次
- TODO: 把驗證自動加進 sync.sh

**通用原則**:**任何「delete 後 append」的批量寫入,寫完必獨立驗證實際狀態**。不要相信 API 回的 200。

---

### 坑 #35:read_notion_page 必須在回傳開頭塞「heading 目錄」,否則 Claude 看前段就誤判

**現象**:Notion 同步頁有 33 個 heading / 51923 字 / 完整 preset_modes.md 內容,但 bot 連續 3 次回使用者「沒看到 preset 商品化設計」。Claude 看了前段 feedback_* 區後就下結論「project_*.md 沒有這份」。

**根因**:Claude 處理 50000 字長文時,有「看前段先下結論」的傾向。沒有目錄索引時,看到一半就答覆,不會主動掃完整段。

**v107 解法**:`read_notion_page` 回傳開頭強制塞 heading 目錄:

```
[本頁 heading 目錄,共 33 段 — 回答前先掃這份目錄,確認問題對應段是否存在]
1. README.md
2. feedback_xxx.md
...
20. project_line_bot_preset_modes.md
...

[完整內容]
## README.md
...
```

Claude 第一眼看到目錄,就知道「20. preset_modes 確實存在」,不會誤判「沒有」。

**通用原則**:**任何長文 tool 回傳,前面要有「索引/目錄/段標題列表」**,Claude 才不會局部下結論。

---

### 坑 #36:Bash tool 的 description 欄位必須用使用者母語

**現象**:Claude Code 跑 Bash 工具時,description 欄位會直接顯示在權限對話框內(指令下方那一行)。Claude 預設用英文寫 description("Deploy v105"、"Re-sync and verify")。**繁中使用者看到一堆英文,看不懂在請求什麼權限**。

**根因**:Claude 訓練時英文 description 太強勢,沒考慮母語非英文的使用者。

**解法**:任何要給使用者看的欄位(Bash description、AskUserQuestion options)一律寫使用者母語:
- 壞:`"Deploy v105"` `"Check Notion page size"`
- 好:`"部署 v105"` `"檢查 Notion 頁面大小"`

**通用原則**(寫進新 buyer playbook):
- 寫程式給「Claude 主動跑」的 description 欄位,要意識到「這文字會被使用者看到」
- 若 buyer 是非英文母語,在 CLAUDE.md 內寫清楚「所有 Bash description 一律用 X 語言」
- 同類欄位:AskUserQuestion 的 question/options.label、commit message(視文化)

---

從上述坑歸納的設計原則:

1. **明確告知「現在在哪個系統」** — LINE OA Manager / Developers Console 切換時尤其重要
2. **權限預檢 + 自動補強** — 不要靠模板,要明確 enumerate 需要的權限
3. **每個外部 UI 動作配截圖** — 因為平台 UI 會改版
4. **重要動作配「儲存」提醒** — 別讓 buyer 以為填了就生效
5. **完成後自動測試** — webhook 通不通?secret 都對嗎?自動測一輪
6. **每個失敗情境配明確解法** — 「失敗了該去哪檢查」
7. **記錄當下版本的 UI 描述** — 標明「本文件適用於 2026 年 5 月的 LINE OA Manager 版本」,改版時 buyer 的 Claude 用 web search 驗證
