import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { unifiedDiff } from '../diff.mjs';
import { isInsideWorkspace, resolveWorkspacePath, workspaceEscape } from '../sandbox.mjs';

const NOFOLLOW = constants.O_NOFOLLOW;

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openVerified(resolved, flags, mode) {
  if (!Number.isInteger(NOFOLLOW)) {
    throw workspaceEscape('Host file access requires an operating system no-follow primitive.');
  }
  const handle = await open(resolved.path, flags | NOFOLLOW, mode);
  try {
    const [actualPath, pathStats, handleStats] = await Promise.all([
      realpath(resolved.path),
      stat(resolved.path),
      handle.stat()
    ]);
    if (!isInsideWorkspace(resolved.root, actualPath) || actualPath === resolved.root || !sameFile(pathStats, handleStats)) {
      throw workspaceEscape(`Path changed during access: ${resolved.relative}`);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readVerified(resolved, { maxBytes = null } = {}) {
  const handle = await openVerified(resolved, constants.O_RDONLY);
  try {
    if (maxBytes != null && (await handle.stat()).size > maxBytes) throw Object.assign(new Error('File is too large for a bounded preview.'), { statusCode: 413, code: 'OPENBOT_FILE_TOO_LARGE' });
    const contents = await handle.readFile('utf8');
    if (maxBytes != null && Buffer.byteLength(contents, 'utf8') > maxBytes) throw Object.assign(new Error('File is too large for a bounded preview.'), { statusCode: 413, code: 'OPENBOT_FILE_TOO_LARGE' });
    return contents;
  } finally {
    await handle.close();
  }
}

export async function fileRead(workspace, path, options = {}) {
  const resolved = await resolveWorkspacePath(workspace, path, { mustExist: true });
  const contents = await readVerified(resolved, options);
  return { path: resolved.relative, contents };
}

export async function fileDiff(workspace, path, contents) {
  const resolved = await resolveWorkspacePath(workspace, path, { mustExist: false });
  let previous = '';
  try { previous = await readVerified(resolved); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const next = contents == null ? '' : String(contents);
  return {
    path: resolved.relative,
    absPath: resolved.path,
    previous,
    next,
    diff: unifiedDiff(previous, next, resolved.relative)
  };
}

export async function fileWrite(workspace, path, contents) {
  const resolved = await resolveWorkspacePath(workspace, path, { mustExist: false });
  const body = contents == null ? '' : String(contents);
  const handle = await openVerified(resolved, constants.O_WRONLY | constants.O_CREAT, 0o600);
  try {
    await handle.truncate(0);
    await handle.writeFile(body, 'utf8');
  } finally {
    await handle.close();
  }
  return { path: resolved.relative, bytes: Buffer.byteLength(body) };
}
