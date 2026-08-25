import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, lstat, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxOutputBytes: 256 * 1024,
  maxListEntries: 1000,
  shellTimeoutMs: 30_000,
  browserTimeoutMs: 15_000,
  maxBrowserBytes: 1024 * 1024,
  maxRedirects: 3
});
const SAFE_COMMANDS = new Set(['cat', 'echo', 'git', 'ls', 'node', 'npm', 'printf', 'pwd', 'python3', 'sleep']);
const PRIVATE_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);

function workerError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function boundedText(value, limit) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= limit) return { text, truncated: false };
  return { text: Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8'), truncated: true };
}

function ensureContext(context) {
  if (!context || typeof context.workspace !== 'string' || !context.workspace) throw workerError('A task workspace is required.', 400);
  if (!context.taskId || typeof context.taskId !== 'string') throw workerError('A task id is required.', 400);
}

function safeSegment(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.includes('\\');
}

async function existingParent(path, workspace) {
  let current = path;
  while (current !== workspace) {
    try { return await realpath(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = dirname(current);
      if (next === current) break;
      current = next;
    }
  }
  return await realpath(workspace);
}

async function resolveWorkspacePath(workspace, requested, { allowWorkspace = false } = {}) {
  if (!safeSegment(requested)) throw workerError('A relative workspace path is required.', 400);
  if (isAbsolute(requested)) throw workerError('Absolute paths are not allowed.', 400);
  const workspaceReal = await realpath(workspace).catch(() => { throw workerError('Task workspace is unavailable.', 409); });
  const candidate = resolve(workspaceReal, requested);
  const distance = relative(workspaceReal, candidate);
  if (distance.startsWith(`..${sep}`) || distance === '..' || isAbsolute(distance) || (!allowWorkspace && distance === '')) {
    throw workerError('Path escapes the task workspace.', 400);
  }
  const parentReal = await existingParent(dirname(candidate), workspaceReal);
  const parentDistance = relative(workspaceReal, parentReal);
  if (parentDistance.startsWith(`..${sep}`) || parentDistance === '..' || isAbsolute(parentDistance)) {
    throw workerError('Path escapes the task workspace.', 400);
  }
  try {
    const target = await lstat(candidate);
    if (target.isSymbolicLink()) throw workerError('Symbolic links are not allowed for task paths.', 400);
    const targetReal = await realpath(candidate);
    const targetDistance = relative(workspaceReal, targetReal);
    if (targetDistance.startsWith(`..${sep}`) || targetDistance === '..' || isAbsolute(targetDistance)) {
      throw workerError('Path escapes the task workspace.', 400);
    }
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  return candidate;
}

async function ensureParent(path, workspace) {
  const parent = dirname(path);
  await existingParent(parent, workspace);
  await mkdir(parent, { recursive: true });
  await existingParent(parent, workspace);
}

async function fileWorker(action, context, limits) {
  const path = await resolveWorkspacePath(context.workspace, action.path, { allowWorkspace: action.tool === 'file.list' });
  if (action.tool === 'file.list') {
    const entries = [];
    const queue = [path];
    while (queue.length && entries.length < limits.maxListEntries) {
      const current = queue.shift();
      const children = await readdir(current, { withFileTypes: true });
      for (const child of children) {
        if (entries.length >= limits.maxListEntries) break;
        const childPath = join(current, child.name);
        const relativePath = relative(context.workspace, childPath) || '.';
        if (child.isSymbolicLink()) throw workerError('Symbolic links are not allowed for task paths.', 400);
        entries.push({ path: relativePath, type: child.isDirectory() ? 'directory' : 'file' });
        if (child.isDirectory()) queue.push(childPath);
      }
    }
    return { output: JSON.stringify({ entries, truncated: queue.length > 0 || entries.length >= limits.maxListEntries }), metadata: { tool: action.tool, path: action.path } };
  }
  if (action.tool === 'file.read') {
    const info = await stat(path).catch(() => { throw workerError('File not found.', 404); });
    if (!info.isFile()) throw workerError('Only files can be read.', 400);
    if (info.size > limits.maxFileBytes) throw workerError('File is larger than the worker limit.', 413);
    return { output: await readFile(path, 'utf8'), metadata: { tool: action.tool, path: action.path, bytes: info.size } };
  }
  if (action.tool === 'file.delete') {
    const info = await lstat(path).catch(() => { throw workerError('File not found.', 404); });
    if (!info.isFile()) throw workerError('Only files can be deleted.', 400);
    await rm(path);
    return { output: JSON.stringify({ path: relative(context.workspace, path), deleted: true }), metadata: { tool: action.tool, path: action.path } };
  }
  if (!['file.write', 'file.append'].includes(action.tool)) throw workerError(`Unsupported file tool "${action.tool}".`, 400);
  if (typeof action.content !== 'string') throw workerError('File content must be a string.', 400);
  if (Buffer.byteLength(action.content, 'utf8') > limits.maxFileBytes) throw workerError('File content is larger than the worker limit.', 413);
  await ensureParent(path, context.workspace);
  if (action.tool === 'file.append') {
    await writeFile(path, action.content, { encoding: 'utf8', flag: 'a', mode: 0o600 });
  } else if (action.tool === 'file.write') {
    const temporary = `${path}.openbot-${context.taskId}.tmp`;
    await writeFile(temporary, action.content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }
  return { output: JSON.stringify({ path: relative(context.workspace, path), bytes: Buffer.byteLength(action.content, 'utf8') }), metadata: { tool: action.tool, path: action.path } };
}

function safeCommand(action) {
  if (typeof action.command !== 'string' || !action.command.trim()) throw workerError('A shell command is required.', 400);
  if (isAbsolute(action.command) || action.command.includes('/') || !SAFE_COMMANDS.has(action.command.trim())) {
    throw workerError(`Command "${action.command}" is not in the worker allowlist.`, 403);
  }
  if (!Array.isArray(action.args) || action.args.some((arg) => typeof arg !== 'string')) throw workerError('Shell args must be an array of strings.', 400);
  if (action.args.some((arg) => /[;&|`$<>]/.test(arg) || arg.includes('\0'))) throw workerError('Shell metacharacters are not allowed.', 400);
}

function sandboxCommand(action, context, env, sandboxMode, bubblewrapPath) {
  if (sandboxMode === 'allowlist') return { command: action.command.trim(), args: action.args };
  if (!bubblewrapPath) throw workerError('Shell worker requires bubblewrap isolation on this host. Install bubblewrap or set OPENBOT_SANDBOX_MODE=allowlist only for a trusted development machine.', 503);
  const args = ['--die-with-parent', '--new-session', '--unshare-all', '--clearenv'];
  for (const directory of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']) if (existsSync(directory)) args.push('--ro-bind', directory, directory);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const directory of ['/usr/local', '/opt']) if (existsSync(directory)) args.push('--ro-bind', directory, directory);
  args.push('--bind', context.workspace, '/workspace', '--chdir', '/workspace');
  for (const [key, value] of Object.entries({ ...env, HOME: '/workspace/.home' })) args.push('--setenv', key, value);
  args.push('--', action.command.trim(), ...action.args);
  return { command: bubblewrapPath, args };
}

async function shellWorker(action, context, limits, sandboxMode, bubblewrapPath) {
  safeCommand(action);
  const home = join(context.workspace, '.home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    OPENBOT_TASK_ID: context.taskId
  };
  const invocation = sandboxCommand(action, context, { ...env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }, sandboxMode, bubblewrapPath);
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, { cwd: context.workspace, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const collect = (current, chunk) => boundedText(`${current}${chunk}`, limits.maxOutputBytes).text;
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, limits.shellTimeoutMs);
    const abort = () => { aborted = true; child.kill('SIGTERM'); };
    if (context.signal?.aborted) abort();
    else context.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => { clearTimeout(timer); rejectPromise(workerError(`Shell could not start: ${error.message}`, 422)); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', abort);
      const output = boundedText([stdout, stderr].filter(Boolean).join('\n'), limits.maxOutputBytes);
      if (timedOut) return rejectPromise(workerError('Shell command timed out.', 408));
      if (aborted) return rejectPromise(workerError('Shell command was interrupted.', 499));
      if (code !== 0) return rejectPromise(Object.assign(workerError(`Shell exited with ${code ?? signal}.`, 422), { output: output.text }));
      resolvePromise({ output: output.text, metadata: { tool: action.tool, command: action.command, exitCode: code, truncated: output.truncated } });
    });
  });
}

function isPrivateAddress(address) {
  const value = String(address).toLowerCase();
  if (PRIVATE_HOSTS.has(value) || value.endsWith('.local')) return true;
  if (isIP(value) === 4) {
    const octets = value.split('.').map(Number);
    return octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
  }
  return isIP(value) === 6 && (value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:'));
}

function allowedHost(host, allowlist) {
  const value = host.toLowerCase();
  return allowlist.some((entry) => value === entry || value.endsWith(`.${entry}`));
}

async function assertBrowserTarget(rawUrl, allowlist) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw workerError('Browser URL is invalid.', 400); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw workerError('Browser URL must be HTTP(S) without credentials.', 400);
  if (!allowedHost(parsed.hostname, allowlist)) throw workerError('Browser host is not allowlisted.', 403);
  if (isPrivateAddress(parsed.hostname)) throw workerError('Browser target is a private or local address.', 403);
  const records = await lookup(parsed.hostname, { all: true }).catch(() => []);
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) throw workerError('Browser target resolves to a private or unavailable address.', 403);
  return parsed;
}

async function readResponse(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return boundedText(await response.text(), maxBytes);
  const chunks = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw workerError('Browser response is larger than the worker limit.', 413);
    }
    chunks.push(next.value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
}

async function browserWorker(action, context, limits, allowlist) {
  void context;
  let target = await assertBrowserTarget(action.url, allowlist);
  for (let redirect = 0; redirect <= limits.maxRedirects; redirect += 1) {
    const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(limits.browserTimeoutMs), headers: { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1' } }).catch((error) => {
      if (error.name === 'TimeoutError') throw workerError('Browser request timed out.', 408);
      throw workerError(`Browser request failed: ${error.message}`, 502);
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (redirect === limits.maxRedirects) throw workerError('Browser redirect limit exceeded.', 508);
      target = await assertBrowserTarget(new URL(response.headers.get('location'), target).href, allowlist);
      continue;
    }
    const body = await readResponse(response, limits.maxBrowserBytes);
    if (!response.ok) throw Object.assign(workerError(`Browser returned HTTP ${response.status}.`, 502), { output: body.text });
    return { output: body.text, metadata: { tool: action.tool, url: target.href, status: response.status, bytes: Buffer.byteLength(body.text, 'utf8') } };
  }
  throw workerError('Browser redirect limit exceeded.', 508);
}

export function createWorkerHub(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const localOnly = options.localOnly !== false;
  const allowlist = [...new Set((options.browserAllowlist || []).map((host) => String(host).trim().toLowerCase()).filter(Boolean))];
  const sandboxMode = options.sandboxMode || (process.platform === 'linux' ? 'required' : 'allowlist');
  if (!['required', 'allowlist'].includes(sandboxMode)) throw workerError(`Unsupported sandbox mode "${sandboxMode}".`, 400);
  const bubblewrapPath = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].find((candidate) => existsSync(candidate)) || null;
  const workspaceRoot = resolve(options.dataDir || process.cwd(), 'workspaces');
  return {
    limits,
    localOnly,
    sandboxMode,
    async run(action = {}, context = {}) {
      ensureContext(context);
      if (!action || typeof action.tool !== 'string') throw workerError('A structured worker action is required.', 400);
      const workspaceDistance = relative(workspaceRoot, resolve(context.workspace));
      if (workspaceDistance.startsWith(`..${sep}`) || workspaceDistance === '..' || isAbsolute(workspaceDistance)) throw workerError('Task workspace is outside the data directory.', 400);
      await mkdir(context.workspace, { recursive: true });
      if (action.tool.startsWith('file.')) return fileWorker(action, context, limits);
      if (action.tool === 'shell.exec') return shellWorker(action, context, limits, sandboxMode, bubblewrapPath);
      if (action.tool === 'browser.fetch') {
        if (localOnly) throw workerError('Local-only mode blocks browser network access.', 403);
        return browserWorker(action, context, limits, allowlist);
      }
      throw workerError(`Unsupported worker tool "${action.tool}".`, 400);
    }
  };
}

export { DEFAULT_LIMITS, resolveWorkspacePath };
