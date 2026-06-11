# 更新指南 — 把你的 bot 更新到新版範本

> **適合誰**:已經用「一鍵部署」裝好 bot 的人。
> **資料安全**:你在 /setup 設的 API key、bot 學到的東西、提醒、對話紀錄都存在**你自己的** D1 / KV,**更新程式碼完全不會動到它們**。

## 運作原理(30 秒看懂)

- 一鍵部署時,Cloudflare 把範本程式碼**複製成你自己 GitHub 帳號下的 repo**,並接上自動部署(對它 push 就會自動重新建置部署)。
- 範本之後更新時,你的複製品**不會自動跟上** — 要手動把新版拉進你的 repo。
- 範本每次發佈是「全新快照」(跟你的 repo 沒有共同 git 歷史),所以更新方式是**整個換成新版**,不是一般的 merge(合併)。

## 需要準備

- 一台有 **git** 的電腦(終端機)。沒裝過 git:macOS 跑 `xcode-select --install`,Windows 裝 [Git for Windows](https://gitforwindows.org/)。
- **GitHub 登入**:git push 不收帳號密碼,最簡單是裝 [GitHub CLI](https://cli.github.com/) 跑一次 `gh auth login`(瀏覽器授權)。
- 都覺得太難?**把這整份文件丟給你的 Claude(Claude Code)說「幫我照這個更新」**,讓它帶你做。
- ⚠ **絕對不要**「刪掉 repo 重按一次部署按鈕」— 那會建一個全新的空資料庫,你的設定與資料**真的會丟**。

## ⚠ 更新前須知

- **你改過自己 repo 裡的程式碼嗎?**
  - 沒改過(大多數人)→ 直接照下面做。
  - 改過 → 下面的步驟會**覆蓋你的修改**。先備份你改過的檔案,更新完再套回去。
- 你在 /setup 設的 key、bot 的資料都在你自己的 D1 / KV,照下面步驟做**不會動到**(關鍵是第 3.5 步,別跳過)。
- 若你曾在 Cloudflare dashboard 手動改過 worker 的環境變數(Variables),重新部署會把它們蓋回範本值(/setup 設的不受影響)。改過的人記下來,更新後再改回去。

## 更新步驟

把下面整段丟給你的 Claude(Claude Code)說「幫我照這個更新」,或自己在終端機跑:

```bash
# 0. 先到 github.com 確認你帳號下那個部署時自動建立的 repo 名稱(以下用 <你的帳號>/<你的repo名> 代替)

# 1. 取得你自己的 repo(本機已經有就跳過,cd 進去即可)
git clone https://github.com/<你的帳號>/<你的repo名>.git
cd <你的repo名>

# 2. 加上範本來源(第一次更新才需要,之後可跳過)
git remote add upstream https://github.com/BacoAI/line-ai-secretary-template.git

# 3. 拉新版,整個換上
git fetch upstream
git reset --hard upstream/main

# 3.5 ⚠ 關鍵:拿回「你自己的」資料庫設定檔 — 跳過這步,部署會綁到不存在的資源而失敗!
#     (一鍵部署時 Cloudflare 把你專屬的 D1/KV id 寫進了你 repo 的 wrangler.jsonc;
#      上一步把它換成了範本的假 id,這步從你 repo 原本的版本把真 id 拿回來)
git checkout origin/main -- wrangler.jsonc
git commit -m "update to new template version(保留我的資源 id)"

# 4. 推回你的 repo → Cloudflare 自動重新建置部署(約 1~3 分鐘)
git push --force origin main
```

## 更新後(必做兩件事)

1. 開 `https://你的worker網址/setup` 一次並登入 — 打開頁面當下就會**自動補建**新版需要的資料表(登入是順便確認 key 都在)。
2. 對 bot 說句話,確認回覆正常。

## 看版本

- **你目前的版本**:你 repo 裡 `CHANGELOG.md` 最上面那一條。**repo 裡沒有 CHANGELOG.md = 你還在 v0.1.x**,直接照上面步驟更新即可。
- **最新版本**:範本 repo 的 [CHANGELOG.md](https://github.com/BacoAI/line-ai-secretary-template/blob/main/CHANGELOG.md)。

## 出問題?

- **push 被拒(authentication failed / 403)**:GitHub 認證沒設好 — 跑 `gh auth login`(見最上面「需要準備」)。
- **push 被拒(non-fast-forward)**:確認第 4 步有帶 `--force`。
- **push 了但沒重新部署 / 建置失敗**:Cloudflare dashboard → Workers & Pages → 你的 worker → **Deployments / Builds** 看建置紀錄。錯誤若提到找不到 D1/KV(不認識的 id),九成是**跳過了第 3.5 步** — 回去補做再 push 一次。
- **更新後 /setup 顯示「需要安裝權杖」**:你是 v0.1.x 部署、還沒設過 SETUP_TOKEN — 照 [INSTALL.md 疑難排解](INSTALL.md)到 Cloudflare 後台補設一個 `SETUP_TOKEN` Secret 即可。
- **更新後 bot 不回**:開 `/setup` 登入確認 key 都還在(正常都會在);還是不行就看 worker 的 **Logs**。
- (介面位置若與上述不同,以 Cloudflare 官方頁面為準。)
