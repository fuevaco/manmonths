# Skill 同步 (Skill Sync)

專為 **[Orca](https://github.com/stablyai/orca)** 開發的 Skill 同步側邊欄套件：從符合 **[Skills Registry API 標準 v1](./docs/SKILLS-API-SPEC.md)** 的技能庫取得 skill 清單，由你逐項檢閱、勾選後，同步到「全域」或指定的 Orca 專案。

## ✨ 主要功能

- **先看清單、再決定要不要裝**：面板列出技能庫所有 skill，標示「新」「有更新」「有衝突」「已同步」，可搜尋、篩選。
- **全域或逐專案**：全域寫入家目錄的 `.agents/skills/`，所有專案都能用；專案則寫入專案根目錄與它底下**所有本機工作樹**（每個 Git worktree 是獨立資料夾，主 repo 的檔案不會出現在其他工作樹）。
- **對齊 Orca 原生做法**：實體檔案放在 `.agents/skills/<name>/`，再連結（Windows 用 junction，免管理員權限）到**已經存在**的 Agent 資料夾（預設 `.claude/skills`），不替沒在用的 Agent 建資料夾。
- **完整性驗證**：每個檔案核對大小與 SHA-256，整個 skill 再核對 `digest`；任何一項不符就整包拒絕，不會寫入磁碟。
- **安裝前檢閱**：列出檔案數與大小；含指令碼 / 可執行檔的 skill 會明確警告，勾選「我已檢閱」才能確認。`hasScripts` 由外掛依檔案自行判斷，不信任伺服器宣告。
- **不覆蓋你改過的東西**：安裝後被你修改的副本、或同名但不是由本外掛安裝的資料夾，預設一律略過；你在檢閱畫面明確勾選才會取代，取代前先備份到 `~/.agents/.skill-sync-backups/`。
- **不弄髒 git**：專案內的 skill 路徑寫入該 repo 的 `.git/info/exclude`（只在本機生效，不改 `.gitignore`，不會被 commit），可在設定關閉。
- **Token 安全**：Token 用 Orca 的 `secrets:own` 加密儲存，只會送給 API 所在的來源，不會隨轉址或檔案下載送到其他網站；除 `localhost` 外不透過未加密 HTTP 傳送。
- **內建 API 驗證**：設定畫面的「驗證 API」逐項檢查技能庫是否符合標準，網店開發時可直接使用。

## 🚀 使用方式

1. 於 Orca 安裝並啟用 **`manmonths.skill-sync`**（權限：`settings:own`、`secrets:own`、`storage:own`、`workspace:read`、`notifications:show`）。
2. 開啟右側邊欄的 **Skill 同步**，在設定畫面填入技能庫 **API 網址** 與 **Token**，按「驗證 API」確認符合標準，再按「儲存並載入」。
3. 在「同步到哪裡」勾選全域或專案，勾選要同步的 skill，按「檢閱並同步」。
4. 確認檢閱內容後按「確認同步」。之後技能庫有新版，面板會標示「有更新」，再同步一次即可。

> 同步是「按下去才執行」，不會在背景自動寫入。之後新建立的工作樹不會自動補裝，需要再同步一次（同步是冪等的，沒變更的會跳過）。

## ⚙️ 設定

| 設定 | 預設 | 說明 |
|---|---|---|
| 技能庫 API 網址 | 空 | 根網址（讀取其下 `index.json`）或直接指向 `.json` |
| Token | 空 | 在面板設定畫面輸入，加密儲存 |
| 連結到哪些 Agent 資料夾 | `.claude/skills` | 逗號分隔；只連結到已存在的資料夾 |
| 專案內的 skill 不顯示在 git status | 開 | 寫入 `.git/info/exclude` |
| 允許內網自簽 HTTPS 憑證 | 關 | 內網技能庫用 |
| 允許未加密 HTTP | 關 | `localhost` 以外的 http 才需要；Token 會明文傳送 |

## 🧩 技能庫開發者

- 標準：[`docs/SKILLS-API-SPEC.md`](./docs/SKILLS-API-SPEC.md)
- 把資料夾轉成標準格式：`node tools/build-registry.mjs <skills 資料夾> <輸出資料夾>`
- 本機跑參考實作：`node tools/mock-server.mjs examples/skills --token secret --prefix /api/v1`
- 驗證你的 API：`node tools/verify-api.mjs <API 網址> --token <token> --require-auth`

## 🧪 測試

```bash
node --test "test/*.test.mjs"
```

涵蓋標準驗證、驗證工具（含「伺服器沒檢查 Token」「檔案被竄改」等負面案例）、安裝 / 更新 / 衝突 / 備份 / 移除、git 排除，以及用假的 Orca 主機跑完整的 worker 流程。

## 目錄結構

```text
skill-sync/
├── orca-plugin.json
├── worker/
│   ├── spec.mjs          標準的可執行版本：驗證、摘要、路徑安全
│   ├── http.mjs          受控 HTTP（大小上限、逾時、轉址、Token 範圍）
│   ├── api-client.mjs    取得索引 / 清單、下載並驗證
│   ├── conformance.mjs   API 一致性驗證
│   ├── installer.mjs     寫入、連結、備份、移除、git 排除
│   ├── sync-core.mjs     規劃與執行同步
│   ├── targets.mjs       全域 / 專案目標解析
│   └── index.mjs         Orca worker 入口
├── panel/                面板 UI
├── tools/                build-registry / mock-server / verify-api
├── docs/SKILLS-API-SPEC.md
├── examples/skills/      範例 skill
└── test/
```
