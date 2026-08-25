import { mkdir, open as openFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { decide } from './policy.mjs';

export const SEED_STATE = {
  approvals: [{
    id: 'approval-1',
    title: 'Send the weekly operations draft',
    detail: 'Creates a draft only. No external message is sent.',
    status: 'waiting'
  }],
  routines: [{
    id: 'routine-1',
    title: 'Morning systems brief',
    schedule: 'Weekdays at 08:30',
    enabled: true
  }]
};

const STATUS_TRANSITIONS = {
  pause: { from: ['pending', 'running', 'waiting_approval'], to: 'paused' },
  resume: { from: ['paused', 'recoverable'], to: 'pending' },
  cancel: { from: ['pending', 'running', 'paused', 'waiting_approval', 'recoverable'], to: 'cancelled' }
};

const SENSITIVE_KEY = /^(api[_-]?key|authorization|token|secret|password|credential|access[_-]?token)$/i;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function actionDigest(action = {}) {
  return createHash('sha256').update(JSON.stringify(canonicalize(action))).digest('hex');
}

export function redactSecrets(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([nextKey, nextValue]) => [nextKey, redactSecrets(nextValue, nextKey)]));
  }
  return value;
}

function emptyProjection() {
  return { events: [], tasks: new Map(), approvals: new Map(), routines: new Map(), seq: 0 };
}

function apply(projection, event) {
  projection.events.push(event);
  projection.seq = Math.max(projection.seq, Number(event.seq) || 0);
  const payload = event.payload || {};
  switch (event.type) {
    case 'task.created': {
      const task = {
        id: event.taskId,
        status: payload.status || 'pending',
        owner: payload.owner || 'local',
        provider: payload.provider || 'ollama',
        workspace: payload.workspace || 'local',
        eventSequence: event.seq,
        createdAt: event.ts,
        updatedAt: event.ts,
        prompt: payload.prompt || '',
        kind: payload.kind || 'plan',
        action: payload.action || null,
        actionDigest: payload.actionDigest || null,
        policy: payload.policy || 'allow',
        executionAttempt: Number(payload.executionAttempt) || 0
      };
      projection.tasks.set(task.id, task);
      break;
    }
    case 'task.status': {
      const task = projection.tasks.get(event.taskId);
      if (task) {
        task.status = payload.status;
        task.updatedAt = event.ts;
        task.eventSequence = event.seq;
      }
      break;
    }
    case 'task.action_proposed': {
      const task = projection.tasks.get(event.taskId);
      if (task) {
        task.action = payload.action || task.action;
        task.actionDigest = payload.actionDigest || task.actionDigest;
        task.updatedAt = event.ts;
        task.eventSequence = event.seq;
      }
      break;
    }
    case 'task.policy_decision': {
      const task = projection.tasks.get(event.taskId);
      if (task) {
        task.policy = payload.decision || task.policy;
        task.updatedAt = event.ts;
        task.eventSequence = event.seq;
      }
      break;
    }
    case 'task.execution_started': {
      const task = projection.tasks.get(event.taskId);
      if (task) {
        task.status = 'running';
        task.executionAttempt = Number(payload.attempt) || task.executionAttempt + 1;
        task.updatedAt = event.ts;
        task.eventSequence = event.seq;
      }
      break;
    }
    case 'approval.consumed': {
      const approval = projection.approvals.get(payload.id);
      if (approval) {
        approval.status = 'consumed';
        approval.consumedAt = event.ts;
        approval.actionDigest = payload.actionDigest || approval.actionDigest;
      }
      break;
    }
    case 'task.recoverable': {
      const task = projection.tasks.get(event.taskId);
      if (task) {
        task.status = 'recoverable';
        task.updatedAt = event.ts;
        task.eventSequence = event.seq;
      }
      break;
    }
    case 'approval.seeded':
    case 'approval.created': {
      if (!payload.id) break;
      projection.approvals.set(payload.id, {
        id: payload.id,
        title: payload.title,
        detail: payload.detail,
        status: payload.status || 'waiting',
        taskId: payload.taskId || event.taskId || null,
        actionId: payload.actionId || null,
        actionDigest: payload.actionDigest || null
      });
      break;
    }
    case 'approval.decided': {
      const approval = projection.approvals.get(payload.id);
      if (approval) {
        approval.status = payload.decision;
        approval.decidedAt = event.ts;
      }
      break;
    }
    case 'routine.seeded':
    case 'routine.updated': {
      if (!payload.id) break;
      projection.routines.set(payload.id, {
        id: payload.id,
        title: payload.title,
        schedule: payload.schedule,
        enabled: payload.enabled !== false
      });
      break;
    }
    default: {
      const task = event.taskId ? projection.tasks.get(event.taskId) : null;
      if (task) {
        task.eventSequence = event.seq;
        task.updatedAt = event.ts;
      }
    }
  }
}

function project(events) {
  const projection = emptyProjection();
  for (const event of events) apply(projection, event);
  return projection;
}

function parseJsonl(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); }
    catch { /* skip a truncated trailing line after a crash */ }
  }
  return events;
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function openStore(options = {}) {
  const dataDir = options.dataDir;
  if (!dataDir) throw new Error('openStore requires options.dataDir');
  const eventsFile = join(dataDir, 'events.jsonl');
  const lockFile = join(dataDir, 'store.lock');
  const legacyStateFile = join(dataDir, 'state.json');
  const legacySnapshotFile = join(dataDir, 'tasks.json');
  let projection = emptyProjection();

  async function acquireLock() {
    await mkdir(dataDir, { recursive: true });
    const started = Date.now();
    while (Date.now() - started < 5000) {
      try {
        const handle = await openFile(lockFile, 'wx');
        await handle.write(String(process.pid));
        return handle;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const info = await stat(lockFile);
          if (Date.now() - info.mtimeMs > 10000) await unlink(lockFile).catch(() => {});
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error('Timed out waiting for the OpenBot store lock.');
  }

  async function persist() {
    await mkdir(dataDir, { recursive: true });
    const temporary = `${eventsFile}.tmp`;
    const body = projection.events.map((event) => JSON.stringify(event)).join('\n');
    await writeFile(temporary, body ? `${body}\n` : '', 'utf8');
    const handle = await openFile(temporary, 'r+');
    try { await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, eventsFile);
  }

  async function readEventsFromDisk() {
    if (!existsSync(eventsFile)) return [];
    return parseJsonl(await readFile(eventsFile, 'utf8'));
  }

  async function seedFrom(state) {
    for (const routine of state.routines || []) {
      await appendUnlocked({ type: 'routine.seeded', payload: { ...routine } });
    }
    for (const approval of state.approvals || []) {
      await appendUnlocked({
        type: 'approval.seeded',
        taskId: approval.taskId || null,
        payload: {
          id: approval.id,
          title: approval.title,
          detail: approval.detail,
          status: approval.status || 'waiting',
          taskId: approval.taskId || null,
          actionId: approval.actionId || null,
          actionDigest: approval.actionDigest || null
        }
      });
    }
  }

  async function reloadAndMaybeSeed() {
    const events = await readEventsFromDisk();
    projection = project(events);
    if (projection.events.length) return;
    if (existsSync(legacyStateFile)) {
      await seedFrom(JSON.parse(await readFile(legacyStateFile, 'utf8')));
      return;
    }
    if (existsSync(legacySnapshotFile)) {
      await seedFrom(JSON.parse(await readFile(legacySnapshotFile, 'utf8')));
      return;
    }
    await seedFrom(options.seedState || SEED_STATE);
  }

  async function appendUnlocked(partial) {
    const event = {
      seq: projection.seq + 1,
      ts: new Date().toISOString(),
      type: partial.type,
      taskId: partial.taskId || null,
      payload: partial.payload || {}
    };
    apply(projection, event);
    await persist();
    return event;
  }

  async function withLock(fn) {
    const handle = await acquireLock();
    try {
      await reloadAndMaybeSeed();
      return await fn();
    } finally {
      await handle.close();
      await unlink(lockFile).catch(() => {});
    }
  }

  return {
    dataDir,
    eventsFile,
    async getState() {
      return withLock(async () => ({
        approvals: [...projection.approvals.values()],
        routines: [...projection.routines.values()]
      }));
    },
    async listTasks() {
      return withLock(async () => [...projection.tasks.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
    },
    async getTask(id) {
      return withLock(async () => projection.tasks.get(id) || null);
    },
    async listEvents(filter = {}) {
      return withLock(async () => {
        let events = projection.events;
        if (filter.taskId) events = events.filter((event) => event.taskId === filter.taskId);
        if (filter.limit) events = events.slice(-Number(filter.limit));
        return events;
      });
    },
    async createTask(input = {}) {
      return withLock(async () => {
        const id = input.id || `task-${randomUUID()}`;
        const kind = input.kind || 'plan';
        const action = input.action && typeof input.action === 'object' ? canonicalize(input.action) : null;
        const digest = action ? actionDigest(action) : null;
        const decision = decide({ ...input, ...(action || {}), kind, taskId: id });
        if (decision === 'deny') throw httpError(`Policy denied action kind "${kind}".`, 403);
        const status = decision === 'require_approval' ? 'waiting_approval' : 'pending';
        await appendUnlocked({
          type: 'task.created',
          taskId: id,
          payload: {
            status,
            owner: input.owner || 'local',
            provider: input.provider || 'ollama',
            workspace: input.workspace || 'local',
            prompt: input.prompt || '',
            kind,
            policy: decision,
            action,
            actionDigest: digest,
            executionAttempt: 0
          }
        });
        if (action) {
          await appendUnlocked({
            type: 'task.action_proposed',
            taskId: id,
            payload: { action, actionDigest: digest }
          });
        }
        await appendUnlocked({
          type: 'task.policy_decision',
          taskId: id,
          payload: { decision, actionDigest: digest }
        });
        let approval = null;
        if (decision === 'require_approval') {
          const approvalId = input.approvalId || `approval-${randomUUID()}`;
          const actionId = input.actionId || `action-${randomUUID()}`;
          await appendUnlocked({
            type: 'approval.created',
            taskId: id,
            payload: {
              id: approvalId,
              title: input.title || `Approval required: ${kind}`,
              detail: input.detail || input.prompt || `Action "${kind}" requires approval before execution.`,
              status: 'waiting',
              taskId: id,
              actionId,
              actionDigest: digest
            }
          });
          approval = projection.approvals.get(approvalId);
        }
        return { task: projection.tasks.get(id), approval, policy: decision };
      });
    },
    async setTaskStatus(id, action) {
      return withLock(async () => {
        const task = projection.tasks.get(id);
        if (!task) throw httpError('Task not found', 404);
        const transition = STATUS_TRANSITIONS[action];
        if (!transition) throw httpError(`Unsupported status action "${action}".`, 400);
        if (!transition.from.includes(task.status)) {
          throw httpError(`Cannot ${action} a task in status "${task.status}".`, 400);
        }
        await appendUnlocked({ type: 'task.status', taskId: id, payload: { status: transition.to, action } });
        return projection.tasks.get(id);
      });
    },
    async resumeTask(id) {
      return withLock(async () => {
        const task = projection.tasks.get(id);
        if (!task) throw httpError('Task not found', 404);
        if (!['paused', 'recoverable'].includes(task.status)) {
          throw httpError(`Cannot resume a task in status "${task.status}".`, 400);
        }
        if (task.action && task.policy === 'require_approval') {
          const approvalId = `approval-${randomUUID()}`;
          await appendUnlocked({
            type: 'task.status',
            taskId: id,
            payload: { status: 'waiting_approval', action: 'resume' }
          });
          await appendUnlocked({
            type: 'approval.created',
            taskId: id,
            payload: {
              id: approvalId,
              title: `Approval required to resume: ${task.kind}`,
              detail: task.prompt,
              status: 'waiting',
              taskId: id,
              actionId: `action-${randomUUID()}`,
              actionDigest: task.actionDigest
            }
          });
          return projection.tasks.get(id);
        }
        await appendUnlocked({ type: 'task.status', taskId: id, payload: { status: 'pending', action: 'resume' } });
        return projection.tasks.get(id);
      });
    },
    async appendTaskEvent(taskId, type, payload = {}) {
      return withLock(async () => {
        if (!projection.tasks.has(taskId)) throw httpError('Task not found', 404);
        return appendUnlocked({ type, taskId, payload });
      });
    },
    async decideApproval(id, decision) {
      return withLock(async () => {
        if (!['approved', 'rejected'].includes(decision)) throw httpError('Invalid approval request', 400);
        const item = projection.approvals.get(id);
        if (!item) throw httpError('Invalid approval request', 400);
        if (item.status !== 'waiting') throw httpError('Approval is no longer waiting.', 409);
        await appendUnlocked({
          type: 'approval.decided',
          taskId: item.taskId,
          payload: { id, decision, actionId: item.actionId || null }
        });
        if (item.taskId) {
          const task = projection.tasks.get(item.taskId);
          if (task && task.status === 'waiting_approval') {
            await appendUnlocked({
              type: 'task.status',
              taskId: item.taskId,
              payload: { status: decision === 'approved' ? 'pending' : 'cancelled', action: decision }
            });
          }
        }
        return projection.approvals.get(id);
      });
    },
    async consumeApproval(id, digest) {
      return withLock(async () => {
        const item = projection.approvals.get(id);
        if (!item) throw httpError('Approval not found', 404);
        if (item.status !== 'approved') throw httpError('Approval is not approved or has already been consumed.', 409);
        if (!digest || digest !== item.actionDigest) throw httpError('Approval does not match the requested action.', 409);
        await appendUnlocked({
          type: 'approval.consumed',
          taskId: item.taskId,
          payload: { id, actionId: item.actionId || null, actionDigest: digest }
        });
        return projection.approvals.get(id);
      });
    },
    async createApproval(input = {}) {
      return withLock(async () => {
        const approvalId = input.id || `approval-${randomUUID()}`;
        const actionId = input.actionId || (input.taskId ? `action-${randomUUID()}` : null);
        await appendUnlocked({
          type: 'approval.created',
          taskId: input.taskId || null,
          payload: {
            id: approvalId,
            title: input.title || 'Approval required',
            detail: input.detail || '',
            status: 'waiting',
            taskId: input.taskId || null,
            actionId,
            actionDigest: input.actionDigest || null
          }
        });
        return projection.approvals.get(approvalId);
      });
    },
    async exportTask(id) {
      return withLock(async () => {
        const task = projection.tasks.get(id);
        if (!task) throw httpError('Task not found', 404);
        return {
          version: 1,
          exportedAt: new Date().toISOString(),
          task: redactSecrets(task),
          events: projection.events.filter((event) => event.taskId === id).map((event) => redactSecrets(event))
        };
      });
    },
    async doctor() {
      return withLock(async () => ({
        ok: true,
        dataDir,
        eventsFile,
        eventCount: projection.events.length,
        taskCount: projection.tasks.size,
        approvalCount: projection.approvals.size,
        writable: true
      }));
    }
  };
}
