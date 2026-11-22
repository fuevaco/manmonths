// 面板使用的 AI 工具身分與友善名稱；收據身分維持部署核心格式。
import { HostIds, SurfaceIds } from './deploy/host-profiles.mjs';
export const toolId = t => t.surfaceId === SurfaceIds.claudeDesktop ? SurfaceIds.claudeDesktop : t.hostId;
const labels = { [HostIds.codex]: 'Codex', [HostIds.claudeCode]: 'Claude Code', [SurfaceIds.claudeDesktop]: 'Claude Desktop' };
export const hostLabel = t => labels[toolId(t)] ?? toolId(t);
export const targetSummary = t => ({ targetId: t.id, hostId: toolId(t), label: hostLabel(t), rootPath: t.rootPath });
export const supportedTools = [
  { hostId: HostIds.codex }, { hostId: HostIds.claudeCode }, { hostId: SurfaceIds.claudeDesktop }
].map(t => ({ ...t, label: labels[t.hostId], matches: target => toolId(target) === t.hostId }));
