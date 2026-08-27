import { daemonUrl } from './daemon.mjs';

function endpoint(config, env = process.env) {
  return String(env.OPENBOT_DAEMON_URL || daemonUrl(config)).replace(/\/+$/, '');
}

export async function requestDaemon(config, path, options = {}, env = process.env) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (env.OPENBOT_AUTH_TOKEN) headers.authorization = `Bearer ${env.OPENBOT_AUTH_TOKEN}`;
  let response;
  try {
    response = await fetch(`${endpoint(config, env)}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body == null ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs || 120000)
    });
  } catch (error) {
    const wrapped = new Error(`OpenBot daemon is unavailable: ${error.message}`);
    wrapped.statusCode = 503;
    throw wrapped;
  }
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch {
    const error = new Error('OpenBot daemon returned an invalid response.');
    error.statusCode = 502;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data.error || `OpenBot daemon request failed with status ${response.status}.`);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

export function daemonChat(config, payload, env = process.env) {
  const path = payload.botId ? `/api/bots/${encodeURIComponent(payload.botId)}/chat` : '/api/chat';
  const body = { ...payload };
  if (!body.botId) delete body.botId;
  return requestDaemon(config, path, { method: 'POST', body }, env);
}

function taskPath(taskId, suffix = '') {
  return `/api/tasks/${encodeURIComponent(taskId)}${suffix}`;
}

export function daemonState(config, env = process.env) {
  return requestDaemon(config, '/api/state', {}, env);
}

export function daemonList(config, env = process.env) {
  return requestDaemon(config, '/api/tasks', {}, env);
}

export function daemonCreateTask(config, payload, env = process.env) {
  return requestDaemon(config, '/api/tasks', { method: 'POST', body: payload }, env);
}

export function daemonRunTask(config, taskId, payload = {}, env = process.env) {
  return requestDaemon(config, taskPath(taskId, '/run'), { method: 'POST', body: payload }, env);
}

export function daemonTaskEvents(config, taskId, after = 0, env = process.env) {
  return requestDaemon(config, `${taskPath(taskId, '/events')}?after=${encodeURIComponent(after)}`, {}, env);
}

export function daemonShow(config, taskId, env = process.env) {
  return requestDaemon(config, taskPath(taskId), {}, env);
}

export function daemonTaskResult(config, taskId, env = process.env) {
  return requestDaemon(config, taskPath(taskId, '/result'), {}, env);
}

export function daemonTaskArtifacts(config, taskId, env = process.env) {
  return requestDaemon(config, taskPath(taskId, '/artifacts'), {}, env);
}

export function daemonConnectors(config, env = process.env) {
  return requestDaemon(config, '/api/connectors', {}, env);
}

export function daemonCreateConnector(config, payload, env = process.env) {
  return requestDaemon(config, '/api/connectors', { method: 'POST', body: payload }, env);
}

export function daemonConnector(config, id, env = process.env) {
  return requestDaemon(config, `/api/connectors/${encodeURIComponent(id)}`, {}, env);
}

export function daemonUpdateConnector(config, id, payload, env = process.env) {
  return requestDaemon(config, `/api/connectors/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }, env);
}

export function daemonDeleteConnector(config, id, env = process.env) {
  return requestDaemon(config, `/api/connectors/${encodeURIComponent(id)}`, { method: 'DELETE' }, env);
}

export function daemonLogs(config, taskId, env = process.env) {
  return requestDaemon(config, taskPath(taskId, '/events'), {}, env);
}

export function daemonDecideApproval(config, id, decision, env = process.env) {
  return requestDaemon(config, '/api/approval', { method: 'POST', body: { id, decision } }, env);
}

export function daemonControlTask(config, taskId, action, env = process.env) {
  return requestDaemon(config, taskPath(taskId, '/control'), { method: 'POST', body: { action } }, env);
}

export function daemonResume(config, taskId, payload = {}, env = process.env) {
  return requestDaemon(config, taskPath(taskId, '/resume'), { method: 'POST', body: payload }, env);
}

export function daemonMemories(config, workspace, env = process.env) {
  return requestDaemon(config, `/api/memories?workspace=${encodeURIComponent(workspace)}`, {}, env);
}

export function daemonCreateMemory(config, payload, env = process.env) {
  return requestDaemon(config, '/api/memories', { method: 'POST', body: payload }, env);
}

export function daemonUpdateMemory(config, id, payload, env = process.env) {
  return requestDaemon(config, `/api/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }, env);
}

export function daemonDeleteMemory(config, id, env = process.env) {
  return requestDaemon(config, `/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }, env);
}

export function daemonSkills(config, env = process.env) {
  return requestDaemon(config, '/api/skills', {}, env);
}

export function daemonCreateSkill(config, payload, env = process.env) {
  return requestDaemon(config, '/api/skills', { method: 'POST', body: payload }, env);
}

export function daemonUpdateSkill(config, id, payload, env = process.env) {
  return requestDaemon(config, `/api/skills/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }, env);
}

export function daemonSkill(config, id, env = process.env) {
  return requestDaemon(config, `/api/skills/${encodeURIComponent(id)}`, {}, env);
}

export function daemonDeleteSkill(config, id, env = process.env) {
  return requestDaemon(config, `/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }, env);
}

export function daemonBots(config, env = process.env) {
  return requestDaemon(config, '/api/bots', {}, env);
}

export function daemonCreateBot(config, payload, env = process.env) {
  return requestDaemon(config, '/api/bots', { method: 'POST', body: payload }, env);
}

export function daemonBot(config, id, env = process.env) {
  return requestDaemon(config, `/api/bots/${encodeURIComponent(id)}`, {}, env);
}

export function daemonBotMessages(config, id, query = '', env = process.env) {
  const suffix = String(query || '').trim() ? `?q=${encodeURIComponent(String(query).trim())}` : '';
  return requestDaemon(config, `/api/bots/${encodeURIComponent(id)}/messages${suffix}`, {}, env);
}

export function daemonUpdateBot(config, id, payload, env = process.env) {
  return requestDaemon(config, `/api/bots/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }, env);
}

export function daemonDeleteBot(config, id, env = process.env) {
  return requestDaemon(config, `/api/bots/${encodeURIComponent(id)}`, { method: 'DELETE' }, env);
}

export function daemonRoutines(config, env = process.env) {
  return requestDaemon(config, '/api/routines', {}, env);
}

export function daemonCreateRoutine(config, payload, env = process.env) {
  return requestDaemon(config, '/api/routines', { method: 'POST', body: payload }, env);
}

export function daemonRoutine(config, id, env = process.env) {
  return requestDaemon(config, `/api/routines/${encodeURIComponent(id)}`, {}, env);
}

export function daemonUpdateRoutine(config, id, payload, env = process.env) {
  return requestDaemon(config, `/api/routines/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }, env);
}

export function daemonRunRoutine(config, id, env = process.env) {
  return requestDaemon(config, `/api/routines/${encodeURIComponent(id)}/run`, { method: 'POST' }, env);
}
