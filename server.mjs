import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { loadConfig, publicConfig } from './lib/config.mjs';
import { assertBindHost } from './lib/loopback.mjs';
import { createProviderHub } from './lib/provider.mjs';
import { createExecutor } from './lib/executor.mjs';
import { redactSecrets, openStore } from './lib/store.mjs';
import { createWorkerHub } from './lib/workers.mjs';

const config = loadConfig();
const maxBodyBytes = config.limits.maxBodyBytes;
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
const workers = createWorkerHub({
  dataDir: config.dataDir,
  localOnly: config.localOnly,
  browserAllowlist: config.browserAllowlist,
  sandboxMode: config.sandboxMode,
  limits: { shellTimeoutMs: config.limits.shellTimeoutMs }
});
const executor = createExecutor({ store, workers });
const streamClients = new Map();
const executorSubscriptions = new Map();

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

function publicTask(task) {
  return task ? redactSecrets(task) : null;
}

function taskIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/([^/]+))?$/);
  return match ? { id: decodeURIComponent(match[1]), suffix: match[2] || '' } : null;
}

function writeSse(res, event, payload) {
  if (res.writableEnded) return;
  if (payload?.seq !== undefined) res.write(`id: ${payload.seq}\n`);
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function notifyStream(event) {
  for (const client of streamClients.get(event.taskId) || []) writeSse(client.res, 'event', redactSecrets(event));
}

function taskBody(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Task body must be an object.'), { statusCode: 400 });
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw Object.assign(new Error('A task prompt is required.'), { statusCode: 400 });
  if (Buffer.byteLength(input.prompt, 'utf8') > config.limits.maxPromptBytes) throw Object.assign(new Error('Task prompt is too large.'), { statusCode: 413 });
  if (input.action !== undefined && (!input.action || typeof input.action !== 'object' || Array.isArray(input.action))) throw Object.assign(new Error('Task action must be a structured object.'), { statusCode: 400 });
  const kind = input.kind || 'plan';
  const action = input.action || null;
  if (action && typeof action.tool !== 'string') throw Object.assign(new Error('Task action requires a tool.'), { statusCode: 400 });
  return {
    prompt: input.prompt.trim(),
    kind,
    action,
    provider: input.provider || 'ollama',
    workspace: input.workspace || 'local',
    owner: 'local',
    title: typeof input.title === 'string' ? input.title.slice(0, 240) : undefined,
    detail: typeof input.detail === 'string' ? input.detail.slice(0, 2000) : undefined
  };
}

async function approvalForTask(taskId, approvalId) {
  const state = await store.getState();
  const approval = state.approvals.find((item) => item.taskId === taskId && (!approvalId || item.id === approvalId));
  if (!approval) throw Object.assign(new Error('Approval not found for task.'), { statusCode: 404 });
  return approval;
}

async function startIfExecutable(task) {
  if (!task?.action || task.status !== 'pending') return;
  if (!executorSubscriptions.has(task.id)) {
    const unsubscribe = executor.onTask(task.id, (event) => {
      notifyStream(event);
      if (event.type === 'task.recoverable' || (event.type === 'task.status' && ['completed', 'failed', 'cancelled'].includes(event.payload?.status || ''))) {
        unsubscribe();
        executorSubscriptions.delete(task.id);
      }
    });
    executorSubscriptions.set(task.id, unsubscribe);
  }
  void executor.start(task.id).catch((error) => console.error(JSON.stringify({ type: 'task-start-failed', taskId: task.id, message: error.message })));
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
    if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, publicConfig(config));
    if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, { tasks: (await store.listTasks()).map(publicTask) });
    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const created = await store.createTask(taskBody(await body(req)));
      await startIfExecutable(created.task);
      return json(res, 201, { task: publicTask(created.task), approval: redactSecrets(created.approval), policy: created.policy });
    }
    const routed = taskIdFromPath(url.pathname);
    if (routed) {
      const task = await store.getTask(routed.id);
      if (!task) return json(res, 404, { error: 'Task not found' });
      if (req.method === 'GET' && !routed.suffix) return json(res, 200, { task: publicTask(task) });
      if (req.method === 'GET' && routed.suffix === 'events') return json(res, 200, { events: (await store.listEvents({ taskId: routed.id })).map(redactSecrets) });
      if (req.method === 'GET' && routed.suffix === 'export') {
        const bundle = await store.exportTask(routed.id);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="openbot-${routed.id}.json"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(JSON.stringify(bundle));
      }
      if (req.method === 'GET' && routed.suffix === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
        const client = { res, last: Number(req.headers['last-event-id']) || 0 };
        if (!streamClients.has(routed.id)) streamClients.set(routed.id, new Set());
        streamClients.get(routed.id).add(client);
        const events = await store.listEvents({ taskId: routed.id });
        for (const event of events) {
          if (event.seq <= client.last) continue;
          writeSse(res, 'event', redactSecrets(event));
          client.last = event.seq;
        }
        const current = await store.getTask(routed.id);
        if (['completed', 'failed', 'cancelled', 'recoverable'].includes(current?.status)) {
          writeSse(res, 'done', { taskId: routed.id, status: current.status });
          streamClients.get(routed.id).delete(client);
          return res.end();
        }
        const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, 15_000);
        req.on('close', () => { clearInterval(heartbeat); streamClients.get(routed.id)?.delete(client); });
        return;
      }
      if (req.method === 'POST' && ['approve', 'reject', 'pause', 'cancel', 'resume'].includes(routed.suffix)) {
        const input = await body(req);
        if (routed.suffix === 'approve') {
          const approval = await approvalForTask(routed.id, input.approvalId);
          const decided = await store.decideApproval(approval.id, 'approved');
          if (decided.actionDigest) await store.consumeApproval(decided.id, decided.actionDigest);
          const next = await store.getTask(routed.id);
          await startIfExecutable(next);
          return json(res, 202, { task: publicTask(next), approval: redactSecrets(decided) });
        }
        if (routed.suffix === 'reject') {
          const approval = await approvalForTask(routed.id, input.approvalId);
          const decided = await store.decideApproval(approval.id, 'rejected');
          return json(res, 200, { task: publicTask(await store.getTask(routed.id)), approval: redactSecrets(decided) });
        }
        if (routed.suffix === 'pause') {
          const next = await executor.pause(routed.id);
          return json(res, 202, { task: publicTask(await store.getTask(routed.id)), result: redactSecrets(next) });
        }
        if (routed.suffix === 'cancel') {
          const next = await executor.cancel(routed.id);
          return json(res, 202, { task: publicTask(await store.getTask(routed.id)), result: redactSecrets(next) });
        }
        const next = await store.resumeTask(routed.id);
        await startIfExecutable(next);
        return json(res, 202, { task: publicTask(next) });
      }
      return json(res, 404, { error: 'Task route not found' });
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, await store.getState());
    if (url.pathname === '/api/health' && req.method === 'GET') {
      try {
        const tags = await ollama.tags();
        return json(res, 200, { online: tags.ok, models: tags.models || [] });
      } catch { return json(res, 200, { online: false, models: [] }); }
    }
    if (url.pathname === '/api/approval' && req.method === 'POST') {
      const { id, decision } = await body(req);
      const approval = await store.decideApproval(id, decision);
      if (decision === 'approved' && approval.actionDigest) {
        await store.consumeApproval(approval.id, approval.actionDigest);
        await startIfExecutable(await store.getTask(approval.taskId));
      }
      return json(res, 200, { approval });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { message, model, provider = 'ollama' } = await body(req);
      if (typeof message !== 'string' || !message.trim()) return json(res, 400, { error: 'A task is required.' });
      let adapter;
      try { adapter = providers.get(provider); }
      catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
      if (provider !== 'ollama') {
        if (!model || typeof model !== 'string') return json(res, 400, { error: 'A model is required for the selected provider.' });
        const response = await adapter.chat({ model, stream: false, messages: [{ role: 'system', content: 'You are OpenBot, a local-first assistant. Plan tasks carefully and never claim that you executed actions.' }, { role: 'user', content: message }] });
        if (!response.ok) return json(res, response.status, { error: response.error || 'The selected provider could not complete the task.' });
        return json(res, 200, { provider, model, reply: response.reply || 'No response returned.' });
      }
      let tags;
      try { tags = await ollama.tags(); }
      catch { return json(res, 503, { error: 'Ollama is not available. Start Ollama, then download a local model.' }); }
      if (!tags.ok) return json(res, 503, { error: 'Ollama is not available. Start Ollama, then download a local model.' });
      const installed = tags.models || [];
      const selected = model || installed[0];
      if (!selected) return json(res, 503, { error: 'Ollama has no local model yet.' });
      if (!installed.includes(selected)) return json(res, 400, { error: 'Requested model is not installed locally.' });
      const response = await adapter.chat({
        model: selected,
        stream: false,
        messages: [
          { role: 'system', content: 'You are OpenBot, a local-first assistant. Plan tasks carefully. Do not claim that you executed actions. When an action could send, publish, purchase, delete, or change a production system, explicitly ask for approval.' },
          { role: 'user', content: message }
        ]
      });
      if (!response.ok) return json(res, response.status, { error: response.error || 'Ollama could not complete the task.' });
      return json(res, 200, { model: selected, reply: response.reply || 'No response returned.' });
    }
    const file = url.pathname === '/' ? join(publicDir, 'index.html') : join(publicDir, url.pathname);
    if (!file.startsWith(publicDir) || !existsSync(file)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'content-type': mime[extname(file)] || 'application/octet-stream',
      'cache-control': ['.html', '.js', '.css'].includes(extname(file)) ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff'
    });
    res.end(await readFile(file));
  } catch (error) { json(res, error.statusCode || 500, { error: error.message || 'OpenBot failed unexpectedly.' }); }
});

const server = app.listen(config.port, config.host, () => console.log(`OpenBot is ready at http://${config.host}:${config.port}`));
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`OpenBot received ${signal}; draining active tasks.`);
  await executor.shutdown();
  await new Promise((resolve) => server.close(resolve));
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
