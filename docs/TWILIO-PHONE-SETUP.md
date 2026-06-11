# Twilio 電話介入 — 安裝指南(選配)

> 給「**你的 Claude**」看的安裝腳本,不是給使用者直接讀的。
> 這是 INSTALL.md Step 12 的詳細版。使用者想要「嚴重拖延時 bot 真的打電話給他」時才需要。
> 需先完成 INSTALL.md Step 1–11。

## 給 Claude 的指令

使用者多半沒工程背景。每步用白話解釋、外部 UI 給明確網址、終端機指令說明會看到什麼、介面可能改版以螢幕為準。**白話帶,但不用每個動作都切開等確認 —— 一段順順講完即可。** Twilio 對台灣有先天限制(見雷區),先讓使用者知道,避免他以為自己裝錯。

## 開始前

確認已完成 INSTALL.md Step 1–11、bot 能在 LINE 回話;準備一支台灣手機(收簡訊驗證碼,也是日後被撥打的號碼)。

## 從零安裝

**B-1 註冊 Twilio** — 帶使用者打開 twilio.com 註冊,**用 Google 帳號登入最快**,不需綁信用卡。註冊後是 trial 試用帳號,附一筆試用金。

**B-2 驗證你的手機號(必做)** — trial 只能撥「已驗證」的號碼。帶他到左側 **Phone Numbers → Manage → Verified Caller IDs**,加台灣手機、收簡訊碼驗證。

**B-3 拿 SID / Auth Token / 號碼(同一頁拿齊)** — 帶他在 **Account Dashboard 首頁往下滑到「Account Info」區塊**,三樣一次拿:
- Account SID(AC 開頭、半公開)
- Auth Token(點旁邊「Show」才顯示,可反覆查看)
- My Twilio phone number(trial 送的號碼,+1 開頭)
Auth Token 等於帳號主密碼,別貼公開處。先存好,B-5 要用。

**B-4 電話號碼** — trial 通常**已經送一個號碼**(就是 B-3 的 My Twilio phone number),可直接用、不必另外買。想自己挑號碼才需要買:左側 **Phone Numbers → Manage → Buy a number**。⚠ 號碼是美國號(+1),撥台灣會有詐騙警語(見雷區),不是裝錯。

**B-5 把 4 個密碼存到雲端**

使用者多半第一次用終端機,白話帶、但不用每個動作切開確認,順順講完整段:

先打開終端機(Mac:按 ⌘ + 空白鍵 → 打「終端機」→ Enter),確認視窗裡有 `line-ai-secretary` 這個字(沒有就先貼 `cd line-ai-secretary` 按 Enter)。然後把下面 4 行**一行一行**貼上執行 —— 每貼一行按 Enter 後,會出現英文 `Enter a secret value:`(意思是「請輸入密碼」),就把右邊對應的值貼上、再按 Enter:

```
npx wrangler secret put TWILIO_ACCOUNT_SID    → 貼 B-3 的 Account SID
npx wrangler secret put TWILIO_AUTH_TOKEN     → 貼 B-3 的 Auth Token
npx wrangler secret put TWILIO_PHONE_NUMBER   → 貼 B-3 的 Twilio 號碼(+1 開頭)
npx wrangler secret put USER_PHONE_NUMBER     → 貼你手機,開頭 0 改 +886(例 +886912345678)
```

兩個一定要先提醒的點:**① 貼密碼時畫面看不到字是正常的**(故意藏起來,不是當機);**② 一行一行來**,別一次全貼。4 個都看到 `Success` 就成功,secret 即時生效、不用重新部署。

**B-6 測試「打給我」**

請使用者在 LINE 傳「打給我」。先講預期免得他嚇到:幾秒內手機會響,**trial 帳號接起來會先聽到英文、要按手機任一鍵**才聽到中文「這是你的 AI 秘書打來的測試電話…」—— 正常現象。沒通就依序查:① 手機號是不是 +886 正確格式(最常見錯)② 那支有沒有在 B-2 驗證 ③ 還不行帶他跑 `npx wrangler tail` 再打一次看 log。

## 雷區(務必先告訴使用者)

1. **Trial 開頭英文提示音** — 升級付費才消失。
2. **撥號要多按一鍵** — trial 接通要先按任一鍵,升級後消失。
3. **台灣 7 秒詐騙警語** — 美國號撥台灣,台灣電信端(NCC)強制播,**升級也去不掉**,Twilio 無法移除國際號碼標記。
4. **手機號格式(E.164)** — 台灣手機一律 +886 開頭、去掉最前面的 0。
5. **Auth Token = 帳號主密碼** — 別進版控/公開處;外流就去後台申請 secondary token、測通後 Promote 作廢舊的。
6. **中文語音** — 用 Google.cmn-TW-Wavenet-A;失效改其他 cmn-TW 方案。
7. **Trial 號碼可能失效** — 升級後原 trial 號碼可能要重新申請。

## 小技巧:讓來電顯示「AI 秘書」而不是陌生號碼

把你的 Twilio 號碼存成手機聯絡人(例如取名「AI 秘書」),之後 bot 打來,你手機就直接顯示「AI 秘書」,而不是一串陌生的美國號碼。(實測:連台灣電信對國際來電的標記也能一起蓋掉)

## (選配)升級 Pay-as-you-go

要綁卡。能去掉雷區 1(英文提示音)+ 雷區 2(多按鍵);**去不掉雷區 3 台灣 7 秒警語**(台灣端加的、與付費無關)。除非很在意那段英文,否則 trial 就夠用,別白升級。
