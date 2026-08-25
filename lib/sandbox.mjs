import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let isolationCache = null;

export async function detectIsolation(env = process.env) {
  if (isolationCache) return isolationCache;
  const requested = String(env.OPENBOT_ISOLATION || 'auto').trim().toLowerCase();
  if (requested === 'cwd') {
    isolationCache = { mode: 'cwd', image: null, reason: 'OPENBOT_ISOLATION=cwd' };
    return isolationCache;
  }
  try {
    await execFileAsync('docker', ['info', '-f', '{{.ServerVersion}}'], { timeout: 4000, encoding: 'utf8' });
    isolationCache = { mode: 'docker', image: env.OPENBOT_DOCKER_IMAGE || 'alpine:3.20', reason: 'Docker engine is available.' };
    return isolationCache;
  } catch (error) {
    isolationCache = { mode: 'cwd', image: null, reason: error.message || 'Docker is not available.' };
    return isolationCache;
  }
}


export function workspaceEscape(message) {
  const error = new Error(message);
  error.code = 'OPENBOT_WORKSPACE_ESCAPE';
  error.statusCode = 403;
  return error;
}

export function isInsideWorkspace(root, target) {
  const rel = relative(root, target);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function isInsideWorkspaceSync(workspace, inputPath) {
  if (inputPath == null || String(inputPath).trim() === '') return false;
  const root = resolve(workspace);
  const candidate = resolve(root, String(inputPath));
  return isInsideWorkspace(root, candidate) && candidate !== root;
}

export async function resolveWorkspacePath(workspace, inputPath, { mustExist = false } = {}) {
  if (inputPath == null || String(inputPath).trim() === '') {
    throw workspaceEscape('Path is required.');
  }
  const root = await realpath(workspace);
  const requested = resolve(root, String(inputPath));
  const suffix = [];
  let current = requested;
  while (true) {
    try {
      const real = await realpath(current);
      const finalPath = suffix.length ? join(real, ...suffix.reverse()) : real;
      if (!isInsideWorkspace(root, finalPath) || finalPath === root) {
        throw workspaceEscape(`Path escapes workspace: ${inputPath}`);
      }
      if (mustExist && suffix.length) {
        const error = new Error(`Path not found: ${inputPath}`);
        error.code = 'ENOENT';
        error.statusCode = 404;
        throw error;
      }
      if (mustExist) {
        await lstat(finalPath);
      }
      return {
        root,
        path: finalPath,
        relative: relative(root, finalPath)
      };
    } catch (error) {
      if (error.code === 'OPENBOT_WORKSPACE_ESCAPE' || error.statusCode === 404) throw error;
      if (error.code !== 'ENOENT') throw error;
      suffix.push(basename(current));
      const parent = dirname(current);
      if (parent === current) throw workspaceEscape(`Path escapes workspace: ${inputPath}`);
      current = parent;
    }
  }
}
