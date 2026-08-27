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

export function daemonShow(config, taskId, env = process.env) {
  return requestDaemon(config, taskPath(taskId), {}, env);
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
