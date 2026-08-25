import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const port = 4199;
const base = `http://127.0.0.1:${port}`;
const checks = [];
const pass = (name) => { checks.push({ name, ok: true }); console.log(`PASS ${name}`); };
const fail = (name, error) => { checks.push({ name, ok: false }); console.error(`FAIL ${name}: ${error}`); };

async function http(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject); req.end(options.body);
  });
}

async function main() {
  for (const file of ['server.mjs', 'public/app.js', 'public/index.html', 'PRD.md', 'LICENSE']) {
    await access(join(root, file)); pass(`required file: ${file}`);
  }
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { const response = await http('/api/health'); if (response.status === 200) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const health = await http('/api/health');
    if (health.status !== 200) throw new Error(`status ${health.status}`); pass('health endpoint responds');
    const state = await http('/api/state');
    if (state.status !== 200 || !JSON.parse(state.body).approvals) throw new Error('invalid state'); pass('state endpoint responds with approvals');
    const invalidModel = await http('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'test', model: '__not_installed__' }) });
    if (![400, 503].includes(invalidModel.status)) throw new Error(`status ${invalidModel.status}`); pass('uninstalled model is rejected');
    const oversized = await http('/api/approval', { method: 'POST', body: JSON.stringify({ id: 'x', decision: 'x', padding: 'a'.repeat(70000) }) });
    if (oversized.status !== 413) throw new Error(`status ${oversized.status}`); pass('oversized request is rejected');
    const traversal = await http('/../server.mjs');
    if (traversal.status !== 404) throw new Error(`status ${traversal.status}`); pass('path traversal is rejected');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    if (output.includes('EADDRINUSE')) throw new Error(output);
  }
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) process.exitCode = 1;
  console.log(`Release harness: ${checks.length - failed.length}/${checks.length} checks passed.`);
}

main().catch((error) => { console.error(`Release harness failed: ${error.message}`); process.exitCode = 1; });
