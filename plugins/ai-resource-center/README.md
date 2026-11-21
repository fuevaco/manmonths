# AI 資源中心（manmonths.ai-resource-center）

在 Orca 右側欄的「資源中心」連到你有權使用的資源市集，在 Orca 內獨立登入、搜尋資源包、查看版本與說明，下載指定版本 ZIP，並把 Skill、Agent、Prompt、Command 與 MCP 安裝到支援的 AI 工具；資源包宣告的設定參數在部署摘要中補齊，與桌面工具共用同一份設定。部署收據與 LC-AI-Pack 桌面工具共用，兩邊都能辨識同一份部署。

## 需求

- Orca 1.4.259 以上（外掛在 Orca 的外掛主機執行，不需另外安裝 Node.js）。
- Windows 或 macOS，以及你要部署資源的 AI 工具：Codex、Claude Code，或 Claude Desktop（只支援 MCP）。工具本身不必由外掛安裝。
- 一個你有權使用的資源市集網址與帳號。外掛沒有預設網址，也不會連到任何預設主機。
- 不需要安裝 LC-AI-Pack 桌面工具；如果已經安裝，兩邊會共用部署收據與設定參數（見「設定與資料」）。

## 安裝

1. 開啟 Orca，前往「Settings」→「Plugins」→「Marketplace Sources」，按「Add Source」新增來源：`https://github.com/fuevaco/manmonths.git`，Ref 填 `main`。
2. 在外掛清單選擇「AI 資源中心」按「Install」。Orca 會列出外掛要求的權限（讀寫外掛自己的設定、加密儲存秘密、外掛自己的儲存資料夾），確認後安裝。外掛在獨立的 Node.js 行程中以你的使用者身分執行，只會連到你輸入的市集網址。
3. 安裝完成後，右側欄會出現「資源中心」。
4. 本機開發則在「Settings」→「Plugins」→「Local Development」指向 `plugins/ai-resource-center`。

## 第一次連線

1. 開啟右側欄的「資源中心」，在「連線到資源市集」輸入市集網址（例如 `https://market.example.com`；本機測試可用 `http://localhost:5125`）、帳號與密碼，按「登入」。
2. 登入成功後才儲存網址與工作階段；密碼不會被儲存。之後重開 Orca 會續用工作階段，失效時面板會提示重新登入。
3. 登入失敗時面板會區分「網址錯誤」「無法連線」「帳號或密碼錯誤」，修正後直接重試。登入成功就保留工作階段，不會另外探測權限；若帳號沒有讀取市集的權限，要等到載入目錄時才會顯示「沒有權限」，此時仍維持登入。
4. 要換另一個市集，先按「登出」再輸入新網址；舊網址的工作階段不會沿用，也會嘗試撤銷。

## 功能總覽

- **瀏覽**：依名稱、識別碼或說明搜尋，依資源類型（Skills、Agents、MCP、組合包）與安裝狀態篩選；可選擇是否顯示 Preview 版本。
- **詳情**：每個資源包的版本、相容的 AI 工具、更新紀錄與使用說明（純文字顯示）。
- **下載**：把所選版本的 ZIP 存到 `Downloads` 資料夾或你指定的路徑；先比對 SHA-256 並檢查封裝內容，驗證失敗不會留下檔案。
- **安裝與部署**：選擇範圍（使用者全域或本機專案）與一個或多個部署目標，先產生「部署摘要」，檢視每個目標的變更與受阻原因，確認一次後才寫入。需要設定參數或設定命令的資源包，會在同一份摘要補齊。
- **更新**：清單與詳情標示各部署目標的已安裝版本與可更新版本；選定目標按「更新所選目標」，同樣先看摘要再確認一次。
- **衝突處理**：本機已有的同名內容會先備份（`.bak-lcaipack-<時間>`）再套用；不能安全處理的目標會受阻並說明原因，不會動到其他已成功的目標。
- **側欄寬度**：面板從約 220 px 的窄側欄到寬側欄都可操作，長路徑自動換行。

可部署的內容與位置（位置由偵測到的設定根目錄決定，不會替未偵測到的工具建立設定）：

| AI 工具 | 內容類型 | 範圍 |
|---|---|---|
| Codex（CLI 與 Desktop 共用同一個設定根） | Skill、Agent、Prompt／Command、MCP | 使用者全域、專案 |
| Claude Code | Skill、Agent、Prompt／Command、MCP | 使用者全域、專案 |
| Claude Desktop | 只有 MCP | 僅使用者全域 |

需要在執行期取得秘密的 MCP 目前不能部署（Orca 沒有受管 launcher），摘要會明確標示受阻，不會靜默略過。SSH、WSL 與 UNC 網路路徑不支援。

## 隱私與資料

- **只連到你輸入的市集**：登入、目錄、下載與安裝回報都送往該網址；憑證只送給登入當時的市集來源，對其他來源的請求會被拒絕，也不會跟隨轉址。沒有其他遙測或第三方請求。
- **密碼不儲存**：只用於登入；工作階段憑證存放在 Orca 為外掛提供的加密秘密儲存。面板、日誌與結果都不顯示 token、密碼或秘密參數值。
- **秘密參數**：資源包要求的秘密（例如 API Key）寫入 Windows Credential Manager 或 macOS Keychain，不寫入設定檔或部署收據。
- **安裝回報**：成功安裝或更新後，會向市集回報資源包識別、版本、動作（安裝或更新）、成功的 AI 工具種類、範圍、外掛版本與時間，供市集統計安裝次數；內容不含檔案路徑、本機帳戶名稱或憑證。送出失敗時暫存在外掛儲存，下次連線補送，30 天後丟棄。
- **本機寫入範圍**：只寫入你確認過的部署目標、共用資料目錄（`LCAIPACK_HOME`，預設 `~/.lcaipack`）與專案內的 `.lcaipack/`。確認前不執行任何命令、不建立任何目錄。
- **設定命令**：只有資源包明確宣告、且出現在你確認的摘要中的命令才會執行，不提權，不經 shell。

### 解除安裝後留下的資料

解除安裝外掛不會移除已部署的資源、`LCAIPACK_HOME` 下的收據與設定參數，也不會刪除秘密參數。要完整清除：刪除對應的資源檔案與收據；在 Windows 的「認證管理員」移除名稱以 `lcaipack:setup:` 開頭的項目，在 macOS 的「鑰匙圈存取」移除 service 為 `com.linkchain.lcaipack` 的項目。

## 第三方授權

外掛隨附 smol-toml（Squirrel Chat 維護的 TOML 解析器，單檔打包於 `worker/vendor/smol-toml/index.cjs`），授權為 BSD-3-Clause，版權聲明與完整授權文字見 `worker/vendor/smol-toml/LICENSE`。其餘部分沒有執行期相依套件，也沒有建置步驟。

## 發布前檢查（維護者）

`test/release-hygiene.test.mjs` 會掃描整個外掛資料夾（程式碼、測試、測試資料、README、manifest）：

- 沒有內部位址：所有 URL 主機必須是 `localhost`、`127.0.0.1`、`*.example`／`*.invalid` 或少數公開參考網址；沒有私有 IP 網段、內部網域尾碼與組織網域。
- 沒有本機資訊：沒有使用者家目錄、開發機專案路徑，也不得出現執行測試這台機器的使用者名稱、家目錄名稱或電腦名稱。
- 沒有真實帳號與憑證：測試後端的繞過登入帳號與密碼（含測試使用者名稱）一律不得出現在整個資料夾，包括測試；測試只使用 `alice`、`example.invalid` 這類合成資料。也檢查 JWT、refresh token、私密金鑰與常見平台 token。
- 第三方授權與版本：隨附的 smol-toml 授權完整；`orca-plugin.json` 是唯一版本來源，收據與安裝回報的 `clientVersion` 由它而來，Catalog 條目與它相同。Windows 與 macOS 使用同一份外掛與同一個版本號。
- 唯一允許出現的組織名稱是 Keychain service `com.linkchain.lcaipack`：這是與 LC-AI-Pack 桌面工具共用秘密項目的協定常數，不是位址或帳號。

發布流程沿用本儲存庫慣例：先提交外掛，再執行 `node scripts/generate_catalog.mjs`，最後以獨立的 `chore: 更新 Catalog` 提交更新 `orca-catalog.json`。

## 操作細節

1. 開啟右側欄的「資源中心」。
2. 輸入市集網址（首次使用時是空的，外掛沒有預設網址）、帳號與密碼，按「登入」。
3. 之後重開 Orca 會續用工作階段；工作階段失效時面板會提示重新登入。
4. 按「登出」只會清除 Orca 的工作階段，不影響 LC-AI-Pack 桌面工具的登入。
5. 在「全部資源包」輸入關鍵字並按「搜尋」，可同時選擇資源類型。搜尋比對名稱、識別碼與說明；「清除篩選」恢復全部類型與空白關鍵字。
6. 「顯示 Preview 版本」會包含市集允許的 Preview 資源；摘要優先顯示正式版，只有 Preview 時依開關顯示版本。重新整理會重新請求目錄，讀取失敗可按「重新讀取目錄」。
7. 按資源包的「查看詳情」查看可見版本、相容 AI 工具、更新紀錄與使用說明。預設選取市集推薦的可見版本；可用下拉清單切換版本。說明以純文字呈現。
8. 按「下載 ZIP」會將所選版本存入使用者的 `Downloads` 資料夾，也可填寫完整 ZIP 儲存路徑。相同路徑的檔案只在新下載完成驗證後替換；畫面顯示最終儲存位置。失敗後可直接再按下載重試。
9. 在詳情的「安裝到 AI 工具」先選範圍：使用者全域可勾選多個 Codex 或 Claude Code 設定根目錄；本機專案則輸入存在的專案資料夾完整路徑，按「讀取專案目標」。選項依所選版本 ZIP 的內容類型與載入面能力篩選。每個目標都顯示完整路徑，預設只勾選清單第一個。按「產生部署摘要」後查看版本、各部署目標、受阻原因與可展開的變更明細；按一次「確認安裝」套用這份摘要中的目標集合。改動範圍、路徑或勾選後須重新產生摘要。
10. 若確認前本機狀態已改變（例如目的地被其他程式寫入），外掛不套用舊計畫，而是顯示依目前狀態重新產生的摘要，請重新確認。寫入失敗時會還原該目標並顯示原因，不留下指向新版的部署收據。
    結果有目標失敗（寫入失敗、已還原、未完整還原）時，除了「完成」還有「只重試失敗的目標」（對照 LC-AI-Pack「只重試失敗平台」）：只勾選失敗的目標並重新產生部署摘要，需再確認一次才套用；已成功的目標與收據不變，重試成功才為新增成功的目標送出安裝回報。全部成功或全部受阻時不顯示。
11. 清單與詳情顯示各部署目標的「已安裝資源版本」，可選「已安裝／可更新」篩選。提示不會自動安裝；在詳情選定目標後按「更新所選目標」，再確認摘要。摘要列出該位置的舊版 → 新版，以及其他位置維持的版本。完成後重新讀取收據。
12. 面板分開標示 Orca 外掛用戶端版本（取自 manifest）、LC-AI-Pack 的「共用收據最後部署的用戶端版本」（installedAt 最新一筆收據的 `clientVersion`，排除與目前 Orca 外掛版本相同者；收據無法分辨寫入者，所以只能排除目前版本，舊版 Orca 外掛寫的收據可能被誤認，這是共用收據的限制）與 GUI 的「市集最新發行版」。LC-AI-Pack 為可攜程式，尚無共用本機程式位置可供偵測，因此這兩個數字都不等於已安裝的 LC-AI-Pack 程式版本；收據讀不到或沒有符合的紀錄時顯示「未偵測」。

下載先比對市集詳情與下載標頭提供的 SHA-256，再檢查 ZIP／ZIP64 完整性、canonical manifest、封裝路徑、符號連結與禁止檔案。驗證失敗不產生下載檔案，也不影響既有檔案。單獨下載不寫入部署目標、設定參數或部署收據。下載與驗證在 worker 記憶體中處理，因此有大小上限：下載 100 MB（同市集 `Market:MaxPackageSizeMB`），封裝最多 5000 個項目、單一檔案解壓後 100 MB、全部解壓後 500 MB；先以宣告大小判斷，解壓時再限制輸出長度，超過即拒絕（LC-AI-Pack 只限制壓縮後大小，解壓上限是資源中心額外加上的防護）。

連線或登入失敗時，面板會分別說明「網址錯誤」「無法連線」「帳號或密碼錯誤」等原因，修正後可直接重試；讀取目錄或資源包時回應 403 會顯示「沒有權限」，不會登出。

## 設定與資料

| 項目 | 存放位置 | 說明 |
|---|---|---|
| 市集網址 | Orca 設定（`marketUrl`） | 預設空白；登入成功後才儲存 |
| 登入工作階段 | 外掛秘密儲存（`orca.secrets`） | 綁定登入當時的市集網址；改用其他網址時不沿用並撤銷舊工作階段 |
| 部署收據 | 全域為 `LCAIPACK_HOME`（未設定時 `~/.lcaipack`）下的 `receipts.json`；專案為 `<專案>/.lcaipack/receipts.json` | 與 LC-AI-Pack 共用格式（`receiptFormatVersion` 1），每個正規化根目錄各自識別，寫入時原子替換；`clientVersion` 記錄 Orca 外掛版本 |
| 部署目標鎖定 | 同上資料目錄的 `locks/` | 與 LC-AI-Pack 相同的鎖定檔位置；跨用戶端共用寫入鎖留待後續版本 |
| 設定參數（一般值） | 全域為資料目錄下的 `setup.json`；專案覆寫為 `<專案>/.lcaipack/setup.json` | 與 LC-AI-Pack 共用格式（`setupFormatVersion` 1）；專案覆寫優先，未覆寫的參數回落到全域，再回落到資源包預設值 |
| 秘密參數 | Windows Credential Manager（Generic credential）／macOS Keychain（service `com.linkchain.lcaipack`） | 識別沿用 LC-AI-Pack：`lcaipack:setup:<package>:<參數>:<scope>:<根目錄雜湊>`；值只經子行程 stdin 傳遞，不寫入 `setup.json`、面板結果、日誌或部署收據 |
| Skill | 全域為 Codex 設定根的 `skills/<內容 id>`（設定根就是家目錄時為 `~/.agents/skills/<內容 id>`）；專案為 `<專案>/.agents/skills/<內容 id>` | 路徑規則沿用 LC-AI-Pack Host Profile（`codex/2026.10.1`） |

面板結果與日誌不會出現 token、refresh token、密碼或秘密參數值。

部署摘要會列出資源包的設定參數與來源；缺少必要值時摘要受阻並標示需要補上的項目，秘密以遮罩欄位輸入、只回報是否已儲存。按「儲存設定並重新產生摘要」後，一般值依安裝範圍寫入全域或專案覆寫，秘密寫入作業系統安全儲存區，再重新規劃。需要執行期秘密的 MCP 在 LC-AI-Pack 由受管 launcher 啟動；Orca 尚未提供 launcher，這類 MCP 目前以受阻問題揭露。

### 設定命令（setup.commands）

資源包宣告設定命令時，部署摘要的「設定命令」區列出每一項的名稱（作用）、runner、腳本、已插值的非秘密參數、逾時，以及本次執行或略過的理由（首次執行、上次未成功重試、腳本改變、同版已成功略過、更新是否宣告 `runOnUpdate`…）。規則與判斷來自 LC-AI-Pack：只在 Windows 執行 `powershell`（優先 PowerShell 7，否則 Windows PowerShell 5.1）、只在 macOS 執行 `bash`；宣告給其他作業系統或架構的命令只要有手足命令適用本機就不產生問題，整包都不適用才阻擋；找不到 runner 也阻擋。**確認前不執行任何命令、不建立任何目錄或狀態。**

使用者確認一次後，外掛依宣告順序先執行命令，全部成功才逐目標部署；部署依的是同一份已確認的計畫，審核後設定值、秘密有無、腳本內容或本機狀態改變一律判定過期（零命令、零寫入）。命令只以 argv 陣列啟動（不經 shell、不接受完整命令字串、不提權），working directory 是 `<setup root>/runtime`，腳本由 `payload/` 重建；環境變數只有 `LCAIPACK_SETUP_ROOT／PAYLOAD_ROOT／RUNTIME_ROOT／PACKAGE_KEY／PACKAGE_VERSION／SCOPE／PROJECT_ROOT／OPERATION_ID`。setup-time 秘密只經子行程 stdin 的框架（`LCAIPACK-SECRET-BEGIN 1` … `LCAIPACK-SECRET-END`，每行 `<參數> <base64>`，沒有秘密也會輸出空框架）交付。exit code 0 是唯一成功判定；逾時（1–120 分鐘，預設 30）或取消會終止整棵子行程樹。

命令失敗、逾時或取消時，依賴它的部署目標完全不被改動、不寫入新版收據；結果逐一列出「未部署」的目標、原因（命令名稱與 exit code）與已遮罩的輸出尾端，operation 保留為可繼續。修正條件後重新產生摘要，上次未成功的命令會重新執行。執行中可在面板按「取消設定命令」（`rc.deploy.cancel`）。

操作與命令狀態與 LC-AI-Pack 共用：`<資料目錄>/operations/<op-id>.json` 與同名 `.log`（每個操作單一 UTF-8 log，重試追加 session；子行程輸出經串流遮罩，已註冊的秘密與其 base64、`token=`／`password=` 等樣式一律取代為 `<redacted>`）、完成狀態 `<資料目錄>/setup-commands.json`（專案為 `<專案>/.lcaipack/setup-commands.json`）。兩邊互相讀得到對方的紀錄，兩邊對同一份計畫算出的設定摘要逐位元組相同。

全域偵測唯讀掃描家目錄第一層的 `.codex*`，合併 `CODEX_HOME` 及 LC-AI-Pack `config.json` 中的 `manualClientRoots.codex`／`excludedClientRoots.codex`。候選必須存在且直接含 `config.toml` 或 `auth.json` 檔案；不遞迴、不建立缺失根、不列出 `.bak-lcaipack-` 備份。依正規化路徑去重，環境指定來源優先於手動重複增列，排除清單最後生效。主根優先，其餘依顯示路徑排序。專案不需已偵測到全域 Codex 根；僅接受存在的本機絕對路徑，不接受 UNC 分享路徑。

Claude Code 全域偵測掃描家目錄第一層的 `.claude*`，合併 `CLAUDE_CONFIG_DIR` 與 `manualClientRoots["claude-code"]`／`excludedClientRoots["claude-code"]`。候選第一層須有 `settings.json` 或 `.claude.json`，沿用相同的去重、排除與備份規則，不查詢 CLI 執行檔。Skill、Agent 與 Prompt／Command 分別落在設定根的 `skills/<id>`、`agents/<id>.md` 與 `commands/<id>.md`；專案則在 `.claude/` 下。Codex Agent 寫入 `agents/<id>.toml`，Prompt／Command 寫入 `prompts/<id>.md`，專案則在 `.codex/` 下。Agent 的 native name 由內容 id 決定，行為剝除 frontmatter；Codex 不落地 tools，摘要會揭露忽略欄位。MCP 部署由後續工項加入。

MCP 依 Host Profile 寫入共用設定：Codex 的全域 `<設定根>/config.toml`／專案 `.codex/config.toml`；Claude Code 的專案 `.mcp.json`，全域預設 profile 使用 `~/.claude.json`，`CLAUDE_CONFIG_DIR` 與其他 profile 則使用 `<設定根>/.claude.json`。Codex Desktop 與 CLI 共用相同根與 `codex-cli` 收據身分，不建立重複部署。Claude Desktop 只提供全域 MCP；組合包的其他內容會在摘要揭露並略過。

Claude Desktop 在 Windows 依 `LOCALAPPDATA/Packages/Claude_*`、WindowsApps 安裝時間、有效 MSIX log 與目錄存在性裁決；拒絕 `Claude-3p`，並揭露過期 log、時間來源退化與路徑矛盾。macOS 只偵測 `~/Library/Application Support/Claude/claude_desktop_config.json` 這個既有檔案。偵測全程唯讀，不為未偵測到的工具建立設定。

MCP JSON 保留無關節點與欄位值；TOML 只替換受管 table，保留其他區段的註解、空白與換行，以及 Codex `tools` 核准子表。依 LC-AI-Pack 實際行為，寫入 JSON 會重新縮排、寫入 TOML 會去除 UTF-8 BOM。收據記錄節點與直接欄位的雜湊及所有權；其他 MCP 節點變動不會讓計畫過期。受管節點本機修改與未受管同名節點會自動備份設定檔後套用（見下方「自動處理衝突」）；其他包所有權、三方欄位衝突與無法安全解析／寫入的設定都會在摘要揭露並阻擋。MCP 明細可展開查看受管欄位與遮罩後的變更。

### 自動處理衝突（ADR 0002）

安裝與更新使用「備份後覆蓋」與「允許全域／專案並存」的規劃政策，使用者在摘要確認整次操作即可，不需額外勾選。可自動處理：同一資源包被本機修改的受管 Skill／檔案／MCP 欄位，以及目標位置已有的未受管同名內容，都先複製為 `<原名>.bak-lcaipack-<yyyyMMddHHmmss>`（命名、永不覆蓋既有備份與撞名時推秒規則同 LC-AI-Pack `ToolBackupNaming`）再套用；備份位置顯示在結果。不可自動處理、該部署目標受阻：目的地或內容已由其他資源包擁有、同次安裝內容彼此衝突、設定檔無法安全解析或寫入。備份或寫入失敗時整個目標還原（還原未完成時列出需人工處理的位置），不寫入指向新版的收據。

全域與專案同時管理同一內容時（全域規劃也會檢查共用專案清單 `registeredProjects`），變更明細的「載入優先順序」列出兩處位置與版本。優先順序依官方文件：Claude Code 的 Skill 為全域優先於專案，Agent 與 MCP 為專案優先於全域；Codex 的 Skill 兩份都載入、不合併，MCP 以專案設定優先（僅信任的專案）；文件未明訂的組合如實標示。

### 多個部署目標的部分成功（ADR 0002）

選擇多個部署目標時，摘要同時列出可安裝與受阻的目標：`deployableCount`、`blockedCount`，以及各受阻目標的具體原因（他包擁有、設定檔無法安全變更等）。至少有一個可安裝的目標、且沒有計畫層級的阻擋（資源包格式、設定參數與設定命令的前置條件）時可確認；確認一次後只套用可安裝的目標，每個目標各是一個獨立交易（一個失敗不影響其他已成功的目標，失敗者還原原狀態並回報備份位置），受阻的目標不被觸碰，結果以 `skipped` 列出原因。結果狀態：全部成功 `succeeded`、部分成功或有受阻 `partial`、全部失敗 `failed`。所有目標都受阻時摘要只列出各自的原因，不提供確認，強行套用也回 `rejected` 且零寫入。這是與 LC-AI-Pack 的差異（LC-AI-Pack 任何目標受阻即整份不可套用），其餘逐目標交易語意沿用 `TargetApplyExecutor`。

設定命令（工項 10）屬於整個資源包：命令失敗時，所有依賴它的可安裝目標都標為 `notDeployed`（原因為命令失敗），原本就受阻的目標維持 `skipped` 與自己的衝突原因，兩者不混為一談。

一份計畫只有一個範圍與一個專案：自動列出的專案目標來自多個專案時，混選會被拒絕（面板勾選另一個專案時自動取消其他專案的勾選）。所選目標有不同的可更新版本時，面板依版本分批更新，每批各確認一次，完成後自動選取其餘目標。

### 專案範圍的既有部署

專案安裝成功（或部分成功）後，專案根會註冊到共用 `config.json` 的 `registeredProjects`（同 LC-AI-Pack `RegisterProject`：完整路徑、不分大小寫去重、保留其他欄位；沒有檔案時只建立專案清單）。因此 `rc.deploy.listTargets` 帶 `{ scope: 'project', packageKey }` 而不指定路徑時，會自動列出已有該資源部署且資料夾仍存在的專案目標，目標帶 `projectRoot`。

### 安裝回報

安裝或更新至少一個部署目標成功後，依 LC-AI-Pack 的 `InstallReportBuilder`／`InstallReportOutbox` 規則向市集送出 `POST api/market/packages/{key}/versions/{version}/installs`：body 只含 `operationId`、`action`（Apply 前同一資源已有其他市集版本收據為 `update`，並帶最高的 `fromVersion`，否則 `install`）、成功的 `platforms`（host／surface，去重；失敗、已還原與受阻的目標不計）、`scope`、`channel`、`clientProduct`（`gui`，市集只接受 gui 或 cli）、`clientVersion`（外掛版本）與 `installedAt`（UTC）。不含任何路徑、秘密、憑證或本機帳戶。回報先持久儲存在外掛儲存（`install-reports.v1`；LC-AI-Pack 存成檔案，兩邊各自儲存、互不讀寫），再以最佳努力送出，不延遲也不改變安裝結果。送出失敗（網路、5xx、401）時保留，下次成功連線（讀取連線狀態成功或登入）時補送；永久 4xx 丟棄並記錄一行；超過 30 天淘汰；項目記錄產生回報的市集網址與登入帳號，只用同一個市集、同一帳號補送（換到另一個市集時保留，不會送過去）。同一 operation 只聯集合併平台。本機來源與沒有成功目標時不回報。

需要的能力：`settings:own`、`secrets:own`、`storage:own`。

## 面板 ↔ worker 請求契約

方法名稱為 `rc.<領域>.<動作>`，錯誤為帶 `code` 與繁體中文 `message` 的 Error（代碼見 `worker/contract.mjs`）。

| 方法 | 輸入 | 結果 |
|---|---|---|
| `rc.session.getState` | — | `{ marketUrl, signedIn, account?, notice? }` |
| `rc.session.signIn` | `{ marketUrl, username, password }` | 同上 |
| `rc.session.signOut` | — | `{ marketUrl, signedIn: false }` |
| `rc.catalog.list` | `{ search?: string, type?: '' 或 skill/agent/mcp/bundle, category?: string, previewMode?: boolean }` | `{ data: [{ packageKey, name, type, description, category, latestVisibleVersion: string 或 null, installCount, downloadCount }] }` |
| `rc.package.getDetails` | `{ packageKey: string, version?: string, previewMode?: boolean }` | `{ packageKey, name, type, description, selectedVersion, readme, versions: [{ version, channel, hosts, changelog, sha256, hasFullGuide }] }` |
| `rc.download.save` | `{ packageKey: string, version: string, previewMode?: boolean, destinationFile?: string }` | `{ filePath, sha256, fileSize }` |
| `rc.deploy.listTargets` | `{ packageKey?: string, version?: string, previewMode?: boolean, scope?: 'global' 或 'project', projectRoot?: string }`（省略範圍為全域；專案指定路徑，或帶 packageKey 而不指定路徑時自動列出已有部署的專案；帶版本時須帶 packageKey，並驗證 ZIP 以篩選能力） | `{ targets: [{ id, hostId, surfaceId, scope, label, rootPath, canonicalRoot, isPrimary, origin }] }` |
| `rc.deploy.plan` | `{ packageKey, version, action?: 'install'（預設）／'update'／'reinstall'／'reconfigure'／'repair', previewMode?, scope?, projectRoot?, targets: [id, ...] }`（至少一個、不重複，同一範圍與同一專案；`action` 決定設定命令的判斷意圖） | `{ planDigest, canApply, deployableCount, blockedCount, package: { packageKey, name, version, channel }, targets: [{ id, label, rootPath, canApply, changes: [{ contentId, kind, change, changeLabel, destinationPath, willBackup }], problems }], problems, setup: { scope, setupRoot, parameters, commands: [{ commandId, name, runner, script, arguments, operatingSystems, architectures, timeoutMinutes, runOnUpdate, eligibility, willExecute, reason }], executableCommandIds } }` |
| `rc.deploy.apply` | `{ planDigest, targets: [id] }` | `{ status: succeeded/partial/failed/cancelled/rejected, targets: [{ id, label, status（succeeded／failed／rolledBack／rollbackIncomplete／stale；受阻為 skipped，命令未成功時為 notDeployed）, writtenPaths, removedPaths, backupPaths, residualPaths, problems, diagnosticId }], problems, operation: { id, state, checkpoint, canResume, logPath }, setup: { commands: [{ commandId, name, executed, reason, succeeded, outcome, exitCode, failureSummary, output? }] } }`；確認前狀態改變時為 `{ status: 'stale', message, plan: <新的摘要> }` |
| `rc.deploy.cancel` | — | `{ cancelled: boolean }`；取消正在套用的操作（終止設定命令的整棵子行程樹，目標不被改動） |
| `rc.client.getVersions` | — | `{ orca: { version, source: 'plugin' }, lcAiPack: { version: string 或 null, source: 'marketRelease' } }`；需要登入，LC-AI-Pack 發行資料缺少或連線失敗時版本為 null |

安裝狀態契約（新增欄位相容原請求）：

- `rc.catalog.list` 接受 `installation?: '' / all / installed / updates`，與搜尋、類型、分類交集。結果每包新增 `installationStatus: notInstalled / current / updateAvailable` 與 `deployments`。
- `rc.package.getDetails` 新增 `recommendedVersion`、`installationStatus` 與 `deployments`。手選舊版不改變用來比較更新的推薦版本。
- `deployments` 每筆為 `{ id, hostId, surfaceId, scope, rootPath, version, channel, source: market/local, status: current/updateAvailable/unavailable, updateVersion: string 或 null, contentDiffersFromMarket }`。內容收據依目標、資源版本與來源分組，同包的不同目標保持各自版本。`current` 表示沒有較新版；詳情能確認已裝版本不可見時使用 `unavailable`，不建議降版。
- 收據從共用全域目錄及 `config.json` 的 `registeredProjects` 讀取。下架或本機來源的資源仍可出現在「已安裝」篩選；收據沒有名稱／分類時只以識別碼與內容類型呈現，不推測市集分類。本機側載不參與市集更新比較。
- `rc.deploy.listTargets` 接受可選的 `{ packageKey }`，除了偵測結果，也提供該包收據記錄且仍存在的 Codex 全域根目錄，讓舊式家目錄安裝可在原位置更新；不重建消失的根目錄。
- `rc.deploy.plan` 每個目標新增 `installedVersions` 與 `nextVersion`，摘要新增 `unchangedDeployments`。本工項仍一次選一個目標，其他位置的內容與收據保持原樣；多選與專案部署由後續工項延伸。

目錄固定查詢條件、每頁 50 筆，最多 200 頁，以識別碼去重。搜尋去除前後空白，類型、分類與搜尋同時交集；分類保留市集精確值（空分類為「未分類」）。舊查詢不覆蓋新查詢；登出後清除清單。

版本摘要沿用 LC-AI-Pack 的延遲載入方式，不逐包取得詳情；正式版與 Preview 摘要由市集提供。詳情只顯示 `isEnabled && (channel === 'release' || previewMode)` 的版本，審核狀態不參與判斷。預設版本優先採市集推薦；推薦不在可見集合時，依 release 整組優先、組內版號降冪回退。下載重新確認版本可見性，依 package key＋version 取得確切 ZIP，不以摘要版本代替使用者選擇。

下載／格式錯誤代碼為 `version_unavailable`、`checksum_mismatch`、`invalid_package`、`unsafe_path`、`save_failed`，網路與工作階段錯誤沿用既有契約。失敗原因可直接顯示並重試。

安裝與更新共用 `rc.deploy.plan` → `rc.deploy.apply`。worker 同一時間只保留一份等待確認的計畫；套用的 `planDigest` 與目標集合必須與最近一次摘要完全相同，否則回 `plan_stale` 且零寫入。套用時逐部署目標在鎖定內重新規劃，與審核時的目標摘要不同就不寫入並回傳新摘要。問題的 `code` 沿用 LC-AI-Pack（`deployment.*`）。部署收據檔無法讀取時回 `receipt_invalid`；目錄「全部」檢視與資源詳情不受影響（回傳 `installedError` 取代安裝狀態，面板顯示無法讀取原因），「已安裝」「可更新」篩選與部署則明確失敗。計畫綁定產生它的市集與登入帳號：登出、工作階段被拒絕或換市集網址時丟棄等待確認的計畫，套用前再核對一次，不符回 `plan_stale`。任一目標在套用時過期（即使其他目標已成功）都改回新摘要要求重新確認，不當成部分完成、也不送出回報（對照 LC-AI-Pack 市集精靈）。收據驅動的移除（資源包更新後不再存在的內容）只會處理目標根目錄內的路徑，收據記錄的路徑超出根目錄時該目標還原並回報原因。

部署核心在 `worker/deploy/`，對照 LcAiPack.Core Deployment：`planner.mjs`（DeploymentPlanner 的 plan／apply）、`host-profiles.mjs`（路由表，matrix digest 與 LC-AI-Pack 相同）、`resource-drivers.mjs`（目前註冊 Skill driver）、`receipts.mjs`（收據格式與 ownership address，與 .NET 序列化逐位元組相同）、`plan-digest.mjs`、`ownership-index.mjs`、`target-lock.mjs`、`target-transaction.mjs`、`apply-executor.mjs`、`canonical-root.mjs`、`codex-roots.mjs`。需要執行期秘密的 MCP 尚未支援（Orca 沒有受管 launcher），規劃時以受阻問題揭露，不靜默略過。

後續安裝可直接匯入 `worker/package-validator.mjs` 的 `validatePackage(bytes, { packageKey, version, sha256?, downloadSha256? })`，共用 SHA-256、ZIP 路徑與格式驗證；成功回傳 `{ manifest, files: Map<string, Buffer>, sha256 }`。此入口沒有檔案系統副作用，不執行 setup 命令，也不讀取或儲存參數秘密。

後續領域（下載、部署規劃）在 `worker/handlers/` 新增模組並在 `worker/index.mjs` 註冊，透過 `session.requireClient()` 取得帶工作階段的市集用戶端；最終 401 由 `session.rejectClient(client)` 清除失效的工作階段。

## 目錄結構

```text
ai-resource-center/
├── orca-plugin.json
├── worker/
│   ├── index.mjs           worker 入口：建立服務、註冊請求
│   ├── contract.mjs        請求契約：錯誤代碼、輸入驗證、統一包裝
│   ├── handlers/session.mjs rc.session.*
│   ├── session-service.mjs 登入／登出／失效處理流程
│   ├── auth.mjs            帳密登入（client "gui"）
│   ├── session-manager.mjs 工作階段續期（single-flight、退避、排程）
│   ├── session-store.mjs   工作階段儲存（外掛秘密儲存）
│   ├── market-client.mjs   帶工作階段的市集請求（401 續期後重送）
│   ├── logout.mjs          撤銷與登出順序
│   ├── market-url.mjs      市集網址正規化與同源判斷
│   ├── paths.mjs           本機路徑解析（Windows／macOS）
│   ├── download-service.mjs 下載並驗證確切 ZIP（單獨下載與部署共用）
│   ├── deploy-service.mjs  rc.deploy.*：部署目標、部署摘要、確認套用
│   ├── install-reports.mjs 安裝回報（InstallReportBuilder／Outbox，持久在外掛儲存）
│   ├── deploy/             規劃與套用核心（對照 LcAiPack.Core Deployment）
│   ├── setup/              設定參數與命令（對照 LcAiPack.Core Setup）：values／secrets／planning／input-service／managed-mcp，另有 completions（命令完成狀態）、runners、execution-context、command-runner、operation-log／operations、masker、secret-channel 與 orchestrator（DeploymentOperationOrchestrator）
│   └── http.mjs            HTTP 傳輸層
├── panel/                  面板 UI
└── test/                   node:test 測試、假 Orca 主機與假市集；fixtures/ 為 LC-AI-Pack 產生的收據格式對照
```

## 測試

```bash
node --test
```
