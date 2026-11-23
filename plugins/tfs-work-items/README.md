# Azure DevOps (Work Items)

專為 **[Orca](https://github.com/stablyai/orca)** 開發的 **Azure DevOps / 地端 TFS** 工項互動側邊欄套件。

## ✨ 主要功能

- **連線地端 TFS / Azure DevOps Server**：支援自訂 Collection URL（如 `https://tfs.company.com/tfs/DefaultCollection`）、API 版本切換（`4.1` ~ `7.0`）與內網自簽 HTTPS 憑證選項。
- **PAT 安全儲存**：Personal Access Token 透過 Orca 的 `secrets:own` 加密儲存於系統金鑰圈，不會明文寫入設定檔。
- **Windows 整合驗證（選用）**：設定頁的「認證方式」可改成 Windows，改用這台電腦目前登入的網域帳號連線（呼叫系統內建 `curl.exe --negotiate`，Kerberos），不需要 PAT。僅限 Windows，TFS 網址須使用網域名稱（不能用 IP）。驗證失敗時，若已設定 PAT 會自動改用 PAT。預設仍是 PAT。
- **查詢與篩選 Task / Bug**：
  - 快速切換「指派給我」或「全部」
  - 依 `Task` / `Bug`、標題關鍵字或直接輸入 `#ID`（例如 `#1234`）查詢
  - **狀態可複選**：例如同時看「已提議」＋「作用中」；不勾選代表所有未結案狀態
  - **顯示符合條件的真實總數**：清單上方會標示「共 N 筆」，各專案群組標題也是該專案的實際筆數。符合的工項很多時，只會載入最近更新的前 N 筆（預設 1000），並明確提示被截斷（群組數字會加上 `+`），請用專案、狀態或關鍵字縮小範圍
  - **載入上限可調整**：面板設定畫面（⚙️）或 Orca 設定中的「清單最多載入的工項數」，範圍 50–5000，預設 1000。調高可一次看到更多，但載入會變慢；超出範圍的值會自動夾回範圍內
- **直接新增工項**：支援在 Orca 側邊欄建立 **Task** 與 **Bug**（標題、說明 / 重現步驟、優先權、Iteration Path、指派給我）。
- **工項詳情與傳送給 Agent**：
  - 詳情頁顯示基本資訊、**上層需求路徑**（由「需求」往下到目前工項）與說明 / 重現步驟。
  - 一鍵點擊 **「💬 傳送到聊天視窗」**：目前視窗已有 Agent 就送給它，沒有就開新的 Coding Agent CLI；會把工項編號、標題、上層路徑與詳細說明放進輸入框，內容**不會自動送出**，由你確認後自行按 Enter。
  - 狀態變更與留言交給 Agent 處理，面板不再提供快速變更狀態與留言欄位。

## 🚀 使用方式

1. 於 Orca 安裝並啟用 **`manmonths.tfs-work-items`**（需核准權限：`settings:own`、`secrets:own`、`workspace:read`、`agent:launch`、`notifications:show`）。
2. 點擊右側邊欄的 **Azure DevOps** 圖示開啟面板。
3. 在設定畫面填入：
   - **TFS Collection 網址**（例如 `https://tfs.company.com/tfs/DefaultCollection`）
   - **PAT**（需具備 `Work Items (Read & Write)` 權限）
   - 點擊 **「測試連線並載入專案」** 選擇專案並儲存即可開始使用。
