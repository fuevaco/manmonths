# AI 資源中心（manmonths.ai-resource-center）

在 Orca 右側欄的「資源中心」連到你有權使用的資源市集，獨立登入、搜尋資源包、閱讀說明，並一鍵安裝、更新或補裝 Skill、Agent、Prompt／Command 與 MCP。外掛與其他用戶端共用全域設定參數及部署收據，不需要另外安裝任何其他工具即可使用。

> [!IMPORTANT]
> **Orca 只管理全域部署。只裝在專案範圍的資源包，在 Orca 會顯示「未安裝」。** 這是預期行為；專案範圍的安裝與更新不在 Orca 處理範圍。Orca 不提供下載 ZIP，也不提供手動選擇部署目標。

## 需求

- Orca 1.4.259 以上（Ubuntu 啟動需要執行期秘密的 MCP 時，可能需要系統的 Node.js，見下方說明）。
- Windows、macOS 或 Ubuntu 22.04／24.04 桌面版，以及要部署資源的 AI 工具：Codex、Claude Code，或 Claude Desktop（只支援 MCP；Linux 不支援）。
- 一個你有權使用的資源市集網址與帳號。外掛沒有預設網址。

## 安裝與第一次連線

1. 開啟 Orca，前往「Settings」→「Plugins」→「Marketplace Sources」，按「Add Source」新增來源：`https://github.com/fuevaco/manmonths.git`，Ref 填 `main`。
2. 選擇「AI 資源中心」按「Install」。外掛要求讀寫自己的設定（`settings:own`）、加密秘密（`secrets:own`）、儲存資料（`storage:own`），以及新增的 Orca 通知權限（`notifications:show`），用於新版提醒。
3. 開啟右側欄的「資源中心」，輸入市集網址（例如 `https://market.example.com`）、帳號與密碼，按「登入」。首次網址欄位留空。
4. 登入成功後才儲存網址與工作階段；密碼不會被儲存。重開 Orca 會續用工作階段，失效時提示重新登入。

要換市集，從頂部的 ⚙ 選單「登出」後輸入新網址。登出只清除 Orca 的工作階段，不影響其他用戶端的登入。本機開發可在「Settings」→「Plugins」→「Local Development」指向 `plugins/ai-resource-center`。

## 瀏覽與閱讀

登入後的頂部列固定顯示：

- **↻ 重新整理**：重新讀取目前畫面的市集資料與本機安裝狀態。在其他用戶端安裝或更新全域資源後，也可用此按鈕同步狀態。
- **⚙ 設定**：選單頂端是帳號與市集主機名稱（滑過可看完整網址），其下是「我的資源包」入口；可調整「檢查更新」頻率、切換「顯示 Preview 版本」或登出，最底部小字是 Orca 外掛版本。不顯示其他用戶端的版本。
- **固定查詢列**：捲動資源清單時，搜尋框與篩選列固定在頂端。

查詢列可依名稱、識別碼或說明搜尋，**輸入後按 Enter**；清空搜尋框會自動重新查詢。類型篩選提供 Skills、Agents、MCP、組合包；狀態篩選提供全部狀態、已安裝、可更新。變更篩選即更新結果。

排序可選安裝次數、名稱、擁有者、上傳日期，並以方向按鈕切換順序。預設為安裝次數多→少；切換欄位時，安裝次數預設多→少、上傳日期預設新→舊、名稱與擁有者預設 A→Z。排序選擇會儲存在外掛自己的儲存區。

卡片顯示名稱、作者、安裝次數、上傳日期、最多兩行的描述、類型與分類。安裝狀態列只列相容 AI 工具的圖示：有色表示至少一個全域根目錄已安裝，灰色表示相容但未安裝。已安裝卡片有綠色左邊線；可更新時改為橘色，並顯示「可更新」徽章及舊版 → 新版。

點卡片進入明細（卡片上的按鈕與 🌐 不會觸發），可展開「安裝位置」、需要時的「設定參數」與版本變更內容。安裝位置列出工具名稱、根目錄、版本與狀態。使用說明以 Markdown 呈現標題、清單、表格、程式碼區塊與連結；按 **⤢ 放大閱讀** 可切換為全版閱讀模式，按 **←** 回到明細，再按一次回清單，保留篩選與捲動位置。說明中的外部連結以系統瀏覽器開啟，面板不執行作者內嵌的 HTML 或腳本。

有完整說明頁的資源包會顯示 **🌐**。按下後外掛會取得並驗證推薦版本的封裝、取出說明頁，再以系統瀏覽器開啟本機 HTML；準備時顯示「準備中…」，失敗會顯示原因。

## 一鍵安裝、更新、補裝與解除安裝

在卡片或明細的狀態列直接操作，不需選範圍或勾選根目錄：

| 按鈕 | 行為 |
|---|---|
| 安裝 | 將推薦版本裝到所有偵測到的相容 AI 工具全域根目錄 |
| 更新 | 更新已部署且版本較舊的位置；若同時有待補裝目標，也一併補齊 |
| 補裝 | 只有新增相容位置時，以目前已安裝版本補齊待補裝目標 |
| 解除安裝 | 紅色按鈕；一律先確認，從所有平台、所有全域位置移除 |

開啟「顯示 Preview 版本」會將可見的 Preview 版本納入推薦版本判斷。一般操作按下即套用，**只有缺少必要設定參數、資源包宣告設定命令，或有位置受阻時，才顯示精簡確認畫面**。已填過的全域參數（包括在其他用戶端填的）會直接沿用；設定命令會列出用途與內容，確認後才在你的電腦執行。有受阻位置時會說明原因，其餘可部署位置仍可繼續；全部受阻時只顯示原因。

可自動處理的同名內容或本機修改會先備份再套用。技能資料夾備份到共用資料目錄下的 `backups`，其他檔案備份在原位置旁（`.bak-lcaipack-<時間>`）。其他資源包擁有的內容、無法備份或無法安全修改的設定會受阻。套用前若本機狀態改變，外掛會自動重新規劃。

完成後會顯示成功的位置數並更新狀態。有失敗時，點開紅色「N 個位置失敗」查看工具、根目錄、原因與可展開的備份位置，按「重試失敗項目」只重試失敗的位置，遵守相同的例外確認規則。

要改設定，在明細展開「設定參數」，修改後按「儲存並重新套用」，以新值重新部署到已部署的位置。秘密只顯示是否已設定，留空表示不變；需要時同樣顯示例外確認。

解除安裝會先顯示將移除的位置，確認後才執行。安裝後你修改過的內容會先備份，根目錄已不存在時只清除紀錄。Windows 上移除 Claude Code 主根的 MCP 時，也會清理 Orca 帳號中與原設定相同的殘留項目。請重開 Orca 工作階段以套用 MCP 異動。設定參數與秘密會保留，重新安裝可直接沿用。

可部署的內容與位置如下；外掛不會替未偵測到的工具建立設定：

| AI 工具 | 內容類型 | 範圍 |
|---|---|---|
| Codex（CLI 與 Desktop 共用設定根） | Skill、Agent、Prompt／Command、MCP | 使用者全域 |
| Claude Code | Skill、Agent、Prompt／Command、MCP | 使用者全域 |
| Claude Desktop | 只有 MCP；資源包含 MCP 時才列入 | 使用者全域 |

安裝與維護以 AI 工具為單位。Codex 全域技能共用 `~/.agents/skills`，Agent、Prompt／Command 與 MCP 仍各設定根一份。Codex CLI 最低需 0.95.0 才能載入共用技能。新增根缺少各根所需的內容時會顯示「待補裝目標」，單靠共用技能即可使用的根會自動涵蓋。要排除個別根目錄，可在共用資料目錄的 `config.json` 設定 `excludedClientRoots`。

需要執行期秘密的 MCP 在所有平台都由外掛自帶的獨立 Node launcher 啟動，需要系統安裝 Node.js；缺少時提示「需要 Node.js 才能啟動此 MCP」。Host 設定使用 `command: "node"`，args 第一個是 launcher 腳本的絕對路徑，後接 `mcp-launch` 與非秘密身分。SSH、WSL 與 UNC 網路路徑不支援。

### Ubuntu

支援 Ubuntu 22.04／24.04 桌面版的 Codex 與 Claude Code。Ubuntu 以外的 Linux 發行版及 linux-arm64 尚未實機驗證；Claude Desktop 不支援 Linux。此為 Orca 外掛依 ADR-0005 提供的支援，共用同一份部署資料的其他用戶端目前不支援 Linux。

秘密參數使用 Secret Service（`secret-tool`，service `com.linkchain.lcaipack`），不退回明文。請先執行 `sudo apt install libsecret-tools` 並解鎖 GNOME 鑰匙圈。登入前若 Orca 回報鑰匙圈不可用，請安裝並解鎖後重新開啟 Orca。

launcher 內容有變才原子更新：Windows `%LOCALAPPDATA%\orca-ai-resource-center\bin\lcaipack-mcp-launch.mjs`（未設定時用 `<home>\AppData\Local`）、macOS `~/Library/Application Support/orca-ai-resource-center/bin/lcaipack-mcp-launch.mjs`、Linux `~/.local/share/orca-ai-resource-center/bin/lcaipack-mcp-launch.mjs`。外掛不依賴其他用戶端的執行檔。

Linux 優先使用作者宣告的 Linux 設定命令；沒有時沿用架構相符的 macOS bash 命令。此命令是為 macOS 撰寫，將在 Linux 以 bash 執行；若腳本使用 macOS 專屬指令，執行可能失敗，可查看原因後重試。PowerShell 命令在 Linux 受阻。

選擇資料夾依序使用 `zenity`、`kdialog`；都未安裝時可直接貼上資料夾路徑。

Ubuntu 桌面版實機驗收：

- 確認登入前可辨識鑰匙圈不可用，解鎖後可登入並在重開 Orca 後續用工作階段。
- 安裝需要秘密的 MCP，確認秘密存入鑰匙圈，Host 設定只有 launcher 路徑與身分，MCP 可啟動。
- 確認自帶 launcher 可用；缺 Node.js 時顯示受阻原因。
- 安裝含 macOS bash 設定命令的資源包，確認顯示借用警示、執行成功或失敗後可重試；PowerShell 受阻。
- 確認 zenity／kdialog 的選取與取消；兩者都未安裝時仍可貼路徑。確認不列出 Claude Desktop。

## 新版提醒

外掛預設每 **15 分鐘**檢查已安裝資源包的新版。可在 ⚙ 的「檢查更新」改為 1 小時、4 小時、1 天或關閉；關閉後仍可在開啟面板或按 ↻ 時同步，切回面板也會重新整理安裝狀態。

同一個資源包的同一個新版本只發一次 Orca 通知，同一輪發現多個新版會合併通知；忽略通知不會反覆提醒，直到出現更新的版本。待補裝目標不發新版通知。清單上方的「N 個資源包可更新」可直接切換到可更新篩選，尚未更新的卡片會持續顯示提示。**外掛只提醒，不會自動更新資源包。**

## 隱私與資料

- **市集連線**：登入、目錄、封裝取得與安裝回報送往你輸入的市集；憑證只送給登入時的市集來源，不跟隨轉址。沒有其他遙測或第三方請求。
- **密碼與秘密**：登入密碼不儲存；工作階段存放在 Orca 的加密秘密儲存。資源包秘密參數存入 Windows Credential Manager、macOS Keychain 或 Ubuntu Secret Service，不寫入設定檔、部署收據、面板結果或日誌。
- **本機寫入**：一鍵操作會寫入偵測到的相容全域部署位置及共用資料目錄，不寫入專案範圍。設定命令只在確認後執行，不提權，以參數陣列啟動。
- **安裝回報**：至少一個位置成功後，向市集回報資源包識別、版本、動作、成功的 AI 工具種類、範圍、外掛版本與時間，用於安裝次數統計；不含路徑、本機帳戶或憑證。送出失敗暫存於外掛儲存，下次同市集、同帳號連線時補送，30 天後丟棄。

### 設定與共用資料

| 項目 | 存放位置與用途 |
|---|---|
| 市集網址 | Orca 設定 `marketUrl`，登入成功後才儲存 |
| 登入工作階段 | 外掛秘密儲存，綁定登入時的市集網址 |
| 排序、Preview 與檢查頻率 | 外掛自己的儲存區 |
| 已通知版本與待送安裝回報 | 外掛自己的儲存區，不寫入共用資料 |
| 全域部署收據 | `LCAIPACK_HOME`（預設 `~/.lcaipack`）下的 `receipts.json` |
| 全域一般設定參數 | 同資料目錄的 `setup.json` |
| 秘密參數 | Windows Credential Manager／macOS Keychain／Ubuntu Secret Service（service `com.linkchain.lcaipack`） |
| 部署鎖定、操作與設定命令紀錄 | 同共用資料目錄的 `locks/`、`operations/` 與 `setup-commands.json` |

兩個用戶端可辨識同一份全域部署，請依序操作。開啟資源中心時，既有受管 Codex 技能會自動遷移。收據寫入採用格式 2，請同步更新 Orca 外掛與其他共用同一份部署資料的用戶端。

### 移除外掛後留下的資料

移除 Orca 外掛不會移除已部署資源、共用收據、設定參數或秘密。要完整清除，請刪除對應資源檔案與收據；在 Windows「認證管理員」移除名稱以 `lcaipack:setup:` 開頭的項目，或在 macOS「鑰匙圈存取」移除 service 為 `com.linkchain.lcaipack` 的項目。

## 疑難排解

登入失敗時，依「網址錯誤」「無法連線」「帳號或密碼錯誤」修正後重試。讀取目錄或資源包時顯示「沒有權限」不會登出；確認帳號是否有市集讀取權限。目錄或明細讀取失敗，可按「重新讀取目錄」或「重新讀取詳情」。

找不到已裝資源時，先確認是否只裝在專案範圍；Orca 只讀取全域部署。若是在其他用戶端剛完成全域安裝，按 ↻ 重新整理。

## 第三方授權

外掛隨附 smol-toml（Squirrel Chat 維護的 TOML 解析器，單檔打包於 `worker/vendor/smol-toml/index.cjs`），授權為 BSD-3-Clause，版權聲明與完整授權文字見 `worker/vendor/smol-toml/LICENSE`。其餘部分沒有執行期相依套件，也沒有建置步驟。

## 發布前檢查（維護者）

`test/release-hygiene.test.mjs` 會掃描整個外掛資料夾（程式碼、測試、測試資料、README、manifest）：

- 沒有內部位址：所有 URL 主機必須是 `localhost`、`127.0.0.1`、`*.example`／`*.invalid` 或少數公開參考網址；沒有私有 IP 網段、內部網域尾碼與組織網域。
- 沒有本機資訊：沒有使用者家目錄、開發機專案路徑，也不得出現執行測試這台機器的使用者名稱、家目錄名稱或電腦名稱。
- 沒有真實帳號與憑證：測試後端的繞過登入帳號與密碼（含測試使用者名稱）一律不得出現在整個資料夾，包括測試；測試只使用 `alice`、`example.invalid` 這類合成資料。也檢查 JWT、refresh token、私密金鑰與常見平台 token。
- 第三方授權與版本：隨附的 smol-toml 授權完整；`orca-plugin.json` 是唯一版本來源，收據與安裝回報的 `clientVersion` 由它而來，Catalog 條目與它相同。Windows 與 macOS 使用同一份外掛與同一個版本號。
- 唯一允許出現的組織名稱是 Keychain service `com.linkchain.lcaipack`：這是與其他用戶端共用秘密項目的協定常數，不是位址或帳號。

發布流程沿用本儲存庫慣例：先提交外掛，再執行 `node scripts/generate_catalog.mjs`，最後以獨立的 `chore: 更新 Catalog` 提交更新 `orca-catalog.json`。

## 測試

在 `plugins/ai-resource-center` 執行：

```bash
node --test test/zh-tw-wording.test.mjs test/manifest.test.mjs test/release-hygiene.test.mjs
node --test test/*.test.mjs
```
