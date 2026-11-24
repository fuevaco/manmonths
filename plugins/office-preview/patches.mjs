// 打包時對第三方套件做的小補丁（以 esbuild onLoad 改寫原始碼，不動 node_modules）。
// 每一條補丁都必須「剛好命中」：找不到就讓建置失敗，這樣升級套件版本時會被發現，而不是悄悄失效。

import { readFileSync } from 'node:fs';

const patches = [
  // ---- jszip：移除 `new Function(字串)` ----
  // jszip 的 browser 欄位指向預先壓縮好的 dist/jszip.min.js，裡面含 setimmediate 的舊用法
  // `new Function(字串)`。Orca 編輯器 frame 禁止字串編譯（`orca plugin check` 會警告），
  // 而 jszip 只會傳函式給它，所以換成明確的錯誤：行為不變，也不再有動態程式碼。
  {
    filter: /jszip[\\/]dist[\\/]jszip\.min\.js$/,
    why: 'jszip：移除 setimmediate 的 new Function',
    edits: [
      {
        pattern: /"function"!=typeof (\w+)&&\(\1=new Function\(""\+\1\)\);/,
        replacement: '"function"!=typeof $1&&(()=>{throw new TypeError("setImmediate only accepts a function")})();'
      }
    ]
  },
  // 原始碼版的 setimmediate（若日後打包路徑改變會走這裡）
  {
    filter: /setimmediate[\\/]setImmediate\.js$/,
    why: 'setimmediate：移除 new Function',
    edits: [
      {
        pattern: /(\w+)\s*=\s*new Function\(\s*""\s*\+\s*\1\s*\)\s*;/,
        replacement: 'throw new TypeError("setImmediate only accepts a function");'
      }
    ]
  },

  // ---- pptx-preview ----
  {
    filter: /pptx-preview[\\/]dist[\\/]pptx-preview\.es\.js$/,
    why: 'pptx-preview：容錯與圖表動畫',
    edits: [
      // 部分簡報（例如 LibreOffice 存出的）的 presentation.xml 沒有 p:defaultTextStyle，
      // 原本會在 Object.keys(undefined) 丟出未處理的例外（畫面雖然仍能畫出來，但會污染外掛記錄）。
      {
        pattern: /(var t=this,e=this\.pptx\.defaultTextStyleSource)(;Object\.keys\(e\))/,
        replacement: '$1||{}$2'
      },
      // 圖表預設會跑進場動畫：預覽時畫面會先出現半截長條、截圖也會拍到過程。關掉動畫，一次畫完。
      {
        pattern: /t\.setOption\(i\),vt\("destroy"/,
        replacement: 't.setOption(Object.assign({},i,{animation:!1})),vt("destroy"'
      },
      // 圖表沒有標題文字時，套件會硬塞簡體中文的「图表标题」。繁體使用者不需要這個，改成不顯示。
      {
        pattern: /\|\|"\u56fe\u8868\u6807\u9898"/,
        replacement: '||""'
      }
    ]
  }
];

export const patchThirdParty = {
  name: 'patch-third-party',
  setup(build) {
    for (const { filter, why, edits } of patches) {
      build.onLoad({ filter }, (args) => {
        let source = readFileSync(args.path, 'utf8');
        for (const { pattern, replacement } of edits) {
          const next = source.replace(pattern, replacement);
          if (next === source) {
            throw new Error(`補丁沒有命中（${why}）：${args.path}\n請檢查套件版本是否改變，並更新 patches.mjs 的規則。`);
          }
          source = next;
        }
        return { contents: source, loader: 'js' };
      });
    }
  }
};
