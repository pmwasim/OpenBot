import { redactSecrets } from './provider.mjs';

export const TASK_ARTIFACT_LIMITS = Object.freeze({ maxArtifacts: 50, maxPreviewBytes: 64 * 1024 });

function safeRelativePath(value) {
  const path = String(value || '').trim();
  if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '')) return null;
  return path;
}

function actionFromEvent(event) {
  if (event.payload?.action) return event.payload.action;
  if (!['action.executed', 'action.failed', 'action.proposed'].includes(event.type)) return null;
  return {
    tool: event.tool || event.payload?.tool,
    status: event.type.slice('action.'.length),
    args: event.args || event.payload?.args || null,
    result: event.result ?? event.payload?.result ?? null
  };
}

export function taskArtifactInventory(task, events = []) {
  const artifacts = new Map();
  for (const event of events) {
    const action = actionFromEvent(event);
    const tool = String(action?.tool || '').trim().toLowerCase();
    if (!['file.write', 'browser.fetch'].includes(tool) || action.status !== 'executed') continue;
    const result = action.result && typeof action.result === 'object' ? action.result : {};
    const path = safeRelativePath(result.path || action.args?.path);
    if (!path) continue;
    const bytes = Number(result.bytes);
    artifacts.set(`${tool}:${path}`, {
      id: `${tool}:${path}`,
      kind: 'workspace-file',
      path,
      tool,
      status: action.status || 'unknown',
      bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null
    });
  }
  return { taskId: task.id, artifacts: [...artifacts.values()].slice(-TASK_ARTIFACT_LIMITS.maxArtifacts) };
}

export function redactArtifactContent(content) {
  const redacted = redactSecrets(String(content || ''));
  if (Buffer.byteLength(redacted, 'utf8') <= TASK_ARTIFACT_LIMITS.maxPreviewBytes) return { content: redacted, truncated: false };
  const clipped = Buffer.from(redacted, 'utf8').subarray(0, TASK_ARTIFACT_LIMITS.maxPreviewBytes).toString('utf8');
  return { content: `${clipped}…[truncated]`, truncated: true };
}
