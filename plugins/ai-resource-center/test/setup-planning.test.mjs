// 設定參數規劃（對照 SetupPlanningTests、SetupPlanDigestTests 的參數情境）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPathRules } from '../worker/deploy/canonical-root.mjs';
import { SetupValueStore } from '../worker/setup/values.mjs';
import { createSecretManager, setupSecretReference } from '../worker/setup/secrets.mjs';
import { planSetup, computeSetupDigest, resolveSetupRoot } from '../worker/setup/planning.mjs';
import { memoryStore } from './fake-secret-store.mjs';

function environment(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), userHome = path.join(dir, 'user'), projectRoot = path.join(dir, 'project');
  fs.mkdirSync(userHome); fs.mkdirSync(projectRoot);
  const store = memoryStore();
  const secrets = createSecretManager(store);
  const plan = (setup, { scope = 'project', pendingValues } = {}) => planSetup({ setup, packageKey: 'demo', packageVersion: '1.0.0', scope,
    projectRoot: scope === 'project' ? projectRoot : null, home, userHome, secrets, pendingValues });
  return { dir, home, userHome, projectRoot, store, secrets, plan };
}
const param = (parameterId, extra = {}) => ({ parameterId, label: parameterId, type: 'string', required: true, ...extra });
const find = (plan, id) => plan.parameters.find(p => p.parameterId === id);

test('沒有 setup 的資源包產生空計畫，不查詢安全儲存區', t => {
  const e = environment(t);
  const plan = e.plan(null);
  assert.equal(plan.hasSetup, false);
  assert.deepEqual(plan.problems, []);
});

test('全域已儲存值、manifest 預設值與專案覆寫依序疊合並揭露來源', t => {
  const e = environment(t);
  SetupValueStore.forGlobal({ home: e.home, userProfile: e.userHome }).setValues('demo', { 'server-url': 'https://global.example', workspace: 'global-workspace' });
  SetupValueStore.forProject({ projectRoot: e.projectRoot }).setValues('demo', { workspace: 'project-workspace' });
  const setup = { parameters: [param('server-url', { default: 'https://default.example' }),
    param('auth-mode', { type: 'choice', default: 'vault', options: [{ value: 'vault', label: 'Vault' }, { value: 'pat', label: 'PAT' }] }), param('workspace')] };
  const plan = e.plan(setup);
  assert.deepEqual([find(plan, 'server-url').effectiveValue, find(plan, 'server-url').source], ['https://global.example', 'Global']);
  assert.deepEqual([find(plan, 'auth-mode').effectiveValue, find(plan, 'auth-mode').source], ['vault', 'ManifestDefault']);
  assert.deepEqual(find(plan, 'auth-mode').options, [{ value: 'vault', label: 'Vault' }, { value: 'pat', label: 'PAT' }]);
  assert.deepEqual([find(plan, 'workspace').effectiveValue, find(plan, 'workspace').source], ['project-workspace', 'ProjectOverride']);
  // Global 安裝完全忽略專案覆寫。
  assert.equal(find(e.plan(setup, { scope: 'global' }), 'workspace').effectiveValue, 'global-workspace');
  // 本次輸入優先於已儲存值；布林預設值以小寫字串表示。
  const pending = e.plan({ parameters: [param('workspace'), param('verbose', { type: 'boolean', required: false, default: false })] }, { pendingValues: { workspace: 'typed' } });
  assert.deepEqual([find(pending, 'workspace').effectiveValue, find(pending, 'workspace').source], ['typed', 'PendingInput']);
  assert.equal(find(pending, 'verbose').effectiveValue, 'false');
});

test('缺少可見的必填值時阻擋並指名參數；不可見的必填參數不阻擋', t => {
  const e = environment(t);
  const plan = e.plan({ parameters: [param('server-url')] });
  assert.equal(find(plan, 'server-url').needsInput, true);
  assert.equal(plan.canApply, false);
  assert.ok(plan.problems.some(p => p.code === 'deployment.setup-parameter-missing' && p.severity === 'Blocking' && p.summary.includes('server-url')));
  const hidden = e.plan({ parameters: [param('auth-mode', { type: 'choice', default: 'pat', options: [{ value: 'vault', label: 'V' }, { value: 'pat', label: 'P' }] }),
    param('vault-pat', { type: 'secret', secretUsage: 'setup-time', visibleWhen: { parameterId: 'auth-mode', equals: 'vault' } })] });
  assert.equal(find(hidden, 'vault-pat').visible, false);
  assert.equal(find(hidden, 'vault-pat').needsInput, false);
  assert.deepEqual(hidden.problems, []);
});

test('秘密只回報是否已儲存，不帶值也不帶選項', t => {
  const e = environment(t);
  const setup = { parameters: [param('api-key', { type: 'secret', secretUsage: 'runtime', options: [] })] };
  let plan = e.plan(setup);
  assert.deepEqual(find(plan, 'api-key'), { parameterId: 'api-key', label: 'api-key', type: 'secret', description: null, required: true, visible: true,
    isSecret: true, secretUsage: 'runtime', effectiveValue: null, source: 'Unset', secretProvided: false, needsInput: true, options: [] });
  assert.equal(plan.canApply, false);
  e.secrets.set(setupSecretReference({ packageKey: 'demo', parameterId: 'api-key', scope: 'project', canonicalRoot: e.projectRoot }), 'canary-plan-secret');
  plan = e.plan(setup);
  assert.equal(find(plan, 'api-key').secretProvided, true);
  assert.equal(plan.canApply, true);
  assert.equal(JSON.stringify(plan).includes('canary'), false);
  assert.equal(computeSetupDigest(plan).includes('canary'), false);
});

test('setup 摘要涵蓋有效值、來源與秘密有無，不涵蓋選項標籤與秘密值', t => {
  const e = environment(t);
  const setup = { parameters: [param('mode', { type: 'choice', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }),
    param('api-key', { type: 'secret', secretUsage: 'runtime' })] };
  const base = computeSetupDigest(e.plan(setup));
  assert.equal(computeSetupDigest(e.plan(setup)), base);
  const relabeled = { parameters: [{ ...setup.parameters[0], options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] }, setup.parameters[1]] };
  assert.equal(computeSetupDigest(e.plan(relabeled)), base);
  assert.notEqual(computeSetupDigest(e.plan(setup, { pendingValues: { mode: 'b' } })), base);
  assert.notEqual(computeSetupDigest(e.plan(setup, { scope: 'global' })), base);
  const ref = setupSecretReference({ packageKey: 'demo', parameterId: 'api-key', scope: 'project', canonicalRoot: e.projectRoot });
  e.secrets.set(ref, 'one');
  const present = computeSetupDigest(e.plan(setup));
  assert.notEqual(present, base);
  e.secrets.set(ref, 'two');
  assert.equal(computeSetupDigest(e.plan(setup)), present);
});

test('安裝根目錄由 Core 規則決定：家目錄下、依 package 與 scope 區分、規劃時不建立', t => {
  const e = environment(t);
  const plan = e.plan({ parameters: [param('x', { default: 'y' })] });
  assert.ok(plan.setupRoot.startsWith(path.resolve(e.home)));
  assert.notEqual(plan.setupRoot, e.plan({ parameters: [param('x', { default: 'y' })] }, { scope: 'global' }).setupRoot);
  assert.equal(fs.existsSync(e.home), false);
  // 期望值由 SetupRootResolver.Resolve 實際產生。
  assert.equal(resolveSetupRoot('C:\\lchome', 'orca-rc-demo-mcp-params', 'global', 'C:\\Users\\Demo\\', createPathRules({ platform: 'win32', resolveLinks: false })),
    'C:\\lchome\\setup-roots\\orca-rc-demo-mcp-params\\global-dda80ed47911b770');
});
