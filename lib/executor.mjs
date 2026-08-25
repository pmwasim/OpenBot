import { join } from 'node:path';

function executorError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function workspaceId(taskId) {
  const value = String(taskId).replace(/[^A-Za-z0-9_-]/g, '_');
  return value || 'task';
}

export function createExecutor({ store, workers }) {
  if (!store || !workers) throw new Error('createExecutor requires store and workers.');
  const active = new Map();
  const listeners = new Map();
  let shuttingDown = false;

  async function record(taskId, type, payload = {}) {
    const event = await store.appendTaskEvent(taskId, type, payload);
    for (const listener of listeners.get(taskId) || []) {
      try { listener(event); } catch { /* a client listener cannot break the executor */ }
    }
    return event;
  }

  async function runTask(taskId, state) {
    const task = await store.getTask(taskId);
    if (!task) throw executorError('Task not found', 404);
    if (task.status !== 'pending') throw executorError(`Task is not pending; it is ${task.status}.`, 409);
    if (!task.action) {
      await record(taskId, 'task.execution_result', { ok: true, output: 'No executable action was supplied; task completed as a plan.' });
      await store.appendTaskEvent(taskId, 'task.status', { status: 'completed', action: 'complete' });
      return store.getTask(taskId);
    }

    const attempt = (Number(task.executionAttempt) || 0) + 1;
    await record(taskId, 'task.execution_started', { attempt, actionDigest: task.actionDigest });
    const workspace = join(store.dataDir, 'workspaces', workspaceId(taskId));
    try {
      const result = await workers.run(task.action, { taskId, workspace, signal: state.controller.signal });
      if (state.shutdownRequested) {
        await record(taskId, 'task.recoverable', { reason: 'daemon shutdown interrupted the worker' });
        return store.getTask(taskId);
      }
      await record(taskId, 'task.execution_result', { ok: true, output: result.output, metadata: result.metadata });
      await store.appendTaskEvent(taskId, 'task.status', { status: 'completed', action: 'complete' });
      return store.getTask(taskId);
    } catch (error) {
      if (state.shutdownRequested) {
        await record(taskId, 'task.recoverable', { reason: 'daemon shutdown interrupted the worker' });
        return store.getTask(taskId);
      }
      if (state.cancelRequested) {
        await record(taskId, 'task.execution_error', { statusCode: 499, message: 'Task cancelled before the worker completed.' });
        await store.appendTaskEvent(taskId, 'task.status', { status: 'cancelled', action: 'cancel' });
        return store.getTask(taskId);
      }
      await record(taskId, 'task.execution_error', { statusCode: error.statusCode || 500, message: error.message || 'Worker failed.', output: error.output });
      await store.appendTaskEvent(taskId, 'task.status', { status: 'failed', action: 'error' });
      return store.getTask(taskId);
    }
  }

  return {
    active,
    onTask(taskId, listener) {
      if (!listeners.has(taskId)) listeners.set(taskId, new Set());
      listeners.get(taskId).add(listener);
      return () => listeners.get(taskId)?.delete(listener);
    },
    async start(taskId) {
      if (shuttingDown) throw executorError('Executor is shutting down.', 503);
      if (active.has(taskId)) throw executorError('Task is already running.', 409);
      const state = { controller: new AbortController(), cancelRequested: false, shutdownRequested: false, promise: null };
      active.set(taskId, state);
      try {
        const task = await store.getTask(taskId);
        if (!task) throw executorError('Task not found', 404);
        if (task.status !== 'pending') throw executorError(`Task is not pending; it is ${task.status}.`, 409);
        state.promise = runTask(taskId, state).finally(() => { if (active.get(taskId) === state) active.delete(taskId); });
        return state.promise;
      } catch (error) {
        if (active.get(taskId) === state) active.delete(taskId);
        throw error;
      }
    },
    async cancel(taskId) {
      const state = active.get(taskId);
      if (!state) return store.setTaskStatus(taskId, 'cancel');
      state.cancelRequested = true;
      state.controller.abort();
      return state.promise;
    },
    async pause(taskId) {
      const state = active.get(taskId);
      if (!state) return store.setTaskStatus(taskId, 'pause');
      state.cancelRequested = true;
      state.controller.abort();
      const result = await state.promise;
      await store.appendTaskEvent(taskId, 'task.status', { status: 'paused', action: 'pause' });
      return result;
    },
    async shutdown() {
      shuttingDown = true;
      const running = [...active.values()];
      for (const state of running) {
        state.shutdownRequested = true;
        state.controller.abort();
      }
      await Promise.allSettled(running.map((state) => state.promise));
    }
  };
}
