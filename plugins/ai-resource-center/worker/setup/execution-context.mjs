// package × scope 安裝根目錄底下的確定性配置與設定命令的執行 context（對照 Setup/SetupExecutionContext.cs）。
// 三個固定子目錄、責任互斥：
//   payload/  平台擁有：每次執行前從已驗證 zip 重建，只落地作者明確宣告的 script 與 payloads；
//   runtime/  發布者腳本自己的可寫區：平台不解讀也不清除，也是設定命令的 working directory；
//   mcp/      受管 MCP launcher 的啟動描述：由平台寫入。
// 環境變數不含任何秘密；秘密只走子行程 stdin 的一次性框架。
import fs from 'node:fs';
import path from 'node:path';
import { createPathRules } from '../deploy/canonical-root.mjs';
import { CanonicalPackageError } from '../deploy/canonical-package.mjs';
import { resolveSetupRoot } from './planning.mjs';

import { isUnsafeRelativePath as unsafe } from '../path-safety.mjs';

/**
 * @param {object} p
 * @param {string} p.home
 * @param {string} p.canonicalRoot  setup 身分根（Global 為使用者家目錄、Project 為專案根）
 * @param {string|null} [p.projectRoot]
 */
export function createExecutionContext({ home, packageKey, packageVersion, scope, canonicalRoot, projectRoot = null, rules = createPathRules() }) {
  const setupRoot = resolveSetupRoot(home, packageKey, scope, canonicalRoot, rules);
  const payloadRoot = path.join(setupRoot, 'payload'), runtimeRoot = path.join(setupRoot, 'runtime'), mcpRoot = path.join(setupRoot, 'mcp');
  const project = projectRoot ? rules.normalize(projectRoot) : null;

  /** 解析 package 相對 script／payload 路徑在 payload 目錄下的絕對位置，並確認結果沒有離開 payload（路徑穿越是安全類別錯誤，不只一道關卡）。 */
  function resolvePayloadPath(packageRelativePath) {
    if (typeof packageRelativePath !== 'string' || !packageRelativePath.trim()) throw new TypeError('setup 路徑為必填');
    if (unsafe(packageRelativePath)) throw new TypeError(`setup 路徑必須是 package 內的安全相對路徑：${packageRelativePath}`);
    const resolved = path.resolve(payloadRoot, ...packageRelativePath.replaceAll('\\', '/').split('/'));
    if (!resolved.startsWith(path.resolve(payloadRoot) + path.sep)) throw new TypeError(`setup 路徑解析後離開 payload 目錄：${packageRelativePath}`);
    return resolved;
  }
  const ctx = {
    setupRoot, payloadRoot, runtimeRoot, mcpRoot, packageKey, packageVersion, scope, canonicalRoot: rules.normalize(canonicalRoot), projectRoot: project,
    /** 建立三個固定子目錄；只在真的要執行時呼叫，規劃階段永遠不呼叫。 */
    ensureDirectories() { for (const d of [payloadRoot, runtimeRoot, mcpRoot]) fs.mkdirSync(d, { recursive: true }); },
    resolvePayloadPath,
    /** 重建 payload：先整棵刪除舊 payload（不可能殘留上一版檔案），再落地宣告的 script 與 payloads；runtime/ 完全不動。 */
    materializePayload(pkg, commands) {
      fs.rmSync(payloadRoot, { recursive: true, force: true });
      ctx.ensureDirectories();
      const writeEntry = relative => {
        const destination = resolvePayloadPath(relative);
        let content = null;
        try { content = pkg.readFile(relative); } catch (e) { if (!(e instanceof CanonicalPackageError)) throw e; }
        if (content) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, content); return; }
        for (const file of pkg.readTree(relative)) {
          const target = resolvePayloadPath(`${relative.replace(/[\\/]+$/, '')}/${file.relativePath}`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, file.content);
        }
      };
      for (const command of commands) {
        if (typeof command.script === 'string' && command.script) writeEntry(command.script);
        for (const payload of (command.payloads ?? []).filter(p => typeof p === 'string' && p.trim())) writeEntry(payload);
      }
    },
    /** 設定命令的環境變數；沒有任何秘密。 */
    buildEnvironment(operationId = null) {
      const variables = { LCAIPACK_SETUP_ROOT: setupRoot, LCAIPACK_PAYLOAD_ROOT: payloadRoot, LCAIPACK_RUNTIME_ROOT: runtimeRoot, LCAIPACK_PACKAGE_KEY: packageKey,
        LCAIPACK_PACKAGE_VERSION: packageVersion, LCAIPACK_SCOPE: scope };
      if (scope === 'project' && project) variables.LCAIPACK_PROJECT_ROOT = project;
      if (operationId) variables.LCAIPACK_OPERATION_ID = operationId;
      return variables;
    }
  };
  return ctx;
}
