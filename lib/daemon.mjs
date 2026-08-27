import { spawn } from 'node:child_process';
import { mkdir, open as openFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function pidRecord(text) {
  try {
    const record = JSON.parse(text);
    return Number.isInteger(record?.pid) && record.pid > 0 ? record : null;
  } catch {
    return null;
  }
}

export function daemonUrl(config) {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${formattedHost}:${config.port}`;
}

export async function readDaemonRecord(pidFile) {
  try {
    return pidRecord(await readFile(pidFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function claimDaemonPid(pidFile, pid = process.pid) {
  await mkdir(dirname(pidFile), { recursive: true });
  const current = await readDaemonRecord(pidFile);
  if (current && isProcessAlive(current.pid)) {
    const error = new Error(`OpenBot daemon is already running (pid ${current.pid}).`);
    error.code = 'OPENBOT_DAEMON_RUNNING';
    error.statusCode = 409;
    throw error;
  }
  if (current) await unlink(pidFile).catch(() => {});
  await writeFile(pidFile, JSON.stringify({ pid, startedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  return { pid, pidFile };
}

export async function releaseDaemonPid(pidFile, pid = process.pid) {
  const current = await readDaemonRecord(pidFile);
  if (current?.pid !== pid) return false;
  await unlink(pidFile).catch(() => {});
  return true;
}

async function daemonHealth(config) {
  try {
    const response = await fetch(`${daemonUrl(config)}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return { reachable: false, modelOnline: false };
    const body = await response.json().catch(() => ({}));
    return { reachable: true, modelOnline: body.online === true };
  } catch {
    return { reachable: false, modelOnline: false };
  }
}

export async function daemonStatus(config) {
  const record = await readDaemonRecord(config.pidFile);
  if (!record || !isProcessAlive(record.pid)) {
    if (record) await unlink(config.pidFile).catch(() => {});
    return { status: 'stopped', pid: null, url: daemonUrl(config), modelOnline: false };
  }
  const health = await daemonHealth(config);
  return {
    status: health.reachable ? 'running' : 'starting',
    pid: record.pid,
    startedAt: record.startedAt || null,
    url: daemonUrl(config),
    modelOnline: health.modelOnline
  };
}

export async function startDaemon(config, env = process.env) {
  const current = await daemonStatus(config);
  if (current.status !== 'stopped') return { ...current, alreadyRunning: true };

  await mkdir(config.dataDir, { recursive: true });
  const logFile = join(config.dataDir, 'openbot.log');
  const log = await openFile(logFile, 'a');
  const child = spawn(process.execPath, [join(config.root, 'server.mjs')], {
    cwd: config.root,
    detached: true,
    env: { ...env, OPENBOT_PID_FILE: config.pidFile },
    stdio: ['ignore', log, log]
  });
  await log.close();
  child.unref();

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = await daemonStatus(config);
    if (status.status === 'running') return { ...status, started: true };
    if (!isProcessAlive(child.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const status = await daemonStatus(config);
  const error = new Error(`OpenBot daemon did not become ready. Check ${logFile}.`);
  error.statusCode = 503;
  error.daemonStatus = status;
  throw error;
}

export async function stopDaemon(config) {
  const current = await daemonStatus(config);
  if (current.status === 'stopped') return { ...current, alreadyStopped: true };
  process.kill(current.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = await daemonStatus(config);
    if (status.status === 'stopped') return { ...status, status: 'stopped', pid: current.pid, stopped: true };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const error = new Error(`OpenBot daemon did not stop (pid ${current.pid}).`);
  error.statusCode = 504;
  throw error;
}
