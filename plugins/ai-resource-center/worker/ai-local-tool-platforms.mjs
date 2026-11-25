// 本機 AI 工具的平台對照集中在這裡：指令、顯示名稱、資料送往的公司、實測版本、登入檢查，以及錯誤訊息的辨識規則。
export const LOCAL_TOOL_PLATFORMS = {
  'claude-code': {
    command: 'claude', label: 'Claude Code', vendor: 'Anthropic', testedVersion: '2.1.331', authArgs: ['auth', 'status', '--json'],
    errors: {
      signedOut: /not logged in|please (?:run )?\/?login|authentication_error/i,
      limited: /rate[ _-]?limit|usage limit|hit your limit|quota exceeded/i,
      outdated: /(?:unknown|unrecognized|unexpected) (?:option|flag|argument)/i
    }
  },
  codex: {
    command: 'codex', label: 'Codex', vendor: 'OpenAI', testedVersion: '0.172.0', authArgs: ['login', 'status'],
    errors: {
      signedOut: /not logged in|\bunauthorized\b|\b401\b|codex login/i,
      limited: /usage limit|rate[ _-]?limit|quota exceeded|\b429\b/i,
      outdated: /unknown feature flag|unexpected argument|unrecognized (?:option|argument)/i
    }
  }
};
export const CLAUDE_CODE = LOCAL_TOOL_PLATFORMS['claude-code'];
export const CODEX = LOCAL_TOOL_PLATFORMS.codex;
export const isLocalToolPlatform = value => typeof value === 'string' && Object.hasOwn(LOCAL_TOOL_PLATFORMS, value);
export const platformLabel = key => LOCAL_TOOL_PLATFORMS[key]?.label ?? '';

/** 面板顯示用的名稱，隨 AI 設定一併回傳，面板不另外維護對照。 */
export const platformNames = () => Object.fromEntries(Object.entries(LOCAL_TOOL_PLATFORMS)
  .map(([key, { label, vendor }]) => [key, { label, vendor }]));
