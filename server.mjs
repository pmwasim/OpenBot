import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { assertBindHost, hasBearerToken } from './lib/loopback.mjs';
import { createProviderHub } from './lib/provider.mjs';
import { openStore } from './lib/store.mjs';
import { createEngine } from './lib/engine.mjs';
import { createAgentController } from './lib/agent.mjs';
import { createRoutineScheduler } from './lib/routines.mjs';
import { claimDaemonPid, releaseDaemonPid } from './lib/daemon.mjs';

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
    async chatStructured({ model }) {
      if (index >= replies.length) return { ok: false, status: 502, model, error: 'Test agent response queue is exhausted.' };
      return { ok: true, status: 200, model: model || 'fixture', reply: replies[index++] };
    }
  };
}

const agentProvider = process.env.OPENBOT_TEST_AGENT_RESPONSES
  ? fixtureAgentProvider(process.env.OPENBOT_TEST_AGENT_RESPONSES)
  : localModel;

async function resolveAgentModel(requested) {
  if (process.env.OPENBOT_TEST_AGENT_RESPONSES) return requested || 'fixture';
  let tags;
  try { tags = await localModel.tags(); }
  catch { throw Object.assign(new Error('The local model runtime is not available. Start it, then install a local model.'), { statusCode: 503 }); }
  if (!tags.ok) throw Object.assign(new Error('The local model runtime is not available. Start it, then install a local model.'), { statusCode: 503 });
  const selected = requested || tags.models[0];
  if (!selected) throw Object.assign(new Error('The local model runtime has no model installed yet.'), { statusCode: 503 });
  if (!tags.models.includes(selected)) throw Object.assign(new Error('Requested model is not installed locally.'), { statusCode: 400 });
  return selected;
}

async function resolveBot(botId) {
  if (!botId) return null;
  const bot = await store.getBot(botId);
  if (!bot) throw Object.assign(new Error('Bot not found.'), { statusCode: 404 });
  return bot;
}

async function runAgentTask({ taskId, prompt, workspace, model, maxTurns, approvalId, skill, botId }) {
  const existingTask = taskId ? await store.getTask(taskId) : null;
  const bot = await resolveBot(botId || existingTask?.botId);
  const selectedWorkspace = workspace || bot?.workspace;
  if (bot && selectedWorkspace !== bot.workspace) throw Object.assign(new Error('Bot workspace does not match the requested workspace.'), { statusCode: 409 });
  const controller = createAgentController({
    store,
    provider: agentProvider,
    engine: createEngine({ store, actor: 'agent' }),
    actor: 'agent',
    maxTurns: Math.min(Number(maxTurns) > 0 ? Number(maxTurns) : config.agentMaxTurns, config.agentMaxTurns),
    maxActions: config.agentMaxActions,
    maxContextChars: config.agentContextChars
  });
  const result = await controller.run({ taskId, prompt, workspace: selectedWorkspace, model, approvalId, skill, bot });
  if (bot && !taskId) {
    await store.recordBotMessage(bot.id, { role: 'user', content: prompt, taskId });
    await store.recordBotMessage(bot.id, {
      role: 'assistant',
      content: result.reply || (result.status === 'waiting_approval' ? 'Waiting for approval before continuing.' : `Task stopped with status: ${result.status}.`),
      taskId: result.taskId
    });
  }
  return { botId: bot?.id || null, ...result };
}

const routineScheduler = createRoutineScheduler({
  store,
  runRoutine: async (routine) => {
    const model = await resolveAgentModel();
    return runAgentTask({ prompt: routine.prompt, workspace: routine.workspace, model, skill: routine.skill, botId: routine.botId });
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
    if (url.pathname === '/api/bots' && req.method === 'GET') return json(res, 200, { bots: await store.listBots() });
    if (url.pathname === '/api/bots' && req.method === 'POST') return json(res, 200, await store.createBot(await body(req)));
    if (url.pathname.startsWith('/api/bots/') && url.pathname.endsWith('/chat') && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.slice('/api/bots/'.length, -'/chat'.length));
      const payload = await body(req);
      if (typeof payload.message !== 'string' || !payload.message.trim()) return json(res, 400, { error: 'A bot message is required.' });
      const bot = await resolveBot(id);
      const selected = await resolveAgentModel(payload.model);
      const result = await runAgentTask({ botId: id, taskId: payload.taskId, prompt: payload.message, workspace: bot.workspace, model: selected, maxTurns: payload.maxTurns, approvalId: payload.approvalId, skill: payload.skill });
      return json(res, agentHttpStatus(result), { model: selected, ...result });
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
      try {
        const tags = await localModel.tags();
        return json(res, 200, { online: tags.ok, models: tags.models || [] });
      } catch { return json(res, 200, { online: false, models: [] }); }
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
      const selected = await resolveAgentModel(payload.model);
      const result = await runAgentTask({ taskId, prompt: task.prompt, workspace: task.workspace, model: selected, maxTurns: payload.maxTurns, approvalId: payload.approvalId, skill: payload.skill || task.skill, botId: task.botId });
      return json(res, agentHttpStatus(result), { model: selected, ...result });
    }
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/control') && req.method === 'POST') {
      const taskId = url.pathname.slice('/api/tasks/'.length, -'/control'.length);
      const { action } = await body(req);
      if (!['pause', 'cancel'].includes(action)) return json(res, 400, { error: 'Task control action must be pause or cancel.' });
      return json(res, 200, { task: await store.setTaskStatus(taskId, action) });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { message, model, workspace, taskId, maxTurns, skill, botId } = await body(req);
      if (typeof message !== 'string' || !message.trim()) return json(res, 400, { error: 'A task is required.' });
      const bot = await resolveBot(botId);
      const selectedWorkspace = workspace || bot?.workspace;
      if (typeof selectedWorkspace !== 'string' || !selectedWorkspace.trim() || selectedWorkspace === 'local') return json(res, 400, { error: 'An explicit workspace path is required for agent work.' });
      const selected = await resolveAgentModel(model);
      const result = await runAgentTask({ taskId, prompt: message, workspace: selectedWorkspace, model: selected, maxTurns, skill, botId });
      return json(res, agentHttpStatus(result), { model: selected, ...result });
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
