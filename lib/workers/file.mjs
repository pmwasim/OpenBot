import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { unifiedDiff } from '../diff.mjs';
import { resolveWorkspacePath } from '../sandbox.mjs';

export async function fileRead(workspace, path) {
  const resolved = await resolveWorkspacePath(workspace, path, { mustExist: true });
  const contents = await readFile(resolved.path, 'utf8');
  return { path: resolved.relative, contents };
}

export async function fileDiff(workspace, path, contents) {
  const resolved = await resolveWorkspacePath(workspace, path, { mustExist: false });
  let previous = '';
  try {
    previous = await readFile(resolved.path, 'utf8');
  } catch (error) {
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
  await mkdir(dirname(resolved.path), { recursive: true });
  const body = contents == null ? '' : String(contents);
  await writeFile(resolved.path, body, 'utf8');
  return { path: resolved.relative, bytes: Buffer.byteLength(body) };
}
