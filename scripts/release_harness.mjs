import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = 4199;
const base = `http://127.0.0.1:${port}`;
const checks = [];
const pass = (name) => { checks.push({ name, ok: true }); console.log(`PASS ${name}`); };

async function http(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject); req.end(options.body);
  });
}

function runNode(args, env, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function main() {
  const required = [
    'server.mjs',
    'public/app.js',
    'public/index.html',
    'PRD.md',
    'LICENSE',
    'lib/store.mjs',
    'lib/policy.mjs',
    'lib/provider.mjs',
    'lib/loopback.mjs',
    'cli/openbot.mjs'
  ];
  for (const file of required) {
    await access(join(root, file)); pass(`required file: ${file}`);
  }

  const { decide, REQUIRE_APPROVAL_KINDS } = await import(pathToFileURL(join(root, 'lib/policy.mjs')).href);
  for (const kind of REQUIRE_APPROVAL_KINDS) {
    if (decide({ kind }) !== 'require_approval') throw new Error(`policy(${kind})`);
  }
  if (decide({ kind: 'plan' }) !== 'allow') throw new Error('policy(plan)');
  pass('policy requires approval for send/publish/purchase/delete/production-change');

  const { assertBindHost, isLoopbackHost } = await import(pathToFileURL(join(root, 'lib/loopback.mjs')).href);
  if (!isLoopbackHost('127.0.0.1') || isLoopbackHost('0.0.0.0')) throw new Error('loopback helper');
  let refused = false;
  try { assertBindHost('0.0.0.0', {}); } catch { refused = true; }
  if (!refused) throw new Error('expected non-loopback refuse');
  const overridden = assertBindHost('0.0.0.0', { OPENBOT_ALLOW_NON_LOOPBACK: '1' });
  if (!overridden.overridden) throw new Error('expected override');
  pass('loopback bind is refused unless explicitly overridden');

  const { createProviderHub, redactSecrets, createOpenAICompatibleAdapter } = await import(pathToFileURL(join(root, 'lib/provider.mjs')).href);
  const hub = createProviderHub({ OPENBOT_OPENAI_API_KEY: 'sk-secret-value' });
  if (!hub.localOnly || hub.ollama.baseUrl !== 'http://127.0.0.1:11434') throw new Error('ollama default');
  if (createOpenAICompatibleAdapter().enabled) throw new Error('openai should be disabled');
  const redacted = redactSecrets({ apiKey: 'sk-secret-value', model: 'local' });
  if (redacted.apiKey !== '[redacted]' || redacted.model !== 'local') throw new Error('redact');
  if (JSON.stringify(hub.describe()).includes('sk-secret-value')) throw new Error('secret leaked');
  pass('provider hub defaults to local Ollama and redacts secrets');

  const dataDir = await mkdtemp(join(tmpdir(), 'openbot-harness-'));
  const { openStore } = await import(pathToFileURL(join(root, 'lib/store.mjs')).href);
  try {
    await writeFile(join(dataDir, 'state.json'), JSON.stringify({
      approvals: [{ id: 'legacy-1', title: 'Legacy approval', detail: 'migrated from state.json', status: 'waiting' }],
      routines: [{ id: 'legacy-routine', title: 'Legacy routine', schedule: 'daily', enabled: true }]
    }));
    const first = await openStore({ dataDir });
    const migrated = await first.getState();
    if (!migrated.approvals.some((item) => item.id === 'legacy-1')) throw new Error('legacy approval missing');
    const created = await first.createTask({ prompt: 'phase0 durability', kind: 'plan' });
    if (!created.task?.id || created.task.status !== 'pending') throw new Error('create task');
    const gated = await first.createTask({ prompt: 'send a draft', kind: 'send' });
    if (gated.policy !== 'require_approval' || !gated.approval?.taskId || !gated.approval?.actionId) throw new Error('bound approval');
    const second = await openStore({ dataDir });
    const reloaded = await second.getTask(created.task.id);
    if (!reloaded || reloaded.prompt !== 'phase0 durability') throw new Error('reload lost task');
    const events = await second.listEvents({ taskId: created.task.id });
    if (!events.length) throw new Error('reload lost events');
    pass('store migrates legacy state and survives reopen');

    const cliRun = await runNode(['cli/openbot.mjs', 'run', '--kind', 'plan', 'harness cli task'], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' });
    if (cliRun.code !== 0) throw new Error(cliRun.output || `cli run exit ${cliRun.code}`);
    const listed = await second.listTasks();
    if (!listed.some((task) => task.prompt === 'harness cli task')) throw new Error('cli run did not persist');
    const cliFail = await runNode(['cli/openbot.mjs', 'show', 'missing-task-id'], { OPENBOT_DATA_DIR: dataDir });
    if (cliFail.code === 0) throw new Error('show missing should fail');
    pass('CLI run persists a task and fails on missing show');

    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), OPENBOT_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try { const response = await http('/api/health'); if (response.status === 200) break; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const health = await http('/api/health');
      if (health.status !== 200) throw new Error(`health status ${health.status} ${output}`); pass('health endpoint responds');
      const state = await http('/api/state');
      const parsed = JSON.parse(state.body);
      if (state.status !== 200 || !parsed.approvals) throw new Error('invalid state');
      pass('state endpoint responds with approvals');
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

    const denied = await runNode(['server.mjs'], { HOST: '0.0.0.0', PORT: '4211', OPENBOT_DATA_DIR: dataDir }, { timeoutMs: 4000 });
    if (denied.code === 0) throw new Error('server accepted non-loopback bind');
    if (!denied.output.includes('OPENBOT_ALLOW_NON_LOOPBACK')) throw new Error(denied.output || 'missing refuse message');
    pass('server refuses non-loopback bind without override');
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length) process.exitCode = 1;
  console.log(`Release harness: ${checks.length - failed.length}/${checks.length} passed.`);
}

main().catch((error) => { console.error(`Release harness failed: ${error.message}`); process.exitCode = 1; });
