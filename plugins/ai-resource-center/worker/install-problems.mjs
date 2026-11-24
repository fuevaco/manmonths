// 一鍵安裝的使用者說明；部署核心仍使用原始規則與診斷。
import { LinuxKeyringHelp } from './setup/secrets.mjs';
const replacements = [
  [/canonical root/gi, '根目錄'], [/contentId/g, '內容識別碼'], [/\bpackage\b/gi, '資源包'],
  [/\bownership\b/gi, '管理權'], [/\bshadowing\b/gi, '載入優先順序'], [/\brollback\b/gi, '還原'],
  [/\brunner\b/gi, '執行程式'], [/\bconfig\b/gi, '設定檔'], [/\breceipt\b/gi, '部署收據'],
  [/\btarget\b/gi, '部署目標'], [/\bscope\b/gi, '安裝範圍'], [/\bsurface\b/gi, '載入面'],
  [/\bhost\b/gi, 'AI 工具'], [/\bforce\b/gi, '強制覆寫'], [/\bplan\b/gi, '部署計畫'],
  [/\bapply\b/gi, '套用'], [/\block\b/gi, '鎖定'], [/\bhash\b/gi, '驗證碼'],
  [/\blog\b/gi, '紀錄'], [/\boperation\b/gi, '操作'], [/exit code/gi, '結束代碼']
];
const plainText = text => replacements.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), String(text ?? ''));

function message(p) {
  if (p.action === 'uninstall') {
    if (p.code === 'deployment.apply-failed') return `解除安裝失敗，這個位置已還原為原本的內容：${plainText(p.explanation || '請稍後重試').split(/[\r\n]/)[0].slice(0, 120)}`;
    if (p.code === 'deployment.rollback-failed') return `解除安裝失敗，部分內容無法還原：${(p.residualPaths ?? []).join('、') || '請展開詳細紀錄查看路徑'}`;
  }
  const text = p.explanation || p.summary || '';
  switch (p.code) {
    case 'deployment.ownership-collision': {
      const owner = p.existingOwner?.ownerPackageKey;
      return owner ? `這個位置已有其他資源包『${owner}』安裝的同名內容` : '這個位置的同名內容已由其他部署目標管理';
    }
    case 'deployment.config-conflict': {
      const file = p.configPath ?? p.path;
      return '這個位置的設定檔無法安全修改' + (file ? `（${file.split('#')[0].split(/[\\/]/).at(-1)}）` : '');
    }
    case 'deployment.setup-command-failed':
      return `設定命令「${p.commandName ?? '準備環境'}」執行失敗：${plainText(p.failureSummary ?? p.explanation ?? '請展開詳細紀錄查看原因').split(/[\r\n]/)[0].slice(0, 100)}`;
    case 'deployment.invalid-package': return '資源包內容不完整或格式不正確，無法安裝';
    case 'deployment.unsupported-content-kind': return '目前無法安裝這類內容，請更新外掛或聯絡資源包作者';
    case 'deployment.unsupported-host': return '找不到可安裝的 AI 工具，請確認工具已安裝';
    case 'deployment.unsupported-route': return '這個部署目標不支援資源包內的內容';
    case 'deployment.path-escape': return '資源包要寫入安裝位置以外的路徑，為保護資料已停止';
    case 'deployment.destination-collision': return '資源包內有多份內容要安裝到同一位置，請聯絡作者修正';
    case 'deployment.unmanaged-collision': return '這個位置已有同名內容，需先備份才能安裝';
    case 'deployment.local-modification': return '這個位置的內容已被修改，需先備份才能安裝';
    case 'deployment.scope-shadowing': return '其他安裝範圍已有同名內容，需先確認載入優先順序';
    case 'deployment.invalid-setup': return '資源包的設定方式有誤，請聯絡作者修正';
    case 'deployment.setup-parameter-missing': return '請先填寫必要的設定參數';
    case 'deployment.setup-unsupported-environment': return '設定命令不支援這台電腦的系統或處理器';
    case 'deployment.setup-runner-unavailable': return '找不到設定命令所需的執行程式，請先安裝後重試';
    case 'deployment.setup-intent-mismatch': return '安裝動作已變更，請重新執行安裝';
    case 'deployment.setup-cancelled': return '已取消設定，尚未完成安裝';
    case 'deployment.secret-unresolved': return p.explanation === LinuxKeyringHelp ? LinuxKeyringHelp : '無法讀取安全儲存的設定參數，請重新設定後重試';
    case 'deployment.mcp-launcher-unavailable': return p.summary;
    case 'deployment.consent-required': return '需先確認備份並取代現有內容';
    case 'deployment.source-changed': return '資源包內容已變更，請重新下載後安裝';
    case 'deployment.plan-stale': return '這個位置的內容已變動，請重新執行安裝';
    case 'deployment.lock-unavailable': return '這個位置正在安裝其他內容，請稍後重試';
    case 'deployment.apply-failed': return p.failureStage === 'backup' ? '無法先備份這個位置的現有內容，為避免遺失資料已停止' : '這個位置安裝失敗，已還原本次變更，請展開詳細紀錄查看原因';
    case 'deployment.rollback-failed': return '這個位置安裝失敗，部分內容無法還原，請展開詳細紀錄協助復原';
    default: return plainText(text);
  }
}

export function describeInstallProblems(problems) {
  return { reason: [...new Set(problems.map(message).filter(Boolean))].join('；') || '此位置未完成部署', detail: problems };
}

export function describeBlockedTarget(problems) {
  const conflicts = [], remaining = [];
  for (const problem of problems) {
    const { ownerPackageKey, ownerContentId } = problem.existingOwner ?? {};
    if (problem.code === 'deployment.ownership-collision' && problem.contentId && ownerPackageKey) {
      conflicts.push({ contentId: problem.contentId, ownerPackageKey, ownerContentId });
    } else {
      remaining.push(problem);
    }
  }
  const summary = describeInstallProblems(problems);
  if (!conflicts.length) return summary;
  return { ...summary, conflicts, otherReason: remaining.length ? describeInstallProblems(remaining).reason : null };
}
