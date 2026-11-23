import { RcError, ErrorCode, badParams } from './contract.mjs';
import { unreachableError } from './auth.mjs';
import { parseJson } from './http.mjs';
import { compareVersions, packageInput } from './package-service.mjs';

const text = value => typeof value === 'string' ? value : '';
const optionalText = value => text(value).trim() || null;
const forbidden = Symbol('forbidden');
const malformed = () => new RcError(ErrorCode.marketError, '市集開發資料格式錯誤，請重試');

// DTO 的 submittedBy／submittedAt 是舊版上傳欄位；submitter 才是送審者。
export function normalizeDeveloperVersion(row) {
  if (!row || !Number.isSafeInteger(row.id) || typeof row.version !== 'string') throw malformed();
  const preview = row.channel === 'preview';
  const status = text(row.status);
  return {
    id: row.id, version: row.version, channel: preview ? 'preview' : 'release', status,
    isEnabled: row.isEnabled === true, uploadedAt: row.submittedAt ?? null, reviewedAt: row.reviewedAt ?? null, reviewedBy: text(row.reviewedBy).trim(),
    uploadedBy: optionalText(row.uploadedBy) ? row.uploadedBy : text(row.submittedBy),
    submittedBy: text(row.submitter).trim(),
    rejectReason: optionalText(row.rejectReason) ? row.rejectReason : status === 'rejected' ? '審核者沒有留下原因；請洽市集管理者。' : '',
    statusLabel: status === 'active' ? (preview ? 'Preview 可測試' : '已上架')
      : status === 'pending_review' ? '送審中' : status === 'rejected' ? '已駁回' : '狀態未知',
    primaryAction: status === 'pending_review' ? 'withdraw' : preview && ['active', 'rejected'].includes(status) ? 'submit' : null,
    canDelete: preview
  };
}

export function normalizeDeveloperPackage(row) {
  if (!row || typeof row.packageKey !== 'string' || !Array.isArray(row.versions)) throw malformed();
  const versions = row.versions.map(normalizeDeveloperVersion).sort((a, b) => compareVersions(b.version, a.version));
  return {
    packageKey: row.packageKey, name: text(row.name), type: text(row.type), description: text(row.description),
    category: text(row.category), tags: Array.isArray(row.tags) ? row.tags.filter(tag => typeof tag === 'string') : [],
    currentUserRole: text(row.currentUserRole).toLowerCase() === 'maintainer' ? 'maintainer' : 'owner',
    installCount: row.versions.reduce((sum, v) => sum + (Number.isSafeInteger(v.installCount) ? v.installCount : 0), 0),
    allDisabled: versions.length > 0 && versions.every(v => !v.isEnabled), versions
  };
}

const actionLabels = Object.freeze({ upload: '上傳', submit_review: '送審', approve: '核准', reject: '駁回',
  withdraw_review: '取回申請', enable: '啟用', disable: '停用', promote: '管理員直接上架（舊流程）' });
function normalizeHistory(row) {
  if (!row || typeof row.action !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) throw malformed();
  const date = new Date(row.createdAt);
  const pad = n => String(n).padStart(2, '0');
  return { id: row.id, createdAt: row.createdAt,
    timeText: `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    action: row.action, actionLabel: actionLabels[row.action] ?? row.action,
    actor: text(row.actorAdAccount), comment: optionalText(row.comment) ? row.comment : '—' };
}
function versionInput(input) {
  if (!Number.isSafeInteger(input?.versionId) || input.versionId <= 0) throw badParams('版本識別碼格式錯誤');
}
function commentInput(input) {
  if (input.comment !== undefined && input.comment !== null && typeof input.comment !== 'string') throw badParams('附註必須是文字');
  return optionalText(input.comment);
}
function dataRows(body) {
  if (!body || !Array.isArray(body.data)) throw malformed();
  return body.data;
}

export function createDeveloperService(session) {
  async function request(path, options = {}, allowForbidden = false, boundClient) {
    const client = boundClient ?? await session.requireClient();
    let res;
    try { res = await client.request({ path: `api/market/${path}`, ...options }); }
    catch (error) {
      if (error instanceof RcError) throw error;
      throw unreachableError(error, client.marketUrl);
    }
    if (res.status === 401) await session.rejectClient(client);
    if (allowForbidden && res.status === 403) return forbidden;
    if (res.status < 200 || res.status >= 300) {
      const body = parseJson(res.text);
      const message = (optionalText(body?.detail) || optionalText(body?.title) || '市集操作失敗，請稍後再試')
        .replace(/[（(]\s*HTTP\s+\d{3}\s*[）)]/gi, '').trim() || '市集操作失敗，請稍後再試';
      const code = res.status === 409 ? ErrorCode.conflict : res.status === 403 ? ErrorCode.forbidden
        : [400, 422].includes(res.status) ? ErrorCode.invalidParams : res.status >= 500 ? ErrorCode.serviceUnavailable : ErrorCode.marketError;
      throw new RcError(code, message, { status: res.status });
    }
    return res.status === 204 ? null : parseJson(res.text);
  }
  async function review(input, action) {
    versionInput(input);
    const comment = commentInput(input);
    return { version: normalizeDeveloperVersion(await request(`versions/${input.versionId}/${action}`, { method: 'POST', json: { comment } })) };
  }
  return {
    request,
    async submitReviewByVersion(input) {
      packageInput({ packageKey: input?.packageKey });
      if (typeof input.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(input.version)) throw badParams('版本格式錯誤');
      const comment = commentInput(input);
      const client = await session.requireClient();
      const detail = await request(`packages/${encodeURIComponent(input.packageKey)}`, {}, false, client);
      if (!Array.isArray(detail?.versions)) throw malformed();
      const target = detail.versions.find(v => v.version === input.version);
      if (!target) throw new RcError(ErrorCode.versionUnavailable, `找不到版本 ${input.version}`);
      versionInput({ versionId: target.id });
      await request(`versions/${target.id}/submit-review`, { method: 'POST', json: { comment } }, false, client);
      return { ok: true };
    },
    async listMyPackages() {
      const body = await request('my/packages', {}, true);
      return body === forbidden ? { forbidden: true, packages: [] } : { forbidden: false, packages: dataRows(body).map(normalizeDeveloperPackage) };
    },
    submitReview: input => review(input, 'submit-review'),
    withdrawReview: input => review(input, 'withdraw-review'),
    async setEnabled(input) {
      versionInput(input);
      if (typeof input.isEnabled !== 'boolean') throw badParams('啟用狀態必須是布林值');
      return { version: normalizeDeveloperVersion(await request(`versions/${input.versionId}/enabled`, { method: 'PUT', json: { isEnabled: input.isEnabled } })) };
    },
    async history(input) {
      versionInput(input);
      return { history: dataRows(await request(`versions/${input.versionId}/history`)).map(normalizeHistory) };
    },
    async deleteVersion(input) {
      packageInput({ packageKey: input?.packageKey });
      // SemVer build metadata 也能出現在伺服器既有版本，不以公開安裝入口的版號限制阻擋刪除。
      if (typeof input.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(input.version)) throw badParams('版本格式錯誤');
      if (typeof input.confirmationVersion !== 'string' || input.confirmationVersion !== input.version) throw badParams('請輸入完整且相符的版本號');
      if (typeof input.comment !== 'string' || !input.comment.trim() || input.comment.trim().length > 500) throw badParams('刪除原因須為 1–500 字');
      await request(`packages/${encodeURIComponent(input.packageKey)}/versions/${encodeURIComponent(input.version)}`,
        { method: 'POST', json: { comment: input.comment, confirmationVersion: input.confirmationVersion } });
      return { deleted: true };
    },
    async updatePackage(input) {
      packageInput(input);
      if (typeof input.name !== 'string' || !input.name.trim() ||
        ['description', 'category', 'tags'].some(key => typeof input[key] !== 'string')) throw badParams('資源包資訊格式錯誤，名稱為必填');
      const tags = input.tags.split(',').map(tag => tag.trim()).filter(Boolean).join(',') || null;
      return { package: normalizeDeveloperPackage(await request(`packages/${encodeURIComponent(input.packageKey)}`,
        { method: 'PUT', json: { name: input.name.trim(), description: optionalText(input.description), category: optionalText(input.category), tags } })) };
    }
  };
}
