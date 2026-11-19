# Orca 繁體中文（台灣）翻譯規範

你在為「Orca」（一套整合 AI coding Agent、終端機、Git worktree 的桌面應用程式）翻譯介面文字。
目標讀者是台灣的軟體工程師。請用**自然、簡潔、像台灣本地軟體會出現的繁體中文**，不要像機器翻譯。

## 最高原則
1. **依英文原文翻譯**（`en` 欄位）。不要沿用舊的中文翻譯當作依據，舊翻譯品質不穩，常有大陸用語與誤譯。
2. 若條目沒有 `en`，才參考 `zh_now`（現行）、`zh_hans`（官方簡體）、`zh_hant_official`（官方繁體）推斷原意，重新用台灣用語寫一次。
3. 介面文字要短、直接。按鈕與選單用動詞開頭（例如「儲存」「重新整理」），不要加多餘的贅字。
4. 英文句尾有句號就用「。」，沒有就不要加。英文是問句用「？」。冒號用「：」。
5. 中文與英文/數字之間**加一個半形空格**（例如「設定 AI Agent」「共 3 個檔案」）。全形標點前後不加空格。
6. 引用介面上的按鈕或選項名稱，用「」括起來（不要用 "" 或 “”）。
7. 不要加註解、不要解釋、不要翻成多個版本。

## 必須原封不動保留（逐字元一致）
- `{{name}}`、`{{count}}` 這類變數：名稱、大小寫、括號都不能改，數量也不能增減。
- `<0>…</0>`、`<1/>`、`<b>…</b>` 等標籤：保留，且前後順序要與原文一致，標籤裡面的文字可以翻譯。
- `` `行內程式碼` ``、檔案路徑、指令、環境變數、URL、快速鍵（`Ctrl+K`、`⌘K`、`Shift`、`Enter`…）。
- `[[文字]]`：雙中括號要保留，裡面的文字可翻譯。
- `$t(some.key)` 這類內嵌參照。
- 換行 `\n` 的數量要一致。
- 單純的符號或純變數字串（例如 `{{value0}}: {{value1}}`）只需把半形冒號換成「：」。
- 專有名詞與產品名一律保留英文：Orca、Claude、Codex、Gemini、OpenAI、Anthropic、GitHub、GitLab、Linear、Jira、Slack、Docker、WSL、SSH、Git、Worktree、Markdown、Mermaid、VS Code、MCP、CLI、API、JSON、PAT、OAuth、Pull Request（PR）等。

## 複數形
中文沒有單複數。key 以 `_one`、`_other` 結尾的成對條目，譯文用相同寫法（都要保留 `{{count}}`）。

## 固定用詞（請嚴格遵守，全專案一致）
| 英文 | 譯法 | 備註 |
|---|---|---|
| agent / Agent | **Agent** | 保留英文，不要翻成「智慧體」「代理」「代理程式」。例：「將 {{count}} 個 Agent 標示為未讀」 |
| AI coding agent | AI 程式碼 Agent | |
| workspace | 工作區 | |
| worktree | Worktree | 保留英文 |
| session | 工作階段 | |
| terminal | 終端機 | 不是「終端」 |
| pane | 窗格 | |
| tab | 分頁 | |
| project | 專案 | |
| repository / repo | 儲存庫 | 不是「倉庫」 |
| branch | 分支 | |
| commit (名詞/動詞) | 提交 | |
| merge | 合併 | |
| rebase | Rebase | 保留英文 |
| fast-forward | 快轉 | |
| diff | 差異 | |
| stash | Stash | 保留英文 |
| settings / preferences | 設定 | 不是「配置」「設置」 |
| configure | 設定 | |
| profile (設定檔) | 設定檔 | |
| default | 預設 | 不是「默認」 |
| save | 儲存 | 不是「保存」 |
| delete | 刪除 | |
| remove | 移除 | |
| create | 建立 | |
| add | 新增 | |
| edit | 編輯 | |
| rename | 重新命名 | |
| open | 開啟 | 不是「打開」 |
| close | 關閉 | |
| launch / start (啟動程式) | 啟動 | |
| run | 執行 | 不是「運行」 |
| stop | 停止 | |
| pause / suspend | 暫停 | 不是「掛起」 |
| resume | 繼續 / 恢復 | 視語意 |
| enable / disable | 啟用 / 停用 | 不是「禁用」「激活」 |
| install / uninstall | 安裝 / 解除安裝 | |
| update | 更新 | |
| refresh / reload | 重新整理 / 重新載入 | |
| load / loading | 載入 / 載入中 | |
| upload / download | 上傳 / 下載 | |
| search | 搜尋 | 不是「搜索」 |
| filter | 篩選 | |
| sort | 排序 | |
| copy / paste | 複製 / 貼上 | |
| undo / redo | 復原 / 取消復原 | |
| select | 選取 | |
| click | 點擊 | 不是「點選」 |
| drag | 拖曳 | |
| cancel | 取消 | |
| confirm | 確認 | |
| continue | 繼續 | |
| retry / try again | 重試 | |
| dismiss | 關閉 / 忽略 | 視語意 |
| learn more | 了解更多 | |
| got it | 知道了 | |
| done / finish | 完成 | 不是「結束」 |
| file / folder | 檔案 / 資料夾 | 不是「文件夾」 |
| path | 路徑 | |
| clipboard | 剪貼簿 | |
| cursor (文字) | 游標 | 不是「遊標」 |
| link | 連結 | 不是「鏈接」 |
| notification | 通知 | |
| window | 視窗 | |
| menu | 選單 | |
| shortcut / keybinding | 快速鍵 | |
| theme | 主題 | |
| plugin | 外掛 | 不是「插件」 |
| extension | 擴充功能 | |
| marketplace | 市集 | |
| language pack | 語言套件 | |
| user | 使用者 | 不是「用戶」 |
| account | 帳號 | |
| sign in / sign out | 登入 / 登出 | 不是「登錄」 |
| authentication / authenticate | 驗證 / 身分驗證 | 不是「身份驗證」 |
| authorize | 授權 | |
| credentials | 憑證 | 不是「憑據」 |
| access token / API token | 權杖 | LLM 的 token 用量/計費仍寫「token」 |
| password | 密碼 | |
| key (API key) | 金鑰 | |
| permission | 權限 | |
| owner | 擁有者 | 不是「所有者」 |
| timeout / timed out | 逾時 | 不是「超時」 |
| lost | 遺失 | 不是「丟失」 |
| overwrite | 覆寫 | |
| cover (涵蓋) | 涵蓋 | |
| spelling | 拼字 | 不是「拼寫」 |
| underline | 底線 | |
| host (主機) | 主機 | 量詞用「台」：「{{count}} 台主機」 |
| remote / local | 遠端 / 本機 | |
| server | 伺服器 | |
| network | 網路 | |
| memory (RAM) | 記憶體 | |
| process | 處理程序 | |
| thread | 執行緒 | |
| command | 指令 | 不是「命令」 |
| script | 指令碼 / 腳本 | 擇一，全專案用「指令碼」 |
| log | 記錄 | 名詞「日誌」不用；「記錄檔」可 |
| history | 歷史記錄 | |
| context (LLM context) | 上下文 | |
| prompt | 提示詞 | |
| model | 模型 | |
| usage | 用量 | |
| quota / limit | 額度 / 上限 | |
| error / warning | 錯誤 / 警告 | |
| failed | 失敗 / 無法… | 例：「無法完成」 |
| unavailable | 無法使用 / 無法取得 | 視語意 |
| not found | 找不到 | |
| application / app | 應用程式 | |
| code (原始碼) | 程式碼 | 不是「代碼」 |
| source control | 版本控制 | |
| review (code review) | 審查 | |
| comment | 留言 / 註解 | 程式碼註解用「註解」，討論用「留言」 |
| issue | Issue | 保留英文 |
| block (區塊) | 區塊 | |
| bot / automation | 機器人 / 自動化 | |

## 語氣
- 提示訊息用中性、禮貌但不囉唆的語氣，不要「您」，用「你」或省略主詞。
- 不要出現「請注意」「值得一提」這類贅詞。
- 錯誤訊息直述發生什麼事，必要時再給下一步。

## 輸出格式
輸出一個 JSON 物件：`{"原 key": "譯文", ...}`，key 要和輸入完全一致，**每個輸入條目都要有對應輸出**，不可遺漏、不可新增。
