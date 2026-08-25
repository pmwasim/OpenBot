#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4178);
const url = `http://${host}:${port}`;
const noOpen = process.argv.includes('--no-open');

function ping() {
  return new Promise((resolve) => {
    const req = request(`${url}/api/health`, { timeout: 500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function waitForDaemon() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await ping()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`OpenBot did not become ready at ${url}.`);
}

async function main() {
  if (!(await ping())) {
    const child = spawn(process.execPath, [join(root, 'server.mjs')], { cwd: root, env: process.env, stdio: 'ignore', detached: true });
    child.unref();
  }
  await waitForDaemon();
  if (!noOpen) {
    const opener = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    opener.on('error', () => console.log(`OpenBot is ready at ${url}. Open this URL in a browser.`));
    opener.unref();
  }
  console.log(`OpenBot is ready at ${url}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
