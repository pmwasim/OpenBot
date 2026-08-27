import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { loadConfig, publicConfig } from './lib/config.mjs';
import { assertBindHost, hasBearerToken } from './lib/loopback.mjs';
import { createProviderHub, redactSecrets } from './lib/provider.mjs';
import { openStore } from './lib/store.mjs';
import { createEngine } from './lib/engine.mjs';
import { createAgentController } from './lib/agent.mjs';
import { createRoutineScheduler } from './lib/routines.mjs';
import { claimDaemonPid, releaseDaemonPid } from './lib/daemon.mjs';
import { taskResultView } from './lib/task-result.mjs';
import { redactArtifactContent, taskArtifactInventory, TASK_ARTIFACT_LIMITS } from './lib/task-artifacts.mjs';
import { fileRead } from './lib/workers/file.mjs';

const config = loadConfig();
const maxBodyBytes = 64 * 1024;
const publicDir = join(config.root, 'public');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png'
};

let bind;
try {
  bind = assertBindHost(config.host, process.env);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (bind.overridden && !process.env.OPENBOT_AUTH_TOKEN) {
  console.error('Refusing protected LAN mode without OPENBOT_AUTH_TOKEN. Keep OpenBot on loopback or set a strong local bearer token.');
  process.exit(1);
}
if (bind.overridden) console.warn(`WARNING: HOST=${config.host} is not loopback. Every request requires Authorization: Bearer <OPENBOT_AUTH_TOKEN>.`);

try {
  await claimDaemonPid(config.pidFile);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const store = await openStore({ dataDir: config.dataDir });
const providers = createProviderHub(process.env, { modelUrl: config.modelUrl, modelProtocol: config.modelProtocol, remoteBaseUrl: config.remoteBaseUrl });
const localModel = providers.localModel;

function fixtureAgentProvider(raw) {
  let replies;
  try { replies = JSON.parse(raw); }
  catch { replies = []; }
  let index = 0;
  return {
    async chatStructured({ model, signal }) {
      if (model === 'fixture-async') return { ok: true, status: 200, model, reply: JSON.stringify({ reply: 'The asynchronous task completed.' }) };
      if (model === 'fixture-slow') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Slow fixture timed out.')), 30000);
          const abort = () => {
            clearTimeout(timer);
            const error = new Error('Slow fixture aborted.');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }
      if (index >= replies.length) return { ok: false, status: 502, model, error: 'Test agent response queue is exhausted.' };
      return { ok: true, status: 200, model: model || 'fixture', reply: replies[index++] };
    }
  };
}

const agentProvider = process.env.OPENBOT_TEST_AGENT_RESPONSES
  ? fixtureAgentProvider(process.env.OPENBOT_TEST_AGENT_RESPONSES)
  : localModel;
const activeTaskControllers = new Map();

function resolveAgentProvider(providerName = 'local-model') {
  const selected = String(providerName || 'local-model').trim() || 'local-model';
  if (process.env.OPENBOT_TEST_AGENT_RESPONSES) return { name: selected, provider: agentProvider };
  try { return { name: selected, provider: providers.get(selected) }; }
  catch (error) { throw Object.assign(error, { statusCode: error.statusCode || 400 }); }
}

async function resolveAgentModel(requested, providerName = 'local-model') {
  const resolved = resolveAgentProvider(providerName);
  if (process.env.OPENBOT_TEST_AGENT_RESPONSES) return requested || 'fixture';
  let tags;
  try { tags = await resolved.provider.tags(); }
  catch { throw Object.assign(new Error(`The ${resolved.name} provider is not available or did not return its model list.`), { statusCode: 503 }); }
  if (!tags.ok) throw Object.assign(new Error(`The ${resolved.name} provider is not available or did not return its model list.`), { statusCode: 503 });
  const selected = requested || tags.models[0];
  if (!selected) throw Object.assign(new Error(`The ${resolved.name} provider has no model available yet.`), { statusCode: 503 });
  if (!tags.models.includes(selected)) throw Object.assign(new Error(`Requested model is not available from ${resolved.name}.`), { statusCode: 400 });
  return selected;
}

async function resolveBot(botId) {
  if (!botId) return null;
  const bot = await store.getBot(botId);
  if (!bot) throw Object.assign(new Error('Bot not found.'), { statusCode: 404 });
  return bot;
}

async function runAgentTask({ taskId, prompt, workspace, model, providerName, maxTurns, approvalId, skill, botId, recordBotConversation = false }) {
  const isNewTask = !taskId;
  const existingTask = taskId ? await store.getTask(taskId) : null;
  const selectedProviderName = String(providerName || existingTask?.provider || 'local-model').trim() || 'local-model';
  if (existingTask && providerName && existingTask.provider !== selectedProviderName) throw Object.assign(new Error('Task provider does not match the requested provider.'), { statusCode: 409 });
  const selectedProvider = resolveAgentProvider(selectedProviderName).provider;
  const selectedPrompt = String(prompt || existingTask?.prompt || '').trim();
  if (!selectedPrompt) throw Object.assign(new Error('A task prompt is required.'), { statusCode: 400 });
  const bot = await resolveBot(botId || existingTask?.botId);
  const selectedWorkspace = workspace || bot?.workspace;
  if (!selectedWorkspace || selectedWorkspace === 'local') throw Object.assign(new Error('An explicit workspace path is required for agent work.'), { statusCode: 400 });
  if (bot && selectedWorkspace !== bot.workspace) throw Object.assign(new Error('Bot workspace does not match the requested workspace.'), { statusCode: 409 });
  if (skill && store.getSkill) {
    const selectedSkill = await store.getSkill(skill);
    if (!selectedSkill) throw Object.assign(new Error(`Local skill not found: ${skill}`), { statusCode: 404 });
    skill = selectedSkill.id;
  }
  if (isNewTask) {
    const created = await store.createTask({
      prompt: selectedPrompt,
      kind: 'plan',
      provider: selectedProviderName,
      workspace: selectedWorkspace,
      owner: 'agent',
      skill: skill || null,
      botId: bot?.id || null
    });
    taskId = created.task.id;
  }
  if (activeTaskControllers.has(taskId)) throw Object.assign(new Error('Task is already running.'), { statusCode: 409 });
  const abortController = new AbortController();
  activeTaskControllers.set(taskId, abortController);
  try {
    if (!existingTask || existingTask.status === 'pending') {
      try {
        await store.setTaskStatus(taskId, 'start');
      } catch (error) {
        const current = await store.getTask(taskId);
        if (['paused', 'cancelled'].includes(current?.status)) return { botId: bot?.id || null, taskId, status: current.status, reply: null, actions: [], approvals: [], turns: 0 };
        throw error;
      }
    }
    const controller = createAgentController({
      store,
      provider: selectedProvider,
      providerName: selectedProviderName,
      engine: createEngine({ store, actor: 'agent' }),
      actor: 'agent',
      maxTurns: Math.min(Number(maxTurns) > 0 ? Number(maxTurns) : config.agentMaxTurns, config.agentMaxTurns),
      maxActions: config.agentMaxActions,
      maxContextChars: config.agentContextChars
    });
    const result = await controller.run({ taskId, prompt: selectedPrompt, workspace: selectedWorkspace, model, approvalId, skill, bot, signal: abortController.signal });
    if (bot && (isNewTask || recordBotConversation)) {
      await store.recordBotMessage(bot.id, { role: 'user', content: selectedPrompt, taskId });
      await store.recordBotMessage(bot.id, {
        role: 'assistant',
        content: result.reply || (result.status === 'waiting_approval' ? 'Waiting for approval before continuing.' : `Task stopped with status: ${result.status}.`),
        taskId: result.taskId
      });
    }
    return { botId: bot?.id || null, ...result };
  } finally {
    if (activeTaskControllers.get(taskId) === abortController) activeTaskControllers.delete(taskId);
  }
}

async function runTaskInBackground(task) {
  try {
    const selected = await resolveAgentModel(task.model, task.provider);
    await runAgentTask({ taskId: task.id, prompt: task.prompt, workspace: task.workspace, model: selected, providerName: task.provider, maxTurns: task.maxTurns, approvalId: task.approvalId, skill: task.skill, botId: task.botId, recordBotConversation: task.recordBotConversation });
  } catch (error) {
    const current = await store.getTask(task.id).catch(() => null);
    if (current && ['pending', 'running'].includes(current.status)) {
      await store.append({ type: 'task.status', taskId: task.id, actor: 'daemon', payload: { status: 'failed', reason: 'background_error', error: redactSecrets(error.message || 'Background task failed.') } }).catch(() => {});
    }
  }
}

const routineScheduler = createRoutineScheduler({
  store,
  runRoutine: async (routine) => {
    const model = await resolveAgentModel();
    return runAgentTask({ prompt: routine.prompt, workspace: routine.workspace, model, providerName: 'local-model', skill: routine.skill, botId: routine.botId });
  }
});

function agentHttpStatus(result) {
  return result.status === 'completed' || result.status === 'waiting_approval' ? 200
    : result.status === 'denied' ? 403
    : result.status === 'failed' ? 502
    : 422;
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

function downloadJson(res, filename, body) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

const terminalTaskStatuses = new Set(['completed', 'failed', 'cancelled']);

function writeSse(res, event, data) {
  if (res.writableEnded) return false;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return true;
}

async function streamTaskEvents(req, res, task, afterSeq) {
  let closed = false;
  let ready = false;
  let lastSeq = afterSeq;
  let queuedSeq = afterSeq;
  let pending = [];
  let delivery = Promise.resolve();
  let unsubscribe = () => {};
  let heartbeat;
  let expiry;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    clearTimeout(expiry);
    if (!res.writableEnded) res.end();
  };
  const enqueue = (event) => {
    const sequence = Number(event?.seq);
    if (!Number.isSafeInteger(sequence) || sequence <= lastSeq || sequence <= queuedSeq) return;
    queuedSeq = sequence;
    delivery = delivery.then(async () => {
      if (closed) return;
      const current = await store.getTask(task.id);
      if (!current) return;
      lastSeq = sequence;
      writeSse(res, 'task', { task: current, event });
      if (event.type === 'task.status' && terminalTaskStatuses.has(String(event.payload?.status || ''))) close();
    }).catch(close);
  };
  const onEvent = (event) => {
    if (ready) enqueue(event);
    else pending.push(event);
  };

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff'
  });
  res.write('retry: 1000\n\n');
  writeSse(res, 'ready', { task, after: afterSeq });
  unsubscribe = store.subscribeTaskEvents(task.id, onEvent);
  req.once('close', close);
  res.once('close', close);
  heartbeat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 15_000);
  heartbeat.unref?.();
  expiry = setTimeout(() => {
    if (!closed) {
      writeSse(res, 'stream.end', { reason: 'time_limit' });
      close();
    }
  }, 15 * 60_000);

  try {
    const backlog = await store.listEvents({ taskId: task.id, afterSeq });
    for (const event of backlog) enqueue(event);
    await delivery;
    ready = true;
    for (const event of pending) enqueue(event);
    pending = [];
    await delivery;
    if (!closed) {
      const current = await store.getTask(task.id);
      if (terminalTaskStatuses.has(String(current?.status || ''))) {
        writeSse(res, 'stream.end', { reason: 'terminal', task: current });
        close();
      }
    }
  } catch {
    close();
  }
}

async function body(req) {
  let text = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    text += chunk;
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }); }
}

const app = http.createServer(async (req, res) => {
  try {
    if (bind.overridden && !hasBearerToken(req, process.env.OPENBOT_AUTH_TOKEN)) return json(res, 401, { error: 'Authentication required.' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, await store.getState());
    if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, publicConfig(config));
    if (url.pathname === '/api/bots' && req.method === 'GET') return json(res, 200, { bots: await store.listBots() });
    if (url.pathname === '/api/bots' && req.method === 'POST') return json(res, 200, await store.createBot(await body(req)));
    if (url.pathname.startsWith('/api/bots/') && url.pathname.endsWith('/chat') && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.slice('/api/bots/'.length, -'/chat'.length));
      const payload = await body(req);
      if (typeof payload.message !== 'string' || !payload.message.trim()) return json(res, 400, { error: 'A bot message is required.' });
      const bot = await resolveBot(id);
      const taskRecord = payload.taskId ? await store.getTask(payload.taskId) : null;
      const providerName = payload.provider || taskRecord?.provider || 'local-model';
      const selected = await resolveAgentModel(payload.model, providerName);
      const result = await runAgentTask({ botId: id, taskId: payload.taskId, prompt: payload.message, workspace: bot.workspace, model: selected, providerName, maxTurns: payload.maxTurns, approvalId: payload.approvalId, skill: payload.skill });
      return json(res, agentHttpStatus(result), { provider: providerName, model: selected, ...result });
    }
    if (url.pathname.startsWith('/api/bots/') && url.pathname.endsWith('/messages') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/api/bots/'.length, -'/messages'.length));
      const messages = await store.listBotMessages(id);
      return messages ? json(res, 200, { botId: id, messages }) : json(res, 404, { error: 'Bot not found.' });
    }
    if (url.pathname.startsWith('/api/bots/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/api/bots/'.length));
      const bot = await store.getBot(id);
      return bot ? json(res, 200, { bot }) : json(res, 404, { error: 'Bot not found.' });
    }
    if (url.pathname.startsWith('/api/bots/') && req.method === 'PATCH') {
      const id = decodeURIComponent(url.pathname.slice('/api/bots/'.length));
      return json(res, 200, await store.updateBot(id, await body(req)));
    }
    if (url.pathname.startsWith('/api/bots/') && req.method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice('/api/bots/'.length));
      return json(res, 200, await store.deleteBot(id));
    }
    if (url.pathname === '/api/routines' && req.method === 'GET') return json(res, 200, { routines: await store.listRoutines() });
    if (url.pathname === '/api/routines' && req.method === 'POST') return json(res, 200, await store.createRoutine(await body(req)));
    if (url.pathname.startsWith('/api/routines/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/api/routines/'.length));
      const routine = await store.getRoutine(id);
      return routine ? json(res, 200, { routine }) : json(res, 404, { error: 'Routine not found.' });
    }
    if (url.pathname.startsWith('/api/routines/') && url.pathname.endsWith('/run') && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.slice('/api/routines/'.length, -'/run'.length));
      return json(res, 200, { result: await routineScheduler.runNow(id) });
    }
    if (url.pathname.startsWith('/api/routines/') && req.method === 'PATCH') {
      const id = decodeURIComponent(url.pathname.slice('/api/routines/'.length));
      return json(res, 200, await store.updateRoutine(id, await body(req)));
    }
    if (url.pathname.startsWith('/api/routines/') && req.method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice('/api/routines/'.length));
      return json(res, 200, await store.deleteRoutine(id));
    }
    if (url.pathname === '/api/health' && req.method === 'GET') {
      let localTags = { ok: false, models: [] };
      try { localTags = await localModel.tags(); } catch {}
      const providerList = [{ id: 'local-model', label: 'Local model', local: true, enabled: true, online: localTags.ok, models: localTags.models || [] }];
      if (!providers.localOnly && providers.remoteCompatible.enabled) {
        let remoteTags = { ok: false, models: [] };
        try { remoteTags = await providers.remoteCompatible.tags(); } catch {}
        providerList.push({ id: 'remote-compatible', label: 'Compatible remote provider', local: false, enabled: true, online: remoteTags.ok, models: remoteTags.models || [] });
      }
      return json(res, 200, { online: localTags.ok, models: localTags.models || [], providers: providerList });
    }
    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      return json(res, 200, { tasks: await store.listTasks() });
    }
    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const payload = await body(req);
      if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) return json(res, 400, { error: 'A task prompt is required.' });
      const created = await store.createTask(payload);
      return json(res, 200, created);
    }
    if (url.pathname === '/api/memories' && req.method === 'GET') {
      const workspace = url.searchParams.get('workspace');
      if (!workspace || workspace === 'local') return json(res, 400, { error: 'An explicit workspace path is required for memory.' });
      return json(res, 200, { memories: await store.listMemories({ workspace }) });
    }
    if (url.pathname === '/api/memories' && req.method === 'POST') {
      const payload = await body(req);
      return json(res, 200, await store.createMemory(payload));
    }
    if (url.pathname.startsWith('/api/memories/') && req.method === 'DELETE') {
      const id = url.pathname.slice('/api/memories/'.length);
      return json(res, 200, await store.deleteMemory(id));
    }
    if (url.pathname.startsWith('/api/memories/') && req.method === 'PATCH') {
      const id = decodeURIComponent(url.pathname.slice('/api/memories/'.length));
      return json(res, 200, await store.updateMemory(id, await body(req)));
    }
    if (url.pathname === '/api/skills' && req.method === 'GET') {
      return json(res, 200, { skills: await store.listSkills() });
    }
    if (url.pathname === '/api/skills' && req.method === 'POST') {
      const payload = await body(req);
      return json(res, 200, await store.createSkill(payload));
    }
    if (url.pathname.startsWith('/api/skills/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/api/skills/'.length));
      const skill = await store.getSkill(id);
      return skill ? json(res, 200, { skill }) : json(res, 404, { error: 'Skill not found.' });
    }
    if (url.pathname.startsWith('/api/skills/') && req.method === 'PATCH') {
      const id = decodeURIComponent(url.pathname.slice('/api/skills/'.length));
      return json(res, 200, await store.updateSkill(id, await body(req)));
    }
    if (url.pathname.startsWith('/api/skills/') && req.method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice('/api/skills/'.length));
      return json(res, 200, await store.deleteSkill(id));
    }
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/events/stream') && req.method === 'GET') {
      const taskId = decodeURIComponent(url.pathname.slice('/api/tasks/'.length, -'/events/stream'.length));
      const task = await store.getTask(taskId);
      if (!task) return json(res, 404, { error: 'Task not found' });
      const afterRaw = url.searchParams.get('after');
      const afterSeq = afterRaw == null || afterRaw === '' ? 0 : Number(afterRaw);
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return json(res, 400, { error: 'The event offset must be a non-negative integer.' });
      return streamTaskEvents(req, res, task, afterSeq);
    }
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/result') && req.method === 'GET') {
      const taskId = decodeURIComponent(url.pathname.slice('/api/tasks/'.length, -'/result'.length));
      const task = await store.getTask(taskId);
      if (!task) return json(res, 404, { error: 'Task not found' });
      const events = await store.listEvents({ taskId });
      return json(res, 200, taskResultView(task, events));
    }
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/artifacts') && req.method === 'GET') {
      const taskId = decodeURIComponent(url.pathname.slice('/api/tasks/'.length, -'/artifacts'.length));
      const task = await store.getTask(taskId);
      if (!task) return json(res, 404, { error: 'Task not found' });
      return json(res, 200, taskArtifactInventory(task, await store.listEvents({ taskId })));
    }
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.includes('/artifacts/') && req.method === 'GET') {
      const rest = url.pathname.slice('/api/tasks/'.length);
      const marker = '/artifacts/';
      const markerAt = rest.indexOf(marker);
      const taskId = decodeURIComponent(rest.slice(0, markerAt));
      const artifactPath = decodeURIComponent(rest.slice(markerAt + marker.length));
      const task = await store.getTask(taskId);
      if (!task) return json(res, 404, { error: 'Task not found' });
      const events = await store.listEvents({ taskId });
      const artifact = taskArtifactInventory(task, events).artifacts.find((item) => item.path === artifactPath);
      if (!artifact) return json(res, 404, { error: 'Artifact not found for this task.' });
      const content = await fileRead(task.workspace, artifact.path, { maxBytes: TASK_ARTIFACT_LIMITS.maxPreviewBytes });
      return json(res, 200, { taskId, artifact, ...redactArtifactContent(content.contents) });
    }
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/export') && req.method === 'GET') {
      const taskId = decodeURIComponent(url.pathname.slice('/api/tasks/'.length, -'/export'.length));
      const task = await store.getTask(taskId);
      if (!task) return json(res, 404, { error: 'Task not found' });
      const events = await store.listEvents({ taskId });
      return downloadJson(res, 'openbot-task-audit.json', { task, events, exportedAt: new Date().toISOString() });
    }
    if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET') {
      const rest = url.pathname.slice('/api/tasks/'.length);
      const [taskId, extra, tail] = rest.split('/');
      const task = await store.getTask(taskId);
      if (!task) return json(res, 404, { error: 'Task not found' });
      if (extra === 'events' && !tail) {
        const afterRaw = url.searchParams.get('after');
        const afterSeq = afterRaw == null || afterRaw === '' ? 0 : Number(afterRaw);
        if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return json(res, 400, { error: 'The event offset must be a non-negative integer.' });
        const events = await store.listEvents({ taskId, afterSeq });
        const nextSeq = events.length ? Number(events[events.length - 1].seq) : afterSeq;
        return json(res, 200, { task, events, nextSeq });
      }
      const events = await store.listEvents({ taskId });
      if (extra === 'audit' && !tail) return json(res, 200, { task, events, exportedAt: new Date().toISOString() });
      if (extra || tail) return json(res, 404, { error: 'Not found' });
      return json(res, 200, { task, events });
    }
    if (url.pathname === '/api/actions' && req.method === 'POST') {
      const payload = await body(req);
      const engine = createEngine({ store, actor: 'api' });
      const acted = await engine.act(payload);
      return json(res, acted.ok || acted.status === 'needs_approval' ? 200 : (acted.status === 'denied' ? 403 : 500), acted);
    }
    if (url.pathname === '/api/approval' && req.method === 'POST') {
      const { id, decision } = await body(req);
      const approval = await store.decideApproval(id, decision);
      return json(res, 200, { approval });
    }
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/resume') && req.method === 'POST') {
      const taskId = url.pathname.slice('/api/tasks/'.length, -'/resume'.length);
      const task = await store.getTask(taskId);
      if (!task) return json(res, 404, { error: 'Task not found' });
      if (task.status === 'paused') await store.setTaskStatus(taskId, 'resume');
      if (!['pending', 'running', 'waiting_approval'].includes(task.status) && task.status !== 'paused') return json(res, 409, { error: `Task is not resumable from status "${task.status}".` });
      const payload = await body(req);
      const providerName = payload.provider || task.provider || 'local-model';
      const selected = await resolveAgentModel(payload.model, providerName);
      const result = await runAgentTask({ taskId, prompt: task.prompt, workspace: task.workspace, model: selected, providerName, maxTurns: payload.maxTurns, approvalId: payload.approvalId, skill: payload.skill || task.skill, botId: task.botId });
      return json(res, agentHttpStatus(result), { provider: providerName, model: selected, ...result });
    }
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/control') && req.method === 'POST') {
      const taskId = url.pathname.slice('/api/tasks/'.length, -'/control'.length);
      const { action } = await body(req);
      if (!['pause', 'cancel'].includes(action)) return json(res, 400, { error: 'Task control action must be pause or cancel.' });
      const updated = await store.setTaskStatus(taskId, action);
      activeTaskControllers.get(taskId)?.abort();
      return json(res, 200, { task: updated });
    }
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/run') && req.method === 'POST') {
      const taskId = decodeURIComponent(url.pathname.slice('/api/tasks/'.length, -'/run'.length));
      const task = await store.getTask(taskId);
      if (!task) return json(res, 404, { error: 'Task not found' });
      if (task.status !== 'pending') return json(res, 409, { error: `Task is not runnable from status "${task.status}".` });
      if (activeTaskControllers.has(taskId)) return json(res, 409, { error: 'Task is already running.' });
      const payload = await body(req);
      const providerName = payload.provider || task.provider || 'local-model';
      if (providerName !== task.provider) return json(res, 409, { error: 'Task provider does not match the requested provider.' });
      void runTaskInBackground({ ...task, model: payload.model, provider: providerName, maxTurns: payload.maxTurns, approvalId: payload.approvalId, skill: payload.skill || task.skill, botId: payload.botId || task.botId, recordBotConversation: true });
      return json(res, 202, { taskId, status: 'started', task });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { message, model, provider, workspace, taskId, maxTurns, skill, botId } = await body(req);
      if (typeof message !== 'string' || !message.trim()) return json(res, 400, { error: 'A task is required.' });
      const bot = await resolveBot(botId);
      const selectedWorkspace = workspace || bot?.workspace;
      if (typeof selectedWorkspace !== 'string' || !selectedWorkspace.trim() || selectedWorkspace === 'local') return json(res, 400, { error: 'An explicit workspace path is required for agent work.' });
      const taskRecord = taskId ? await store.getTask(taskId) : null;
      const providerName = provider || taskRecord?.provider || 'local-model';
      const selected = await resolveAgentModel(model, providerName);
      const result = await runAgentTask({ taskId, prompt: message, workspace: selectedWorkspace, model: selected, providerName, maxTurns, skill, botId });
      return json(res, agentHttpStatus(result), { provider: providerName, model: selected, ...result });
    }
    const file = url.pathname === '/' ? join(publicDir, 'index.html') : join(publicDir, url.pathname);
    if (!file.startsWith(publicDir) || !existsSync(file)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'content-type': mime[extname(file)] || 'application/octet-stream',
      'cache-control': extname(file) === '.html' ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff'
    });
    res.end(await readFile(file));
  } catch (error) { json(res, error.statusCode || 500, { error: error.message || 'OpenBot failed unexpectedly.' }); }
});

app.on('error', async (error) => {
  console.error(error.message);
  await releaseDaemonPid(config.pidFile);
  process.exit(1);
});

app.listen(config.port, config.host, () => {
  routineScheduler.start();
  console.log(`OpenBot is ready at http://${config.host}:${config.port}`);
});
async function shutdown() {
  routineScheduler.stop();
  await releaseDaemonPid(config.pidFile);
  app.close(() => process.exit(0));
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
