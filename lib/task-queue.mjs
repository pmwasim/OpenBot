export const TASK_QUEUE_LIMITS = Object.freeze({
  maxConcurrentTasks: 8,
  maxQueueDepth: 50
});

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export function createTaskQueue({ maxConcurrent = 1, maxQueueDepth = 8, run } = {}) {
  if (typeof run !== 'function') throw new Error('createTaskQueue requires a run callback.');
  const concurrency = positiveInteger(maxConcurrent, 1, TASK_QUEUE_LIMITS.maxConcurrentTasks);
  const depth = positiveInteger(maxQueueDepth, 8, TASK_QUEUE_LIMITS.maxQueueDepth);
  const active = new Map();
  const queued = [];
  const ids = new Set();

  function pump() {
    while (active.size < concurrency && queued.length) {
      const entry = queued.shift();
      active.set(entry.item.id, entry);
      Promise.resolve()
        .then(() => run(entry.item))
        .then(entry.resolve, entry.reject)
        .then(() => {
          active.delete(entry.item.id);
          ids.delete(entry.item.id);
          pump();
        });
    }
  }

  function enqueue(item) {
    const id = String(item?.id || '').trim();
    if (!id) throw Object.assign(new Error('A queued task id is required.'), { statusCode: 400 });
    if (ids.has(id)) throw Object.assign(new Error('Task is already running or queued.'), { statusCode: 409 });
    if (queued.length >= depth) throw Object.assign(new Error(`Task queue is full (${depth} waiting tasks).`), { statusCode: 429 });
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const entry = { item: { ...item, id }, resolve: resolvePromise, reject: rejectPromise, promise };
    ids.add(id);
    queued.push(entry);
    pump();
    return { state: active.has(id) ? 'started' : 'queued', promise };
  }

  return {
    enqueue,
    has(id) { return ids.has(String(id || '').trim()); },
    get activeCount() { return active.size; },
    get queuedCount() { return queued.length; },
    get maxConcurrent() { return concurrency; },
    get maxQueueDepth() { return depth; },
    canAccept() { return queued.length < depth; }
  };
}

export async function listRecoverableQueuedTasks(store) {
  if (!store?.listTasks || !store?.listEvents) throw new Error('listRecoverableQueuedTasks requires a task store.');
  const tasks = await store.listTasks();
  const recoverable = [];
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    const events = await store.listEvents({ taskId: task.id });
    const lastQueueEvent = [...events].reverse().find((event) => ['task.queued', 'task.admitted', 'task.released'].includes(event.type));
    if (lastQueueEvent?.type === 'task.queued') recoverable.push(task);
  }
  return recoverable;
}
