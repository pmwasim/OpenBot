#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || resolve(root, '..', 'openbot-0.2.0.tar.gz'));
await mkdir(dirname(output), { recursive: true });
const args = ['-czf', output, '--exclude=.git', '--exclude=data', '--exclude=node_modules', '--exclude=.playwright-cli', '--exclude=output', '.'];
await new Promise((resolvePromise, reject) => {
  const child = spawn('tar', args, { cwd: root, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`tar exited with ${code}`)));
});
console.log(`Release package: ${output}`);
