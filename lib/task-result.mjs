import { redactSecrets } from './provider.mjs';

export const TASK_RESULT_LIMITS = Object.freeze({ maxActions: 20, maxResultChars: 12000, maxActionArgsChars: 2000, maxActionResultChars: 6000 });

function boundedValue(value, maxChars) {
  const redacted = redactSecrets(value ?? null);
  if (typeof redacted === 'string') return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…[truncated]` : redacted;
  if (redacted == null) return redacted;
  let serialized;
  try { serialized = JSON.stringify(redacted); } catch { return '[unavailable]'; }
  return serialized.length > maxChars ? `${serialized.slice(0, Math.max(0, maxChars - 14))}…[truncated]` : redacted;
}

function boundedAction(action) {
  const safe = redactSecrets(action || {});
  return {
    tool: safe.tool || 'action',
    status: safe.status || 'unknown',
    ok: Boolean(safe.ok),
    actionId: safe.actionId || null,
    approvalId: safe.approvalId || null,
    reason: boundedValue(safe.reason, 1000),
    args: boundedValue(safe.args, TASK_RESULT_LIMITS.maxActionArgsChars),
    result: boundedValue(safe.result, TASK_RESULT_LIMITS.maxActionResultChars)
  };
}

export function taskResultView(task, events = []) {
  const actions = new Map();
  for (const event of events) {
    if (!['agent.action.executed', 'agent.waiting_approval', 'agent.stopped'].includes(event.type) || !event.payload?.action) continue;
    const action = event.payload.action;
    actions.set(action.actionId || `event-${event.seq}`, boundedAction(action));
  }
  return {
    taskId: task.id,
    status: task.status,
    result: boundedValue(task.result, TASK_RESULT_LIMITS.maxResultChars),
    error: boundedValue(task.error, TASK_RESULT_LIMITS.maxResultChars),
    actions: [...actions.values()].slice(-TASK_RESULT_LIMITS.maxActions),
    updatedAt: task.updatedAt
  };
}
