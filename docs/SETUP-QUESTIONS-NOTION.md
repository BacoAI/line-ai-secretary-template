# Setup Wizard:Notion 格式關鍵問題(設計稿)

> 安裝時引導 buyer 回答這 5 個問題,bot 自動選對的「智能插入」策略。
> 若 buyer 答案不符合任何預設,fallback 用 AI 偵測。

---

## Q1:你 Notion 用哪個頁面記今天的事?

- **A**. 一個固定頁面(像每天加到「今日計畫」)
- **B**. 每天新建一個 sub-page
- **C**. 每月一頁(像「工作記錄:YY/MM」)
- **D**. 不用 Notion 記,事情在別處(Apple Notes、TODO app、紙本)

策略:
- A → 把該頁面 id 存 `TODAY_PAGE_ID`,寫入該頁
- B → 設定「今天 sub-page 命名規則」+ 父頁 id
- C → 設定「月度頁面命名規則」+ 父頁 id
- D → 走 internal storage mode,不接 Notion

---

## Q2:今天的事在頁面內怎麼區隔?

(僅 Q1=A 才問)

- **A**. 有日期 heading(可勾選)
- **B**. 純文字段落寫日期
- **C**. 沒區隔,直接寫
- **D**. 用 toggle 折疊

策略:
- A → 啟用「找今天 heading 區段末尾」插入策略
- B → 找含日期的段落 → 插在它附近
- C → 直接 append 頁尾 + 自動加日期前綴
- D → 找今天 toggle,展開後插

---

## Q3:日期格式長怎樣?

(僅 Q2=A 或 B 才問)

- **A**. MM/DD(例:05/18)
- **B**. M/D(例:5/18)
- **C**. M月D日(例:5月18日)
- **D**. YYYY/MM/DD(例:2026/05/18)
- **E**. MM/DD 星期X(例:05/18 星期一)
- **F**. 其他自定義(buyer 自己寫範例)

策略:
- 存 `DATE_FORMAT` 變數
- 寫入時依此 format 比對 heading 文字

---

## Q4:任務怎麼記?

- **A**. Notion to-do block(可勾選方框)
- **B**. 純文字一行(像「9:00 開會」)
- **C**. 編號列表(1. 2. 3.)
- **D**. 表格

策略:
- A → 寫入用 `to_do` block
- B → 寫入用 `paragraph` block,文字前綴「時間 + 內容」
- C → 寫入用 `numbered_list_item` block
- D → 進 database row(複雜,可能需另一個流程)

---

## Q5:寫到頁面時想插哪裡?

- **A**. 今天區段末尾(預設)
- **B**. 今天區段開頭(新事項放最上)
- **C**. 頁面最尾端(不分日)
- **D**. 每次寫前先問

策略:
- A → after = 今天區段最後一個 block
- B → after = 今天 heading 本身
- C → after = null(append 頁尾)
- D → bot 寫前先 reply 詢問

---

## Setup 對話範例(給 buyer 的 Claude 用)

```
Claude:「我來幫你設定 Notion 整合。先問 5 個問題,大約 2 分鐘」

Claude:「Q1: 你 Notion 用哪個頁面記今天的事?
A. 一個固定頁面(每天加)
B. 每天新建一個 sub-page
C. 每月一頁
D. 不用 Notion」

User:「A」

Claude:「好。請給我這個固定頁面的 Notion URL,我從中取 page id」

User:「https://notion.so/xxxxxxxxxxxxxxx」

Claude:「拿到了。Q2: 這頁裡今天的事怎麼區隔?
A. 有日期 heading
B. 純文字段落
C. 沒區隔
D. toggle」

User:「A」

Claude:「Q3: 日期 heading 格式長怎樣?(從你頁面看到)
A. MM/DD
B. M/D  
C. M月D日
D. YYYY/MM/DD
E. MM/DD 星期X(例:05/18 星期一)」

User:「E」

Claude:「Q4: 任務通常用什麼 block?
A. to-do 勾選框(預設,推薦)
B. 純文字段落
C. 編號列表」

User:「A」

Claude:「Q5: 新事項插哪?
A. 今天區段末尾
B. 今天區段開頭
C. 頁面最尾
D. 每次問」

User:「A」

Claude:「Setup 完成!你的設定:
- 頁面: 今日計畫
- 區隔: 日期 heading,MM/DD 星期X 格式
- Block: to-do
- 位置: 今天區段末尾

我把這存到設定檔了,bot 開始服務」
```

---

## 對應的 config 檔結構

```yaml
# config/notion-integration.yaml
mode: "today_page" # today_page / daily_subpage / monthly_page / disabled
today_page_id: "<你的-今日計畫-page-id>"
section_style: "date_heading" # date_heading / date_paragraph / none / toggle
date_format: "MM/DD 星期X" # MM/DD / M/D / M月D日 / YYYY/MM/DD / MM/DD 星期X / custom
date_format_regex: "\\d{2}/\\d{2}" # 自動生成或自定義
task_block_type: "to_do" # to_do / paragraph / numbered_list / table_row
insertion_position: "today_end" # today_end / today_start / page_end / ask_each_time
```

---

## Fallback:AI 偵測

若 setup 答案不符合任何預設(或 buyer 選「其他」),bot 第一次寫入時:

1. 讀使用者 Notion 頁面(取前 50 個 block)
2. 把 block 結構 + 使用者要寫的內容 給 Claude
3. Prompt: 「分析這頁結構,使用者要加新事項『XXX』,
   應該插入在哪個 block_id 之後?用 to_do/paragraph/heading 哪個 block?」
4. Claude 回 JSON: `{ after: "block_id", type: "to_do" }`
5. 用這個 block_id 寫入
6. 把這個結果存進 config(下次同類型就不用再問 Claude)

---

## 安裝精靈完整流程

1. 擁有者(主流程)→ Notion 整合 setup
2. Q1~Q5 問完
3. 寫入 config/notion-integration.yaml
4. 測試:「我幫你加一個測試 to-do 看看」
5. buyer 確認 Notion 上看到 → 成功
6. 否則 → fallback 到 AI 偵測或重新問

---

## 對「商品化」的意義

這 5 個問題 + 後備機制,涵蓋 90% 的 Notion 使用者。
剩下 10% 走 AI 偵測,仍然能用(只是慢一點)。

→ 商品版可號稱「**支援任何 Notion 排版風格**」
