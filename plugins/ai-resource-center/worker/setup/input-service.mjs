// 面板設定參數的輸入與揭露（對照 SetupFormCollector.TryCollect、SetupFieldViewModel、Core SetupInputCollector）。
// - 揭露：只回傳非秘密有效值與來源；秘密只回報「是否已儲存」。
// - 儲存：一般值寫入全域 setup.json；秘密只寫入作業系統安全儲存區。
//   先完整驗證再寫入；錯誤訊息只含參數身分，不含任何值。
import { badParams, RcError, ErrorCode } from '../contract.mjs';
import { createPathRules } from '../deploy/canonical-root.mjs';
import { SetupValueStore, SetupFileError } from './values.mjs';
import { createSecretManager, createDefaultSecretStore, setupSecretReference, SetupSecretStoreError } from './secrets.mjs';

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createSetupInputService({ home, userHome, platform = process.platform, secretStore, rules = createPathRules() }) {
  // 只有真的需要時才建立平台安全儲存區；沒有秘密的資源包不會碰到它。
  let osStore = null;
  const store = secretStore ?? new Proxy({}, { get: (_, name) => (...args) => (osStore ??= createDefaultSecretStore({ platform }))[name](...args) });
  const secrets = createSecretManager(store, rules);

  function summarize(setup) {
    if (!setup?.hasSetup) return null;
    // 設定命令（對照 PlanRenderer.WriteSetupHuman）：身分、作者宣告的顯示名稱（作用）、runner 與腳本、已插值的非秘密參數、相容性、是否執行與理由。
    // 參數與命令都只在這裡揭露；確認前不執行任何命令。
    const commands = setup.commands.map(c => ({ commandId: c.commandId, name: c.name, runner: c.runner, script: c.script, arguments: c.arguments, operatingSystems: c.operatingSystems,
      ...(c.borrowedFromOs ? { borrowedFromOs: c.borrowedFromOs } : {}), architectures: c.architectures, timeoutMinutes: c.timeoutMinutes, runOnUpdate: c.runOnUpdate, eligibility: c.eligibility, willExecute: c.willExecute, reason: c.reason }));
    return { scope: setup.scope, setupRoot: setup.setupRoot, commands, executableCommandIds: commands.filter(c => c.willExecute).map(c => c.commandId), parameters: setup.parameters.map(p => ({ parameterId: p.parameterId, label: p.label, type: p.type, description: p.description,
      required: p.required, visible: p.visible, isSecret: p.isSecret, secretUsage: p.secretUsage, value: p.isSecret ? null : p.effectiveValue,
      source: p.source, secretProvided: p.secretProvided, needsInput: p.needsInput, options: p.options })) };
  }

  function save(setup, intent, input) {
    if (!setup?.hasSetup) throw badParams('此資源包沒有設定參數');
    if (setup.scope !== 'global') throw badParams('Orca 只支援全域設定參數');
    const values = input.values ?? {}, secretValues = input.secrets ?? {};
    if (!isPlainObject(values) || !isPlainObject(secretValues)) throw badParams('設定參數格式錯誤');
    const byId = new Map(setup.parameters.map(p => [p.parameterId, p]));

    const plain = {};
    for (const [id, raw] of Object.entries(values)) {
      const p = byId.get(id);
      if (!p || p.isSecret) throw badParams(`未知或不可作為一般值的設定參數：${id}`);
      let formValue;
      if (p.type === 'boolean') {
        if (typeof raw !== 'boolean') throw badParams(`設定參數 ${id} 必須是布林值`);
        formValue = raw ? 'true' : 'false';
      } else {
        if (raw !== null && typeof raw !== 'string') throw badParams(`設定參數 ${id} 必須是文字`);
        formValue = raw === null || !raw.trim() ? null : raw.trim();
        if (p.type === 'choice' && formValue !== null && !p.options.some(o => o.value === formValue)) throw badParams(`設定參數 ${id} 的值不在選項中`);
      }
      // 對照 TryCollect：有效值改變、必填缺值被補上，或沿用尚未落地的預設值時才儲存。
      if (formValue !== p.effectiveValue) plain[id] = formValue;
      else if (p.needsInput && formValue !== null) plain[id] = formValue;
      else if (formValue !== null && (p.source === 'Unset' || p.source === 'ManifestDefault')) plain[id] = formValue;
    }
    const pendingSecrets = [];
    for (const [id, value] of Object.entries(secretValues)) {
      const p = byId.get(id);
      if (!p?.isSecret) throw badParams(`未知的秘密參數：${id}`);
      if (typeof value !== 'string' || value === '') throw badParams(`秘密參數 ${id} 不得為空`);
      pendingSecrets.push([setupSecretReference({ packageKey: setup.packageKey, parameterId: id, scope: setup.scope, canonicalRoot: setup.canonicalRoot }, rules), value]);
    }

    for (const [ref, value] of pendingSecrets) secrets.set(ref, value);
    if (Object.keys(plain).length) {
      SetupValueStore.forGlobal({ home, userProfile: userHome, rules })
        .setValues(setup.packageKey, plain, setup.parameters.filter(p => p.isSecret).map(p => p.parameterId));
    }
  }

  /** 把設定層錯誤轉成面板可顯示的錯誤；訊息不含秘密值。 */
  function guard(fn) {
    const convert = e => {
      if (e?.unsupportedFormatVersion) throw e;
      if (e instanceof SetupFileError) throw new RcError(ErrorCode.setupInvalid, `${e.message}。請修正或移除該檔案後重試。`);
      if (e instanceof SetupSecretStoreError) throw new RcError(ErrorCode.secretStoreFailed, e.message);
      throw e;
    };
    try { const result = fn(); return typeof result?.then === 'function' ? result.catch(convert) : result; } catch (e) { return convert(e); }
  }

  return { secrets, summarize, save, guard };
}
