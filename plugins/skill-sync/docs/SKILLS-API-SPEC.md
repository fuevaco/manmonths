# Skills Registry API 標準 v1

這份文件定義「技能庫網店」要提供給 Orca `skill-sync` 外掛（或任何用戶端）的 API。
目標是讓你實作一次後端，就能被外掛清單、下載、驗證，並確保內容沒被竄改。

- **格式**：純 JSON + 一般檔案下載，只用 HTTP `GET`，不需要特殊協定。
- **驗證**：`Authorization: Bearer <token>`。
- **完整性**：每個檔案有 `sha256`，整個 skill 有 `digest`，用戶端逐一核對。
- **標準答案**：[`worker/spec.mjs`](../worker/spec.mjs) 是這份文件的可執行版本，[`tools/mock-server.mjs`](../tools/mock-server.mjs) 是參考實作，[`tools/verify-api.mjs`](../tools/verify-api.mjs) 用來驗證你的實作。三者與本文件有出入時，以 `spec.mjs` 為準。

用語依 RFC 2119：**必須**（MUST）不符合就是不合標準；**建議**（SHOULD）不做會收到警告。

---

## 1. 端點

`{base}` 是 API 根網址，例如 `https://skills.example.com/api/v1/`。用戶端設定可以填根網址（自動接上 `index.json`），也可以直接填 `.json` 結尾的完整網址。

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `{base}/index.json` | 技能索引：每個 skill 的最新版本摘要 |
| `GET` | 索引項目的 `manifestUrl` | 某個 skill 某個版本的檔案清單 |
| `GET` | 清單內每個檔案的 `url` | 檔案內容（原始位元組） |

路徑結構（`manifestUrl` 與檔案 `url` 實際上由你決定，下面只是建議）：

```
{base}/index.json
{base}/skills/<name>/<version>/manifest.json
{base}/skills/<name>/<version>/files/<path>
```

> `manifestUrl` 與檔案 `url` 可以是絕對網址，也可以是相對網址。`manifestUrl` 相對於 `index.json` 的網址解析，檔案 `url` 相對於該 `manifest.json` 的網址解析。

---

## 2. 驗證與錯誤

### 驗證

- 私有技能庫**必須**檢查 `Authorization: Bearer <token>`，缺少或錯誤都回 `401`。
- Token 有效但沒有這個資源的權限回 `403`。
- 公開技能庫可以不驗證；用戶端不帶 Token 也能用。

### 錯誤格式（建議）

所有 `4xx` / `5xx` 回應**建議**使用：

```json
{ "error": { "code": "invalid_token", "message": "Token 無效" } }
```

`code` 是機器可讀的短字串，`message` 是給人看的說明。用戶端會把 `message` 顯示給使用者。

### 狀態碼

| 狀態碼 | 意義 | 用戶端處理 |
|---|---|---|
| `200` | 成功 | — |
| `304` | `If-None-Match` 命中 | 使用本機快取的索引 |
| `401` | 未提供或無效的 Token | 提示檢查 Token |
| `403` | 沒有權限 | 提示沒有權限 |
| `404` | 資源不存在 | **不存在的資源必須回 404**，不可以對任何路徑都回 200（單頁應用程式常見的錯誤） |
| `429` | 請求太頻繁 | 提示稍後再試 |

---

## 3. 索引：`index.json`

```json
{
  "specVersion": 1,
  "generatedAt": "2026-11-20T00:53:38Z",
  "name": "範例技能庫",
  "skills": [
    {
      "name": "hello-skill",
      "description": "範例 skill：示範最小可用的 SKILL.md，只含說明文字，沒有指令碼。",
      "version": "1.0.0",
      "digest": "sha256:a2a901144ed213c2fe1103c8506f568e3343ab2df9884f6bf1b923634c3900b8",
      "manifestUrl": "skills/hello-skill/1.0.0/manifest.json",
      "author": "人月",
      "license": "MIT",
      "tags": ["example", "minimal"],
      "hasScripts": false,
      "size": 282,
      "updatedAt": "2026-11-20T00:53:38Z"
    }
  ]
}
```

### 頂層欄位

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `specVersion` | 整數 | **必須** | 固定為 `1` |
| `skills` | 陣列 | **必須** | 最多 2000 筆 |
| `name` | 字串 | 選填 | 技能庫名稱，顯示在面板標題 |
| `generatedAt` | 字串 | 建議 | ISO 8601 時間 |

### `skills[]` 欄位

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `name` | 字串 | **必須** | skill 識別名稱，同時是安裝後的資料夾名稱。小寫英數與連字號，1–64 字元，不可以連字號開頭或結尾：`^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`。**索引內不可重複** |
| `description` | 字串 | **必須** | 非空，建議 1024 字元內 |
| `version` | 字串 | **必須** | 語意化版本 `MAJOR.MINOR.PATCH[-預覽][+建置]` |
| `digest` | 字串 | **必須** | `sha256:` + 64 位小寫十六進位，算法見[第 5 節](#5-摘要digest算法)。**必須**與清單內的 `digest` 相同 |
| `manifestUrl` | 字串 | **必須** | 清單網址，**必須**與 `index.json` 同一來源（見[第 8 節](#8-安全規則)） |
| `title` | 字串 | 選填 | 顯示用標題；未提供就顯示 `name` |
| `author` / `license` / `homepage` | 字串 | 選填 | |
| `tags` | 字串陣列 | 選填 | |
| `hasScripts` | 布林 | 建議 | 是否含指令碼或可執行檔。**僅供顯示**，用戶端會依檔案自行判斷，不信任這個欄位 |
| `size` | 整數 | 選填 | 所有檔案位元組總和；若提供，驗證工具會核對 |
| `updatedAt` | 字串 | 選填 | ISO 8601 時間 |

**一個名稱只列最新的一筆。** 舊版本可以繼續用它的 `manifestUrl` 存取，但不列在索引中。

---

## 4. 清單：`manifest.json`

```json
{
  "specVersion": 1,
  "name": "commit-helper",
  "version": "1.1.0",
  "digest": "sha256:2c39b56dc583eaa8911dfc5341c40d01409d43dcc49855fc82100d1d2bfb6349",
  "files": [
    {
      "path": "SKILL.md",
      "size": 333,
      "sha256": "…64 位小寫十六進位…",
      "url": "files/SKILL.md"
    },
    {
      "path": "scripts/summarize.sh",
      "size": 22,
      "sha256": "…",
      "url": "files/scripts/summarize.sh",
      "executable": true
    }
  ]
}
```

### 欄位

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `specVersion` | 整數 | **必須** | 固定為 `1` |
| `name` / `version` / `digest` | | **必須** | 必須與索引項目**完全一致** |
| `files` | 陣列 | **必須** | 至少一個，**必須**包含根目錄的 `SKILL.md` |
| `files[].path` | 字串 | **必須** | 相對路徑，規則見下 |
| `files[].size` | 整數 | **必須** | 位元組 |
| `files[].sha256` | 字串 | **必須** | 檔案內容的 SHA-256，64 位小寫十六進位 |
| `files[].url` | 字串 | **必須** | 絕對網址，或相對於 `manifest.json` 的網址 |
| `files[].executable` | 布林 | 選填 | 是否需要可執行權限（macOS / Linux） |

### 路徑規則（`files[].path`）

為了讓 skill 能在所有作業系統安全安裝，路徑**必須**符合：

- 相對路徑，以正斜線 `/` 分隔，不可以 `/` 開頭、不可含 `\`、`:`、控制字元。
- 任何一段都不可以是空字串、`.`、`..`，也不可以是 `.git`。
- 不可以句點或空白結尾，不可含 `< > " | ? *`，不可是 Windows 保留名稱（`con`、`prn`、`aux`、`nul`、`com1`–`com9`、`lpt1`–`lpt9`，含任何副檔名）。
- 全部路徑在**不分大小寫**下不可重複（Windows 不分大小寫）。
- 長度不超過 200 字元。

### SKILL.md

- 根目錄**必須**有 `SKILL.md`。
- 開頭**建議**有 frontmatter，且 `name` 與 skill 名稱相同、有 `description`：

```markdown
---
name: hello-skill
description: 範例 skill：…
---
```

---

## 5. 摘要（digest）算法

`digest` 讓用戶端確認「整包內容」就是索引宣告的那一份，而且**可以由檔案清單重新算出來**。

```
1. 取清單的 files，依 path 的 UTF-8 位元組順序（等同 Unicode 碼點順序）排序
2. 對每個檔案組成字串： path + "\0" + sha256 + "\n"     （\0 是 NUL 字元）
3. 把所有字串依序串接，以 UTF-8 編碼後計算 SHA-256
4. digest = "sha256:" + 結果（小寫十六進位）
```

只與「路徑」和「內容雜湊」有關，與清單順序、`size`、`url`、`executable` 無關。

**Node.js**

```js
import { createHash } from 'node:crypto';
function computeDigest(files) {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const h = createHash('sha256');
  for (const f of sorted) h.update(`${f.path}\0${f.sha256}\n`, 'utf8');
  return `sha256:${h.digest('hex')}`;
}
```

**Python**

```python
import hashlib

def compute_digest(files):
    h = hashlib.sha256()
    for f in sorted(files, key=lambda f: f["path"].encode("utf-8")):
        h.update(f"{f['path']}\0{f['sha256']}\n".encode("utf-8"))
    return "sha256:" + h.hexdigest()
```

> 這兩份實作已用同一組範例交叉驗證，結果相同。

---

## 6. 檔案下載

- 回應本體**必須**是檔案的原始位元組（不可以包 JSON、不可以做 base64、不可以轉換換行符號）。
- 位元組數**必須**等於 `size`，SHA-256 **必須**等於 `sha256`。
- `Content-Type` 不拘（建議 `application/octet-stream`）。
- 檔案 `url` 可以指向 CDN 或預先簽署的網址（不同來源），用戶端下載這類網址時**不會帶 Token**。

---

## 7. 快取與限制

### ETag（建議）

`index.json` 建議回傳 `ETag`。用戶端重新整理時會帶 `If-None-Match`；**若你提供了 `ETag`，就必須支援它並在命中時回 `304`**。

### 限制

用戶端與驗證工具都用這些上限，超過就拒絕：

| 項目 | 上限 |
|---|---|
| `index.json` 大小 | 5 MB |
| `manifest.json` 大小 | 1 MB |
| 索引內 skill 數量 | 2000 |
| 單一 skill 檔案數 | 200 |
| 單一檔案大小 | 5 MB |
| 單一 skill 總大小 | 20 MB |

### 不可變（建議）

`manifestUrl` 與檔案 `url` 建議**包含版本號**，且發佈後內容**不再改變**（可以放心設長快取）。要更新就發新版本，並更新索引。

---

## 8. 安全規則

用戶端會強制執行下列規則，你的伺服器也應該配合：

1. **Token 只送給 API 所在的來源。** `manifestUrl` 必須與 `index.json` 同一來源，否則拒絕；檔案 `url` 若在其他來源，下載時不帶 Token。
2. **HTTPS。** 有 Token 時，用戶端只會對 `localhost` 使用 `http`；其他主機要使用者明確開啟「允許 HTTP」。拒絕從 `https` 轉址到 `http`。
3. **不信任伺服器的宣告。** 檔案內容與雜湊不符、摘要不符、路徑不合法、超過大小限制，整包都不會寫入磁碟。`hasScripts` 只是提示，用戶端會依副檔名與 `executable` 自行判斷是否含指令碼，並在安裝前警告。
4. **Token 管理建議。** 使用者的 Token 建議可撤銷、有到期時間、只授予讀取權限。
5. **誠實標示。** skill 的內容會影響 Agent 的行為。含指令碼的 skill 請如實設定 `hasScripts`，並避免在 skill 中放入需要使用者額外信任的外部下載行為。

---

## 9. 實作與驗證

### 快速產生符合標準的內容

把一個放滿 skill 資料夾的目錄轉成標準格式（每個子資料夾一個 skill，需有 `SKILL.md`）：

```bash
node tools/build-registry.mjs <skills 資料夾> <輸出資料夾> --name "我的技能庫"
```

輸出的 `index.json`、`manifest.json` 與檔案可以直接當作 API 回應內容。
**純靜態主機（如 GitHub Pages、S3）無法檢查 Bearer Token**；私有技能庫需要在前面加一層能驗證 Token 的伺服器或閘道。

### 本機跑參考實作

```bash
node tools/mock-server.mjs examples/skills --token secret --prefix /api/v1
```

### 驗證你的 API

```bash
node tools/verify-api.mjs https://skills.example.com/api/v1/ --token <token> --require-auth
```

也可以用外掛面板設定畫面裡的「驗證 API」按鈕，兩者使用同一套檢查。結束碼 `0` 代表通過、`1` 代表有不合標準的項目。

| 檢查項目 | 等級 | 內容 |
|---|---|---|
| 索引可連線 | 必須 | `GET index.json` 回 200 |
| Content-Type | 建議 | `application/json` |
| 索引格式 | 必須 | 符合第 3 節 |
| 未帶 Token 被拒絕 | 必須* | 回 401 / 403 |
| 拒絕時的錯誤格式 | 建議 | `{"error":{"code","message"}}` |
| 錯誤 Token 被拒絕 | 必須* | 回 401 / 403（避免伺服器其實沒檢查 Token） |
| ETag 條件請求 | 必須（有提供時） | `If-None-Match` → 304 |
| 不存在的資源回 404 | 必須 | |
| 每個 skill | 必須 | 清單格式、與索引一致、每個檔案的大小與雜湊、摘要可重算 |
| `hasScripts` / `size` 誠實 | 建議 | 與實際檔案相符 |

\* 私有技能庫適用；公開技能庫只會收到「未要求驗證」的提醒。加上 `--require-auth` 則一律必須。

---

## 10. 版本演進

- `specVersion` 是整數。目前為 `1`，用戶端遇到不認得的版本會拒絕並提示更新外掛。
- v1 內只會**新增選填欄位**；用戶端會忽略不認得的欄位，所以你可以在索引與清單中加入自己的擴充欄位。
- 任何會讓舊用戶端失效的修改（改欄位意義、改摘要算法）都會升為 `specVersion: 2`。
