import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { userInfo } from 'node:os';
import { realpath } from 'node:fs/promises';
import { classifyShellCommand } from '../policy.mjs';

const DEFAULT_IMAGE = 'alpine:3.20';

function denied(message) {
  const error = new Error(message);
  error.code = 'OPENBOT_SHELL_DENIED';
  error.statusCode = 403;
  return error;
}

function runSpawn(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal: signal || null });
    });
  });
}

async function runDocker(argv, workspace, timeoutMs) {
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
    timeoutMs
  });
}

export async function shellExec(workspace, command, { timeoutMs = 20000 } = {}) {
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
      timeoutMs
    });
  }
  return runDocker(classified.argv, root, timeoutMs);
}
