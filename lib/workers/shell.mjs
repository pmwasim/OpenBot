import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { userInfo } from 'node:os';
import { realpath } from 'node:fs/promises';
import { classifyShellCommand } from '../policy.mjs';
import { detectIsolation } from '../sandbox.mjs';

const DEFAULT_IMAGE = 'alpine:3.20';
const SAFE_LOCAL_BINARIES = Object.freeze({
  uname: '/usr/bin/uname',
  pwd: '/bin/pwd',
  date: '/bin/date',
  whoami: '/usr/bin/whoami',
  id: '/usr/bin/id',
  true: '/usr/bin/true',
  ls: '/bin/ls'
});

function denied(message) {
  const error = new Error(message);
  error.code = 'OPENBOT_SHELL_DENIED';
  error.statusCode = 403;
  return error;
}

function runSpawn(command, args, { cwd, env, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let killTimer = null;
    const abort = () => {
      aborted = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('exit', (exitCode, exitSignal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      resolve({ stdout, stderr, exitCode, signal: exitSignal || null, aborted });
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function runDocker(argv, workspace, timeoutMs, signal) {
  const user = userInfo();
  const image = process.env.OPENBOT_DOCKER_IMAGE || DEFAULT_IMAGE;
  const dockerArgs = [
    'run', '--rm',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '64',
    '--memory', '128m',
    '--cpus', '0.5',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--user', `${user.uid}:${user.gid}`,
    '-v', `${workspace}:/workspace:rw`,
    '-w', '/workspace',
    image,
    ...argv
  ];
  return runSpawn('docker', dockerArgs, {
    cwd: workspace,
    env: process.env,
    timeoutMs,
    signal
  });
}

export async function shellExec(workspace, command, { timeoutMs = 20000, signal } = {}) {
  const classified = classifyShellCommand(command, workspace);
  if (classified.destructive || classified.outsideWorkspace) {
    throw denied(classified.reason || 'Destructive or out-of-workspace command refused.');
  }
  if (!classified.argv.length) throw denied('Command is required.');
  const root = await realpath(workspace);
  if (classified.argv[0] === 'node') {
    return runSpawn(process.execPath, classified.argv.slice(1), {
      cwd: root,
      env: {
        PATH: dirname(process.execPath),
        LANG: process.env.LANG || 'C',
        HOME: root,
        OPENBOT_WORKSPACE: root
      },
      timeoutMs,
      signal
    });
  }
  const isolation = await detectIsolation(process.env);
  if (isolation.mode === 'cwd') {
    const localProgram = SAFE_LOCAL_BINARIES[classified.argv[0]];
    if (!localProgram) throw denied('Only fixed-path diagnostic binaries are available in legacy mode.');
    return runSpawn(localProgram, classified.argv.slice(1), {
      cwd: root,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        LANG: process.env.LANG || 'C',
        HOME: root,
        OPENBOT_WORKSPACE: root
      },
      timeoutMs,
      signal
    });
  }
  return runDocker(classified.argv, root, timeoutMs, signal);
}
