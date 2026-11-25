# Office 文件預覽 (Orca Extension)

在 **[Orca](https://github.com/stablyai/orca)** 裡直接開啟並預覽 **Word、Excel、PowerPoint** 檔案：點檔案就看得到內容，不必再開外部程式。

- **外掛 ID**：`linkchain-corp.office-preview`
- **執行方式**：`sandboxed-ui`（純前端沙盒，**不需要任何權限**，一鍵安裝）
- **完全離線、唯讀**：所有解析程式都已打包在外掛內，不連網；只讀取檔案內容，**不會修改原檔**，也不會把檔案標成「已修改」。

---

## 支援的格式

| 類型 | 副檔名 | 預覽方式 | 還原度 |
| :--- | :--- | :--- | :--- |
| **Word** | `.docx` `.docm` `.dotx` | 版面還原（頁面、頁首頁尾、表格、圖片、清單、註腳） | 高 |
| **Word 97-2003** | `.doc` | **僅純文字**＋簡易表格（見下方說明） | 低（無圖片與格式） |
| **Excel** | `.xlsx` `.xlsm` `.xlsb` `.xls` `.ods` | 虛擬捲動格線、工作表分頁、合併儲存格、底色、數字與日期格式 | 中高 |
| **PowerPoint** | `.pptx` `.ppsx` `.pptm` | 單頁 / 連續兩種檢視 | 中高 |

### 為什麼 `.doc` 只有純文字？

`.doc`（Word 97-2003）是 Microsoft 的二進位格式，**純前端沒有能高保真排版它的引擎**。因此本外掛只從檔案內挖出文字（含簡易表格），並在畫面上方明確提示。要看完整版面，請用 Word 另存成 `.docx`。

> 想要 100% 還原 `.doc`，需要呼叫本機的 LibreOffice 轉檔，這必須使用 `trusted-worker`（需使用者核准高權限）。本外掛刻意不這麼做，維持「一鍵安裝、零權限」。

### 其他限制

- **Excel**：不顯示字型樣式（粗體、字色）、框線、圖片與圖表；公式列顯示公式或儲存格值，不會重新計算（顯示的是檔案內已儲存的結果）。
- **PowerPoint**：複雜圖表、SmartArt、動畫與轉場效果不會完整還原；舊版 `.ppt` 不支援，請另存成 `.pptx`。
- **Word**：不顯示追蹤修訂與註解。
- 有密碼保護的檔案無法預覽；單檔上限依 Orca 規定為 64 MiB。

---

## 使用方式

安裝並啟用後，在 Orca 開啟支援的檔案即可預覽（外掛註冊為各副檔名的預設檢視）。

| 類型 | 操作 |
| :--- | :--- |
| **Word** | 工具列縮放 `－` / `＋` / `符合寬度`；`Ctrl` + 滾輪或 `Ctrl` + `+` / `-` / `0` |
| **Excel** | 點選儲存格（公式列顯示內容）；拖曳或 `Shift` + 方向鍵選取範圍（狀態列顯示計數 / 總和 / 平均）；`Ctrl` + `C` 複製為 TSV；底部切換工作表；方向鍵、`PageUp` / `PageDown`、`Ctrl` + `Home` / `End` 移動 |
| **PowerPoint** | `←` `→` / `PageUp` `PageDown` / 空白鍵翻頁，`Home` / `End` 跳首尾；工具列切換「單頁 / 連續」；`Ctrl` + 滾輪縮放 |

> [!NOTE]
> 若同時安裝了 Orca 官方的 Word / Spreadsheet 檢視外掛或其他預覽外掛，同一個副檔名會有多個編輯器可選；可以在編輯器分頁的檢視切換列選用想要的那一個，或停用不需要的外掛。

---

## 開發與維護

```text
plugins/office-preview/
├── orca-plugin.json        # 三個 customEditors：word-preview / excel-preview / ppt-preview
├── package.json            # 只在開發時使用（建置與測試）
├── build.mjs               # esbuild：把 src/ 打包成 editor/dist/*.js，並產生 THIRD-PARTY-LICENSES.txt
├── src/
│   ├── common/             # 取得文件位元組、深淺主題、載入中 / 錯誤遮罩、格式判斷
│   ├── word/               # docx-preview 渲染 + 舊版 .doc 純文字擷取（doc-legacy.js）
│   ├── excel/              # SheetJS 解析 + 虛擬捲動格線（grid-model.js 為不碰 DOM 的純邏輯）
│   └── ppt/                # pptx-preview 渲染 + 自製的單頁 / 連續檢視與縮放
├── editor/                 # Orca 載入的檔案：*.html / *.css 與打包結果 dist/*.js
├── test/                   # node:test 單元測試
└── THIRD-PARTY-LICENSES.txt
```

```bash
cd plugins/office-preview
npm install        # 只有開發時需要；打包結果已 commit，使用者端不會執行 npm
npm run build      # 重新打包 editor/dist/*.js（改過 src/ 就要跑，並把結果一起 commit）
npm test           # 單元測試
orca plugin check . && orca plugin validate .
```

- **為什麼打包結果也要 commit？** Orca 安裝外掛時只抓 Git 內的檔案，使用者端不會跑 npm / esbuild。
- **離線與 CSP**：編輯器 frame 沒有網路，只能載入外掛資料夾內的檔案、`data:` 與 `blob:`；打包後不含任何外部 URL。Word 圖片以 base64 內嵌。
- **為何補丁 `new Function`**：`jszip` 內的 `setimmediate` 含有 `new Function(字串)`（只在傳字串時才會用到，jszip 不會），Orca 編輯器 frame 禁止字串編譯，`build.mjs` 以 esbuild 外掛把它換成明確的錯誤，讓 `orca plugin check` 乾淨通過。
- 在 Orca 開發：`orca plugin dev load .`，改了檔案會自動重新載入；`orca plugin shot linkchain-corp.office-preview --editor <檔案>` 可截圖檢查渲染。

### 使用的開源套件

| 套件 | 用途 | 授權 |
| :--- | :--- | :--- |
| [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) | `.docx` 版面渲染 | Apache-2.0 |
| [SheetJS（@e965/xlsx 0.20.3）](https://sheetjs.com/) | Excel / ODS 解析 | Apache-2.0 |
| [pptx-preview](https://www.npmjs.com/package/pptx-preview) | `.pptx` 渲染 | ISC |
| [cfb](https://github.com/SheetJS/js-cfb) | 讀取舊版 `.doc` 的 OLE 容器 | Apache-2.0 |
| [JSZip](https://stuk.github.io/jszip/) | 解壓 OOXML | MIT |

完整授權文字見 [THIRD-PARTY-LICENSES.txt](./THIRD-PARTY-LICENSES.txt)。
