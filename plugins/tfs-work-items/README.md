# Azure DevOps (Work Items)

專為 **[Orca](https://github.com/stablyai/orca)** 開發的 **Azure DevOps / 地端 TFS** 工項互動側邊欄套件。

## ✨ 主要功能

- **連線地端 TFS / Azure DevOps Server**：支援自訂 Collection URL（如 `https://tfs.company.com/tfs/DefaultCollection`）、API 版本切換（`4.1` ~ `7.0`）與內網自簽 HTTPS 憑證選項。
- **PAT 安全儲存**：Personal Access Token 透過 Orca 的 `secrets:own` 加密儲存於系統金鑰圈，不會明文寫入設定檔。
- **查詢與篩選 Task / Bug**：
  - 快速切換「指派給我」或「全部」
  - 依 `Task` / `Bug`、標題關鍵字或直接輸入 `#ID`（例如 `#1234`）查詢
- **直接新增工項**：支援在 Orca 側邊欄建立 **Task** 與 **Bug**（標題、說明 / 重現步驟、優先權、Iteration Path、指派給我）。
- **工項互動與一鍵派工**：
  - 快速變更工項狀態（`New`、`Active`、`Resolved`、`Closed`、`To Do`、`Doing`、`Done`）
  - 新增討論留言寫回 TFS（`System.History`）
  - 一鍵點擊 **「🤖 派工給 Agent」**，自動將工項編號、標題與詳細說明帶入 Orca Coding Agent 開始開發。

## 🚀 使用方式

1. 於 Orca 安裝並啟用 **`manmonths.tfs-work-items`**（需核准權限：`settings:own`、`secrets:own`、`workspace:read`、`agent:launch`、`notifications:show`）。
2. 點擊右側邊欄的 **Azure DevOps** 圖示開啟面板。
3. 在設定畫面填入：
   - **TFS Collection 網址**（例如 `https://tfs.company.com/tfs/DefaultCollection`）
   - **PAT**（需具備 `Work Items (Read & Write)` 權限）
   - 點擊 **「測試連線並載入專案」** 選擇專案並儲存即可開始使用。
