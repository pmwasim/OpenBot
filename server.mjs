import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { assertBindHost } from './lib/loopback.mjs';
import { createProviderHub } from './lib/provider.mjs';
import { openStore } from './lib/store.mjs';
import { createEngine } from './lib/engine.mjs';
import { createAgentController } from './lib/agent.mjs';

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
if (bind.overridden) {
  console.warn(`WARNING: HOST=${config.host} is not loopback. OpenBot preview has no authentication. OPENBOT_ALLOW_NON_LOOPBACK=1 is set.`);
}

const store = await openStore({ dataDir: config.dataDir });
const providers = createProviderHub(process.env, { ollamaUrl: config.ollamaUrl });
const ollama = providers.ollama;

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
  : ollama;

async function resolveAgentModel(requested) {
  if (process.env.OPENBOT_TEST_AGENT_RESPONSES) return requested || 'fixture';
  let tags;
  try { tags = await ollama.tags(); }
  catch { throw Object.assign(new Error('Ollama is not available. Start Ollama, then download a local model.'), { statusCode: 503 }); }
  if (!tags.ok) throw Object.assign(new Error('Ollama is not available. Start Ollama, then download a local model.'), { statusCode: 503 });
  const selected = requested || tags.models[0];
  if (!selected) throw Object.assign(new Error('Ollama has no local model yet.'), { statusCode: 503 });
  if (!tags.models.includes(selected)) throw Object.assign(new Error('Requested model is not installed locally.'), { statusCode: 400 });
  return selected;
}

async function runAgentTask({ taskId, prompt, workspace, model, maxTurns, approvalId }) {
  const controller = createAgentController({
    store,
    provider: agentProvider,
    engine: createEngine({ store, actor: 'agent' }),
    actor: 'agent',
    maxTurns: Math.min(Number(maxTurns) > 0 ? Number(maxTurns) : config.agentMaxTurns, config.agentMaxTurns),
    maxActions: config.agentMaxActions,
    maxContextChars: config.agentContextChars
  });
  return controller.run({ taskId, prompt, workspace, model, approvalId });
}

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
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, await store.getState());
    if (url.pathname === '/api/health' && req.method === 'GET') {
      try {
        const tags = await ollama.tags();
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
    if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET') {
      const rest = url.pathname.slice('/api/tasks/'.length);
      const [taskId, extra] = rest.split('/');
      const task = await store.getTask(taskId);
      if (!task) return json(res, 404, { error: 'Task not found' });
      const events = await store.listEvents({ taskId });
      if (extra === 'audit') return json(res, 200, { task, events, exportedAt: new Date().toISOString() });
      if (extra) return json(res, 404, { error: 'Not found' });
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
      if (!['pending', 'waiting_approval'].includes(task.status)) return json(res, 409, { error: `Task is not resumable from status "${task.status}".` });
      const payload = await body(req);
      const selected = await resolveAgentModel(payload.model);
      const result = await runAgentTask({ taskId, prompt: task.prompt, workspace: task.workspace, model: selected, maxTurns: payload.maxTurns, approvalId: payload.approvalId });
      return json(res, agentHttpStatus(result), { model: selected, ...result });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { message, model, workspace, taskId, maxTurns } = await body(req);
      if (typeof message !== 'string' || !message.trim()) return json(res, 400, { error: 'A task is required.' });
      if (typeof workspace !== 'string' || !workspace.trim() || workspace === 'local') return json(res, 400, { error: 'An explicit workspace path is required for agent work.' });
      const selected = await resolveAgentModel(model);
      const result = await runAgentTask({ taskId, prompt: message, workspace, model: selected, maxTurns });
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

app.listen(config.port, config.host, () => console.log(`OpenBot is ready at http://${config.host}:${config.port}`));
