import { mkdir, open as openFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decide } from './policy.mjs';
import { redactSecrets } from './provider.mjs';
import { nextRoutineRun, parseRoutineSchedule, ROUTINE_LIMITS } from './routines.mjs';

export const SEED_STATE = {
  approvals: [],
  routines: [],
  bots: []
};

export const BOT_LIMITS = Object.freeze({ maxBots: 50, maxMessages: 40 });

const STATUS_TRANSITIONS = {
  start: { from: ['pending'], to: 'running' },
  pause: { from: ['pending', 'running', 'waiting_approval'], to: 'paused' },
  resume: { from: ['paused'], to: 'pending' },
  cancel: { from: ['pending', 'running', 'paused', 'waiting_approval'], to: 'cancelled' }
};

function emptyProjection() {
  return { events: [], tasks: new Map(), approvals: new Map(), routines: new Map(), bots: new Map(), actions: new Map(), memories: new Map(), skills: new Map(), seq: 0 };
}

function approvalFrom(payload, event) {
  return {
    id: payload.id,
    title: payload.title,
    detail: payload.detail,
    status: payload.status || 'waiting',
    taskId: payload.taskId || event.taskId || null,
    actionId: payload.actionId || null,
    argsDigest: payload.argsDigest || null,
    tool: payload.tool || null,
    boundArgs: payload.boundArgs || null,
    consumedAt: payload.consumedAt || null
  };
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
        provider: payload.provider || 'local-model',
        workspace: payload.workspace || 'local',
        eventSequence: event.seq,
        createdAt: event.ts,
        updatedAt: event.ts,
        prompt: payload.prompt || '',
        kind: payload.kind || 'plan',
        skill: payload.skill || null,
        botId: payload.botId || null
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
    case 'approval.seeded':
    case 'approval.created': {
      if (!payload.id) break;
      projection.approvals.set(payload.id, approvalFrom(payload, event));
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
    case 'approval.consumed': {
      const approval = projection.approvals.get(payload.id);
      if (approval) {
        approval.consumedAt = event.ts;
        approval.status = 'consumed';
      }
      break;
    }
    case 'routine.seeded':
    case 'routine.created':
    case 'routine.updated': {
      if (!payload.id) break;
      const previous = projection.routines.get(payload.id) || {};
      projection.routines.set(payload.id, {
        ...previous,
        id: payload.id,
        title: payload.title ?? previous.title,
        schedule: payload.schedule ?? previous.schedule,
        prompt: payload.prompt ?? previous.prompt ?? '',
        workspace: payload.workspace ?? previous.workspace ?? null,
        skill: payload.skill ?? previous.skill ?? null,
        botId: payload.botId ?? previous.botId ?? null,
        enabled: payload.enabled !== false,
        createdAt: previous.createdAt || event.ts,
        updatedAt: event.ts,
        nextRunAt: payload.nextRunAt ?? previous.nextRunAt ?? null,
        lastRunAt: payload.lastRunAt ?? previous.lastRunAt ?? null,
        lastStatus: payload.lastStatus ?? previous.lastStatus ?? null,
        lastTaskId: payload.lastTaskId ?? previous.lastTaskId ?? null,
        runs: Array.isArray(payload.runs) ? payload.runs.slice(-ROUTINE_LIMITS.maxRuns) : (previous.runs || [])
      });
      break;
    }
    case 'routine.deleted':
      if (payload.id) projection.routines.delete(payload.id);
      break;
    case 'routine.run': {
      const routine = projection.routines.get(payload.id);
      if (routine) routine.runs = [...(routine.runs || []), payload.run].slice(-ROUTINE_LIMITS.maxRuns);
      break;
    }
    case 'bot.seeded':
    case 'bot.created':
    case 'bot.updated': {
      if (!payload.id) break;
      const previous = projection.bots.get(payload.id) || {};
      projection.bots.set(payload.id, {
        ...previous,
        id: payload.id,
        name: payload.name ?? previous.name,
        role: payload.role ?? previous.role ?? '',
        instructions: payload.instructions ?? previous.instructions ?? '',
        workspace: payload.workspace ?? previous.workspace ?? null,
        skill: payload.skill ?? previous.skill ?? null,
        createdAt: previous.createdAt || event.ts,
        updatedAt: event.ts,
        lastTaskId: payload.lastTaskId ?? previous.lastTaskId ?? null,
        messages: Array.isArray(payload.messages) ? payload.messages.slice(-BOT_LIMITS.maxMessages) : (previous.messages || [])
      });
      break;
    }
    case 'bot.deleted':
      if (payload.id) projection.bots.delete(payload.id);
      break;
    case 'bot.message': {
      const bot = projection.bots.get(payload.id);
      if (bot && payload.message) {
        bot.messages = [...(bot.messages || []), payload.message].slice(-BOT_LIMITS.maxMessages);
        if (payload.message.taskId) bot.lastTaskId = payload.message.taskId;
      }
      break;
    }
    case 'memory.created':
    case 'memory.updated': {
      if (!payload.id || !payload.key || payload.value == null || !payload.workspace) break;
      const previous = projection.memories.get(payload.id) || {};
      projection.memories.set(payload.id, {
        ...previous,
        id: payload.id,
        key: payload.key,
        value: payload.value,
        workspace: payload.workspace,
        owner: payload.owner || previous.owner || 'operator',
        createdAt: previous.createdAt || event.ts,
        updatedAt: event.ts
      });
      break;
    }
    case 'memory.deleted': {
      if (payload.id) projection.memories.delete(payload.id);
      break;
    }
    case 'skill.created':
    case 'skill.updated': {
      if (!payload.id || !payload.name || !payload.instructions) break;
      const previous = projection.skills.get(payload.id) || {};
      projection.skills.set(payload.id, {
        ...previous,
        id: payload.id,
        name: payload.name,
        description: payload.description || '',
        instructions: payload.instructions,
        owner: payload.owner || previous.owner || 'operator',
        createdAt: previous.createdAt || event.ts,
        updatedAt: event.ts
      });
      break;
    }
    case 'skill.deleted': {
      if (payload.id) projection.skills.delete(payload.id);
      break;
    }
    case 'action.proposed':
    case 'action.executed':
    case 'action.denied':
    case 'action.failed': {
      const id = payload.actionId || payload.id;
      if (id) {
        const current = projection.actions.get(id) || { id };
        const status = event.type === 'action.executed' ? 'executed'
          : event.type === 'action.denied' ? 'denied'
          : event.type === 'action.failed' ? 'failed'
          : 'proposed';
        projection.actions.set(id, {
          ...current,
          id,
          taskId: event.taskId,
          tool: event.tool || payload.tool || current.tool,
          args: event.args ?? payload.args ?? current.args,
          workspace: payload.workspace || current.workspace,
          argsDigest: payload.argsDigest || current.argsDigest,
          policy: payload.policy || current.policy,
          approvalId: payload.approvalId || current.approvalId,
          status,
          diff: payload.diff || current.diff
        });
      }
      const actionTask = event.taskId ? projection.tasks.get(event.taskId) : null;
      if (actionTask) {
        actionTask.eventSequence = event.seq;
        actionTask.updatedAt = event.ts;
      }
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
          actionId: approval.actionId || null
        }
      });
    }
    for (const bot of state.bots || []) {
      await appendUnlocked({ type: 'bot.seeded', payload: { ...bot } });
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
      actor: partial.actor || null,
      tool: partial.tool || null,
      args: partial.args !== undefined ? partial.args : null,
      result: partial.result !== undefined ? partial.result : null,
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

  function getSkillUnlocked(idOrName) {
    const value = String(idOrName || '').trim();
    if (!value) return null;
    return projection.skills.get(value) || [...projection.skills.values()].find((skill) => skill.name.toLowerCase() === value.toLowerCase()) || null;
  }

  return {
    dataDir,
    eventsFile,
    async getState() {
      return withLock(async () => ({
        approvals: [...projection.approvals.values()],
        routines: [...projection.routines.values()],
        bots: [...projection.bots.values()].map((bot) => ({ ...bot, messages: undefined, messageCount: (bot.messages || []).length }))
      }));
    },
    async listBots() {
      return withLock(async () => [...projection.bots.values()]
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map((bot) => ({ ...bot, messages: undefined, messageCount: (bot.messages || []).length })));
    },
    async getBot(id) {
      return withLock(async () => projection.bots.get(id) || null);
    },
    async createBot(input = {}) {
      return withLock(async () => {
        if (projection.bots.size >= BOT_LIMITS.maxBots) throw httpError(`OpenBot supports at most ${BOT_LIMITS.maxBots} bots.`, 409);
        const name = redactSecrets(String(input.name || '').trim());
        const role = redactSecrets(String(input.role || '').trim());
        const instructions = redactSecrets(String(input.instructions || '').trim());
        const workspace = String(input.workspace || '').trim();
        if (!name || name.length > 80) throw httpError('Bot name must be between 1 and 80 characters.', 400);
        if (role.length > 400) throw httpError('Bot role must be 400 characters or fewer.', 400);
        if (!instructions || instructions.length > 8000) throw httpError('Bot instructions must be between 1 and 8000 characters.', 400);
        if (!workspace || workspace === 'local') throw httpError('An explicit workspace path is required for a bot.', 400);
        if ([...projection.bots.values()].some((bot) => bot.name.toLowerCase() === name.toLowerCase())) throw httpError('A bot with that name already exists.', 409);
        if (input.skill && !(await getSkillUnlocked(input.skill))) throw httpError('Local skill not found.', 404);
        const id = input.id || `bot-${randomUUID()}`;
        const payload = { id, name, role, instructions, workspace, skill: input.skill || null, lastTaskId: null, messages: [] };
        await appendUnlocked({ type: 'bot.created', actor: input.owner || 'operator', payload });
        return { bot: projection.bots.get(id) };
      });
    },
    async updateBot(id, patch = {}) {
      return withLock(async () => {
        const current = projection.bots.get(id);
        if (!current) throw httpError('Bot not found.', 404);
        const next = { ...current };
        if (patch.name !== undefined) next.name = redactSecrets(String(patch.name).trim());
        if (patch.role !== undefined) next.role = redactSecrets(String(patch.role).trim());
        if (patch.instructions !== undefined) next.instructions = redactSecrets(String(patch.instructions).trim());
        if (patch.workspace !== undefined) next.workspace = String(patch.workspace).trim();
        if (patch.skill !== undefined) next.skill = patch.skill || null;
        if (!next.name || next.name.length > 80) throw httpError('Bot name must be between 1 and 80 characters.', 400);
        if (next.role.length > 400) throw httpError('Bot role must be 400 characters or fewer.', 400);
        if (!next.instructions || next.instructions.length > 8000) throw httpError('Bot instructions must be between 1 and 8000 characters.', 400);
        if (!next.workspace || next.workspace === 'local') throw httpError('An explicit workspace path is required for a bot.', 400);
        if ([...projection.bots.values()].some((bot) => bot.id !== id && bot.name.toLowerCase() === next.name.toLowerCase())) throw httpError('A bot with that name already exists.', 409);
        if (next.skill && !(await getSkillUnlocked(next.skill))) throw httpError('Local skill not found.', 404);
        await appendUnlocked({ type: 'bot.updated', actor: 'operator', payload: { ...next, messages: undefined } });
        return { bot: projection.bots.get(id) };
      });
    },
    async deleteBot(id) {
      return withLock(async () => {
        if (!projection.bots.has(id)) throw httpError('Bot not found.', 404);
        await appendUnlocked({ type: 'bot.deleted', actor: 'operator', payload: { id } });
        return { id, deleted: true };
      });
    },
    async recordBotMessage(id, input = {}) {
      return withLock(async () => {
        if (!projection.bots.has(id)) throw httpError('Bot not found.', 404);
        const role = String(input.role || '').trim().toLowerCase();
        const content = redactSecrets(String(input.content || '').trim());
        if (!['user', 'assistant'].includes(role)) throw httpError('Bot message role must be user or assistant.', 400);
        if (!content || content.length > 12000) throw httpError('Bot message must be between 1 and 12000 characters.', 400);
        const message = { id: input.id || `message-${randomUUID()}`, role, content, taskId: input.taskId || null, createdAt: new Date().toISOString() };
        await appendUnlocked({ type: 'bot.message', actor: input.actor || 'agent', payload: { id, message } });
        return message;
      });
    },
    async listRoutines() {
      return withLock(async () => [...projection.routines.values()].sort((a, b) => String(a.title).localeCompare(String(b.title))));
    },
    async getRoutine(id) {
      return withLock(async () => projection.routines.get(id) || null);
    },
    async createRoutine(input = {}) {
      return withLock(async () => {
        if (projection.routines.size >= ROUTINE_LIMITS.maxRoutines) throw httpError(`OpenBot supports at most ${ROUTINE_LIMITS.maxRoutines} routines.`, 409);
        const title = redactSecrets(String(input.title || '').trim());
        const schedule = parseRoutineSchedule(input.schedule).value;
        const prompt = redactSecrets(String(input.prompt || '').trim());
        const workspace = String(input.workspace || '').trim();
        if (!title || title.length > 120) throw httpError('Routine title must be between 1 and 120 characters.', 400);
        if (!prompt || prompt.length > 4000) throw httpError('Routine prompt must be between 1 and 4000 characters.', 400);
        if (!workspace || workspace === 'local') throw httpError('An explicit workspace path is required for a routine.', 400);
        if (input.botId && !projection.bots.has(input.botId)) throw httpError('Bot not found.', 404);
        if (input.skill && !(await getSkillUnlocked(input.skill))) throw httpError('Local skill not found.', 404);
        const id = input.id || `routine-${randomUUID()}`;
        const enabled = input.enabled !== false;
        const payload = { id, title, schedule, prompt, workspace, skill: input.skill || null, botId: input.botId || null, enabled, nextRunAt: enabled ? nextRoutineRun(schedule) : null };
        await appendUnlocked({ type: 'routine.created', actor: input.owner || 'operator', payload });
        return { routine: projection.routines.get(id) };
      });
    },
    async updateRoutine(id, patch = {}) {
      return withLock(async () => {
        const current = projection.routines.get(id);
        if (!current) throw httpError('Routine not found.', 404);
        const next = { ...current };
        if (patch.title !== undefined) next.title = redactSecrets(String(patch.title).trim());
        if (patch.schedule !== undefined) next.schedule = parseRoutineSchedule(patch.schedule).value;
        if (patch.prompt !== undefined) next.prompt = redactSecrets(String(patch.prompt).trim());
        if (patch.workspace !== undefined) next.workspace = String(patch.workspace).trim();
        if (patch.skill !== undefined) next.skill = patch.skill || null;
        if (patch.botId !== undefined) next.botId = patch.botId || null;
        if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
        if (patch.lastRunAt !== undefined) next.lastRunAt = patch.lastRunAt;
        if (patch.lastStatus !== undefined) next.lastStatus = patch.lastStatus;
        if (patch.lastTaskId !== undefined) next.lastTaskId = patch.lastTaskId;
        if (patch.nextRunAt !== undefined) next.nextRunAt = patch.nextRunAt;
        if (!next.title || next.title.length > 120) throw httpError('Routine title must be between 1 and 120 characters.', 400);
        if (!next.prompt || next.prompt.length > 4000) throw httpError('Routine prompt must be between 1 and 4000 characters.', 400);
        if (!next.workspace || next.workspace === 'local') throw httpError('An explicit workspace path is required for a routine.', 400);
        if (next.botId && !projection.bots.has(next.botId)) throw httpError('Bot not found.', 404);
        if (next.skill && !(await getSkillUnlocked(next.skill))) throw httpError('Local skill not found.', 404);
        if (patch.schedule !== undefined || patch.enabled !== undefined) next.nextRunAt = next.enabled ? nextRoutineRun(next.schedule) : null;
        await appendUnlocked({ type: 'routine.updated', actor: 'operator', payload: { ...next, runs: undefined } });
        return { routine: projection.routines.get(id) };
      });
    },
    async deleteRoutine(id) {
      return withLock(async () => {
        if (!projection.routines.has(id)) throw httpError('Routine not found.', 404);
        await appendUnlocked({ type: 'routine.deleted', actor: 'operator', payload: { id } });
        return { id, deleted: true };
      });
    },
    async recordRoutineRun(id, run = {}) {
      return withLock(async () => {
        if (!projection.routines.has(id)) throw httpError('Routine not found.', 404);
        const safeRun = {
          runId: String(run.runId || `run-${randomUUID()}`).slice(0, 120),
          taskId: run.taskId || null,
          status: String(run.status || 'unknown').slice(0, 40),
          startedAt: run.startedAt || new Date().toISOString(),
          finishedAt: run.finishedAt || new Date().toISOString(),
          error: run.error ? redactSecrets(String(run.error)).slice(0, 1000) : null
        };
        await appendUnlocked({ type: 'routine.run', actor: 'scheduler', payload: { id, run: safeRun } });
        return safeRun;
      });
    },
    async listMemories(filter = {}) {
      return withLock(async () => {
        let memories = [...projection.memories.values()];
        if (filter.workspace) memories = memories.filter((memory) => memory.workspace === filter.workspace);
        return memories.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      });
    },
    async createMemory(input = {}) {
      return withLock(async () => {
        const workspace = String(input.workspace || '').trim();
        const key = String(input.key || '').trim();
        const value = redactSecrets(String(input.value || '').trim());
        if (!workspace || workspace === 'local') throw httpError('An explicit workspace path is required for memory.', 400);
        if (!key || key.length > 120) throw httpError('Memory key must be between 1 and 120 characters.', 400);
        if (!value || value.length > 4000) throw httpError('Memory value must be between 1 and 4000 characters.', 400);
        const id = input.id || `memory-${randomUUID()}`;
        await appendUnlocked({
          type: 'memory.created',
          actor: input.owner || 'operator',
          payload: { id, key, value, workspace, owner: input.owner || 'operator' }
        });
        return { memory: projection.memories.get(id) };
      });
    },
    async updateMemory(id, patch = {}) {
      return withLock(async () => {
        const current = projection.memories.get(id);
        if (!current) throw httpError('Memory not found.', 404);
        const next = { ...current };
        if (patch.key !== undefined) next.key = String(patch.key).trim();
        if (patch.value !== undefined) next.value = redactSecrets(String(patch.value).trim());
        if (!next.key || next.key.length > 120) throw httpError('Memory key must be between 1 and 120 characters.', 400);
        if (!next.value || next.value.length > 4000) throw httpError('Memory value must be between 1 and 4000 characters.', 400);
        await appendUnlocked({ type: 'memory.updated', actor: 'operator', payload: { ...next } });
        return { memory: projection.memories.get(id) };
      });
    },
    async deleteMemory(id) {
      return withLock(async () => {
        if (!projection.memories.has(id)) throw httpError('Memory not found.', 404);
        await appendUnlocked({ type: 'memory.deleted', actor: 'operator', payload: { id } });
        return { id, deleted: true };
      });
    },
    async listSkills() {
      return withLock(async () => [...projection.skills.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))));
    },
    async getSkill(idOrName) {
      return withLock(async () => {
        return getSkillUnlocked(idOrName);
      });
    },
    async createSkill(input = {}) {
      return withLock(async () => {
        const name = String(input.name || '').trim();
        const description = redactSecrets(String(input.description || '').trim());
        const instructions = redactSecrets(String(input.instructions || input.content || '').trim());
        if (!name || name.length > 120) throw httpError('Skill name must be between 1 and 120 characters.', 400);
        if (description.length > 400) throw httpError('Skill description must be 400 characters or fewer.', 400);
        if (!instructions || instructions.length > 8000) throw httpError('Skill instructions must be between 1 and 8000 characters.', 400);
        if ([...projection.skills.values()].some((skill) => skill.name.toLowerCase() === name.toLowerCase())) throw httpError('A skill with that name already exists.', 409);
        const id = input.id || `skill-${randomUUID()}`;
        await appendUnlocked({
          type: 'skill.created',
          actor: input.owner || 'operator',
          payload: { id, name, description, instructions, owner: input.owner || 'operator' }
        });
        return { skill: projection.skills.get(id) };
      });
    },
    async updateSkill(id, patch = {}) {
      return withLock(async () => {
        const current = projection.skills.get(id);
        if (!current) throw httpError('Skill not found.', 404);
        const next = { ...current };
        if (patch.name !== undefined) next.name = String(patch.name).trim();
        if (patch.description !== undefined) next.description = redactSecrets(String(patch.description).trim());
        if (patch.instructions !== undefined || patch.content !== undefined) next.instructions = redactSecrets(String(patch.instructions ?? patch.content).trim());
        if (!next.name || next.name.length > 120) throw httpError('Skill name must be between 1 and 120 characters.', 400);
        if (next.description.length > 400) throw httpError('Skill description must be 400 characters or fewer.', 400);
        if (!next.instructions || next.instructions.length > 8000) throw httpError('Skill instructions must be between 1 and 8000 characters.', 400);
        if ([...projection.skills.values()].some((skill) => skill.id !== id && skill.name.toLowerCase() === next.name.toLowerCase())) throw httpError('A skill with that name already exists.', 409);
        await appendUnlocked({ type: 'skill.updated', actor: 'operator', payload: { ...next } });
        return { skill: projection.skills.get(id) };
      });
    },
    async deleteSkill(id) {
      return withLock(async () => {
        if (!projection.skills.has(id)) throw httpError('Skill not found.', 404);
        await appendUnlocked({ type: 'skill.deleted', actor: 'operator', payload: { id } });
        return { id, deleted: true };
      });
    },
    async listTasks() {
      return withLock(async () => [...projection.tasks.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
    },
    async getTask(id) {
      return withLock(async () => projection.tasks.get(id) || null);
    },
    async getApproval(id) {
      return withLock(async () => projection.approvals.get(id) || null);
    },
    async getApprovalByActionId(actionId) {
      return withLock(async () => [...projection.approvals.values()].find((item) => item.actionId === actionId) || null);
    },
    async getAction(id) {
      return withLock(async () => projection.actions.get(id) || null);
    },
    async listActions(filter = {}) {
      return withLock(async () => {
        let actions = [...projection.actions.values()];
        if (filter.taskId) actions = actions.filter((action) => action.taskId === filter.taskId);
        return actions;
      });
    },
    async appendEvent(partial) {
      return withLock(async () => appendUnlocked(partial));
    },
    async exportAudit(taskId) {
      return withLock(async () => {
        const task = projection.tasks.get(taskId) || null;
        if (!task) throw httpError('Task not found', 404);
        return {
          task,
          events: projection.events.filter((event) => event.taskId === taskId),
          actions: [...projection.actions.values()].filter((action) => action.taskId === taskId),
          approvals: [...projection.approvals.values()].filter((item) => item.taskId === taskId),
          exportedAt: new Date().toISOString()
        };
      });
    },
    async listEvents(filter = {}) {
      return withLock(async () => {
        let events = projection.events;
        if (filter.taskId) events = events.filter((event) => event.taskId === filter.taskId);
        if (filter.afterSeq !== undefined) events = events.filter((event) => Number(event.seq) > Number(filter.afterSeq));
        if (filter.limit) events = events.slice(-Number(filter.limit));
        return events;
      });
    },
    async append(partial) {
      return withLock(async () => appendUnlocked(partial));
    },
    async createTask(input = {}) {
      return withLock(async () => {
        const id = input.id || `task-${randomUUID()}`;
        const kind = input.kind || 'plan';
        const decision = decide({ kind, taskId: id });
        if (decision === 'deny') throw httpError(`Policy denied action kind "${kind}".`, 403);
        const bot = input.botId ? projection.bots.get(input.botId) : null;
        if (input.botId && !bot) throw httpError('Bot not found.', 404);
        const workspace = input.workspace || bot?.workspace || 'local';
        if (bot && workspace !== bot.workspace) throw httpError('Bot workspace does not match the requested workspace.', 409);
        const status = decision === 'require_approval' ? 'waiting_approval' : 'pending';
        await appendUnlocked({
          type: 'task.created',
          taskId: id,
          payload: {
            status,
            owner: input.owner || 'local',
            provider: input.provider || 'local-model',
            workspace,
            prompt: redactSecrets(String(input.prompt || '')),
            kind,
            skill: input.skill || null,
            botId: input.botId || null,
            policy: decision
          }
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
              title: redactSecrets(input.title || `Approval required: ${kind}`),
              detail: redactSecrets(input.detail || input.prompt || `Action "${kind}" requires approval before execution.`),
              status: 'waiting',
              taskId: id,
              actionId
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
    async decideApproval(id, decision) {
      return withLock(async () => {
        if (!['approved', 'rejected'].includes(decision)) throw httpError('Invalid approval request', 400);
        const item = projection.approvals.get(id);
        if (!item) throw httpError('Invalid approval request', 400);
        if (item.status !== 'waiting') throw httpError('Approval is no longer waiting.', 409);
        const args = { id, decision, actionId: item.actionId || null };
        const result = { ok: true, status: decision };
        await appendUnlocked({
          type: 'approval.decided',
          taskId: item.taskId,
          actor: 'operator',
          tool: item.tool || 'approval.decide',
          args,
          result,
          payload: { id, decision, actionId: item.actionId || null, actor: 'operator', tool: item.tool || 'approval.decide', args, result }
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
    async consumeApproval({ id, argsDigest, actionId, taskId } = {}) {
      return withLock(async () => {
        const item = projection.approvals.get(id);
        if (!item) throw httpError('Approval not found.', 404);
        if (item.status === 'consumed' || item.consumedAt) throw httpError('Approval already consumed.', 409);
        if (item.status !== 'approved') throw httpError('Approval is not approved.', 403);
        if (!item.argsDigest) throw httpError('Approval is not bound to an action.', 403);
        if (item.argsDigest !== argsDigest) throw httpError('Approval is bound to a different action.', 403);
        if (taskId && item.taskId && item.taskId !== taskId) throw httpError('Approval is bound to a different task.', 403);
        if (actionId && item.actionId && item.actionId !== actionId) {
          throw httpError('Approval is bound to a different action.', 403);
        }
        const args = { id, argsDigest, actionId: item.actionId || null };
        const result = { ok: true, consumed: true };
        await appendUnlocked({
          type: 'approval.consumed',
          taskId: item.taskId,
          actor: 'openbot',
          tool: item.tool || 'approval.consume',
          args,
          result,
          payload: { id, argsDigest, actionId: item.actionId || null, actor: 'openbot', tool: item.tool || 'approval.consume', args, result }
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
            detail: redactSecrets(input.detail || ''),
            status: 'waiting',
            taskId: input.taskId || null,
            actionId,
            argsDigest: input.argsDigest || null,
            tool: input.tool || null,
            boundArgs: redactSecrets(input.boundArgs || null)
          }
        });
        return projection.approvals.get(approvalId);
      });
    },
    async listActions(filter = {}) {
      return withLock(async () => {
        let events = projection.events.filter((event) => String(event.type || '').startsWith('action.'));
        if (filter.taskId) events = events.filter((event) => event.taskId === filter.taskId);
        return events;
      });
    },
    async getApprovalByActionId(actionId) {
      return withLock(async () => {
        if (!actionId) return null;
        return [...projection.approvals.values()].find((item) => item.actionId === actionId) || null;
      });
    },
    async exportAudit(taskId) {
      return withLock(async () => {
        const task = projection.tasks.get(taskId) || null;
        const events = projection.events.filter((event) => event.taskId === taskId);
        return { task, events };
      });
    },
    async appendEvent(partial) {
      return withLock(async () => appendUnlocked(partial));
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
