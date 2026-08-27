const MAX_RUNS = 20;

function invalidSchedule(value) {
  const error = new Error(`Invalid routine schedule "${value}". Use "every 15m" or "daily 09:30".`);
  error.statusCode = 400;
  return error;
}

export function parseRoutineSchedule(input) {
  const value = String(input || '').trim().toLowerCase();
  const interval = value.match(/^every\s+([1-9]\d*)\s*([smhd])$/);
  if (interval) {
    const amount = Number(interval[1]);
    const unit = interval[2];
    const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    const intervalMs = amount * multiplier;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 15_000 || intervalMs > 31_536_000_000) throw invalidSchedule(input);
    return { kind: 'interval', value, intervalMs };
  }
  const daily = value.match(/^daily(?:\s+(\d{2}):(\d{2}))?$/);
  if (daily) {
    const hour = Number(daily[1] || 0);
    const minute = Number(daily[2] || 0);
    if (hour > 23 || minute > 59) throw invalidSchedule(input);
    return { kind: 'daily', value: `daily ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, hour, minute };
  }
  throw invalidSchedule(input);
}

export function nextRoutineRun(schedule, from = new Date()) {
  const parsed = typeof schedule === 'string' ? parseRoutineSchedule(schedule) : schedule;
  const base = new Date(from);
  if (Number.isNaN(base.getTime())) throw new Error('Routine schedule base time is invalid.');
  if (parsed.kind === 'interval') return new Date(base.getTime() + parsed.intervalMs).toISOString();
  const next = new Date(base);
  next.setHours(parsed.hour, parsed.minute, 0, 0);
  if (next.getTime() <= base.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

export const ROUTINE_LIMITS = Object.freeze({ maxRoutines: 50, maxRuns: MAX_RUNS });

export function createRoutineScheduler({ store, runRoutine, tickMs = 15_000, now = () => new Date() } = {}) {
  if (!store?.listRoutines || !store?.recordRoutineRun || !runRoutine) throw new Error('createRoutineScheduler requires a routine store and runRoutine callback.');
  let timer = null;
  const running = new Set();

  async function execute(routine, reason = 'scheduled') {
    if (!routine?.enabled || running.has(routine.id)) return { skipped: true, reason: 'already_running_or_disabled' };
    running.add(routine.id);
    const startedAt = now().toISOString();
    try {
      const result = await runRoutine(routine, { reason });
      await store.recordRoutineRun(routine.id, {
        runId: `run-${Date.now()}-${routine.id}`,
        taskId: result?.taskId || null,
        status: result?.status || 'completed',
        startedAt,
        finishedAt: now().toISOString(),
        error: result?.error || null
      });
      await store.updateRoutine(routine.id, { lastRunAt: now().toISOString(), lastStatus: result?.status || 'completed', lastTaskId: result?.taskId || null, nextRunAt: nextRoutineRun(routine.schedule, now()) });
      return result;
    } catch (error) {
      await store.recordRoutineRun(routine.id, {
        runId: `run-${Date.now()}-${routine.id}`,
        taskId: null,
        status: 'failed',
        startedAt,
        finishedAt: now().toISOString(),
        error: error.message
      });
      await store.updateRoutine(routine.id, { lastRunAt: now().toISOString(), lastStatus: 'failed', lastTaskId: null, nextRunAt: nextRoutineRun(routine.schedule, now()) });
      return { status: 'failed', error: error.message };
    } finally {
      running.delete(routine.id);
    }
  }

  async function tick() {
    const current = now();
    const routines = await store.listRoutines();
    for (const routine of routines) {
      if (!routine.enabled || !routine.nextRunAt || new Date(routine.nextRunAt).getTime() > current.getTime()) continue;
      void execute(routine, 'scheduled');
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick().catch(() => {}); }, tickMs);
      timer.unref?.();
      void tick().catch(() => {});
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    runNow(id) {
      return store.getRoutine(id).then((routine) => {
        if (!routine) {
          const error = new Error('Routine not found.');
          error.statusCode = 404;
          throw error;
        }
        return execute({ ...routine, enabled: true }, 'manual');
      });
    },
    isRunning(id) { return running.has(id); }
  };
}
