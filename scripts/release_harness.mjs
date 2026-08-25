import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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


function parseCliJson(output) {
  const text = String(output || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`CLI did not return JSON: ${text.slice(0, 400)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
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
    'lib/engine.mjs',
    'lib/runtime.mjs',
    'lib/sandbox.mjs',
    'lib/workers/file.mjs',
    'lib/workers/shell.mjs',
    'lib/workers/browser.mjs',
    'cli/openbot.mjs',
    'fixtures/file/notes.txt',
    'fixtures/browser/research.html'
  ];
  for (const file of required) {
    await access(join(root, file)); pass(`required file: ${file}`);
  }

  const { decide, REQUIRE_APPROVAL_KINDS } = await import(pathToFileURL(join(root, 'lib/policy.mjs')).href);
  for (const kind of REQUIRE_APPROVAL_KINDS) {
    if (decide({ kind }) !== 'require_approval') throw new Error(`policy(${kind})`);
  }
  if (decide({ kind: 'plan' }) !== 'allow') throw new Error('policy(plan)');
  if (decide({ tool: 'file.write', args: { path: 'notes.txt', contents: 'x' }, workspace: '/tmp/ws' }) !== 'require_approval') {
    throw new Error('policy(file.write)');
  }
  if (decide({ tool: 'file.write', args: { path: '/tmp/escape.txt', contents: 'x' }, workspace: '/tmp/ws' }) !== 'deny') {
    throw new Error('policy(file.write escape)');
  }
  if (decide({ tool: 'shell.exec', args: { command: 'uname' }, workspace: '/tmp/ws' }) !== 'allow') {
    throw new Error('policy(shell uname)');
  }
  if (decide({ tool: 'shell.exec', args: { command: 'rm -rf /' }, workspace: '/tmp/ws' }) !== 'deny') {
    throw new Error('policy(shell destructive)');
  }
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
  const fileWs = await mkdtemp(join(tmpdir(), 'openbot-file-'));
  const shellWs = await mkdtemp(join(tmpdir(), 'openbot-shell-'));
  const browserWs = await mkdtemp(join(tmpdir(), 'openbot-browser-'));
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

    const { createEngine } = await import(pathToFileURL(join(root, 'lib/engine.mjs')).href);
    const engine = createEngine({ store: first, actor: 'harness' });

    const fixtureNotes = await readFile(join(root, 'fixtures/file/notes.txt'), 'utf8');
    await writeFile(join(fileWs, 'notes.txt'), fixtureNotes.endsWith('\n') ? fixtureNotes : `${fixtureNotes}\n`);
    const proposed = await engine.act({
      workspace: fileWs,
      tool: 'file.write',
      args: { path: 'notes.txt', contents: 'hello openbot\n' }
    });
    if (proposed.status !== 'needs_approval' || !proposed.approval?.id) {
      throw new Error(`file propose status ${proposed.status} ${proposed.result?.reason || ''}`);
    }
    if (!String(proposed.diff || '').includes('-hello world') || !String(proposed.diff || '').includes('+hello openbot')) {
      throw new Error(`file diff missing expected lines: ${proposed.diff}`);
    }
    const unapproved = await readFile(join(fileWs, 'notes.txt'), 'utf8');
    if (unapproved.trim() !== 'hello world') throw new Error('file wrote before approval');
    await first.decideApproval(proposed.approval.id, 'approved');
    const written = await engine.act({
      workspace: fileWs,
      tool: 'file.write',
      args: { path: 'notes.txt', contents: 'hello openbot\n' },
      approvalId: proposed.approval.id,
      taskId: proposed.taskId
    });
    if (!written.ok) throw new Error(`file write failed: ${written.result?.reason || written.result?.error || ''}`);
    const approvedContents = await readFile(join(fileWs, 'notes.txt'), 'utf8');
    if (approvedContents !== 'hello openbot\n') throw new Error('approved write did not persist');
    const reused = await engine.act({
      workspace: fileWs,
      tool: 'file.write',
      args: { path: 'notes.txt', contents: 'hello openbot\n' },
      approvalId: proposed.approval.id,
      taskId: proposed.taskId
    });
    if (reused.status !== 'denied') throw new Error(`one-shot approval reused: ${reused.status}`);
    const escaped = await engine.act({
      workspace: fileWs,
      tool: 'file.write',
      args: { path: '../escape.txt', contents: 'nope\n' }
    });
    if (escaped.status !== 'denied') throw new Error(`relative escape status ${escaped.status}`);
    const absoluteEscapePath = join(tmpdir(), 'openbot-phase1-escape.txt');
    const absolute = await engine.act({
      workspace: fileWs,
      tool: 'file.write',
      args: { path: absoluteEscapePath, contents: 'nope\n' }
    });
    if (absolute.status !== 'denied') throw new Error(`absolute escape status ${absolute.status}`);
    if (existsSync(absoluteEscapePath)) throw new Error('write escaped to temp dir');
    pass('FILE benchmark: diff, one-shot approval, workspace isolation');

    const safe = await engine.act({
      workspace: shellWs,
      tool: 'shell.exec',
      args: { command: 'uname' }
    });
    if (!safe.ok || !String(safe.result?.stdout || '').trim()) {
      throw new Error(`safe shell failed: ${JSON.stringify(safe.result)}`);
    }
    const destructive = await engine.act({
      workspace: shellWs,
      tool: 'shell.exec',
      args: { command: 'rm -rf /' }
    });
    if (destructive.status !== 'denied') throw new Error(`rm -rf / status ${destructive.status}`);
    const rmOutside = await engine.act({
      workspace: shellWs,
      tool: 'shell.exec',
      args: { command: `rm ${absoluteEscapePath}` }
    });
    if (rmOutside.status !== 'denied') throw new Error(`rm outside status ${rmOutside.status}`);
    pass('SHELL benchmark: sandboxed uname, destructive commands refused');

    const cliEnv = { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' };
    const cliPropose = await runNode([
      'cli/openbot.mjs', 'act', '--workspace', fileWs, '--tool', 'file.write',
      '--path', 'cli.txt', '--contents', 'from cli\n'
    ], cliEnv, { timeoutMs: 20000 });
    const cliProposed = parseCliJson(cliPropose.output);
    if (cliProposed.status !== 'needs_approval' || !cliProposed.approval?.id) {
      throw new Error(`CLI file propose: ${cliPropose.output}`);
    }
    if (existsSync(join(fileWs, 'cli.txt'))) throw new Error('CLI wrote before approval');
    const cliApprove = await runNode(['cli/openbot.mjs', 'approve', cliProposed.approval.id], cliEnv);
    if (cliApprove.code !== 0) throw new Error(cliApprove.output || 'CLI approve failed');
    const cliWrite = await runNode([
      'cli/openbot.mjs', 'act', '--workspace', fileWs, '--tool', 'file.write',
      '--path', 'cli.txt', '--contents', 'from cli\n',
      '--approval', cliProposed.approval.id, '--task', cliProposed.taskId
    ], cliEnv, { timeoutMs: 20000 });
    const cliWritten = parseCliJson(cliWrite.output);
    if (!cliWritten.ok) throw new Error(`CLI file execute: ${cliWrite.output}`);
    const cliBody = await readFile(join(fileWs, 'cli.txt'), 'utf8');
    if (cliBody !== 'from cli\n') throw new Error(`CLI write mismatch ${JSON.stringify(cliBody)}`);
    pass('CLI file.write requires approval before write');

    const cliShell = await runNode([
      'cli/openbot.mjs', 'act', '--workspace', shellWs, '--tool', 'shell.exec', '--command', 'uname'
    ], cliEnv, { timeoutMs: 30000 });
    const cliShellJson = parseCliJson(cliShell.output);
    if (!cliShellJson.ok || !String(cliShellJson.result?.stdout || '').trim()) {
      throw new Error(`CLI shell: ${cliShell.output}`);
    }
    const cliRm = await runNode([
      'cli/openbot.mjs', 'act', '--workspace', shellWs, '--tool', 'shell.exec', '--command', 'rm -rf /'
    ], cliEnv, { timeoutMs: 15000 });
    const cliRmJson = parseCliJson(cliRm.output);
    if (cliRmJson.status !== 'denied') throw new Error(`CLI destructive: ${cliRm.output}`);
    pass('CLI shell.exec runs uname and refuses unapproved rm -rf /');

    const html = await readFile(join(root, 'fixtures/browser/research.html'), 'utf8');
    const fixture = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await listen(fixture);
    try {
      const address = fixture.address();
      const fixtureUrl = `http://127.0.0.1:${address.port}/research`;
      const fetched = await engine.act({
        workspace: browserWs,
        tool: 'browser.fetch',
        args: { url: fixtureUrl, path: 'research.md' }
      });
      if (!fetched.ok) throw new Error(`browser fetch failed: ${fetched.result?.reason || fetched.result?.error || ''}`);
      const markdown = await readFile(join(browserWs, 'research.md'), 'utf8');
      if (!markdown.includes(fixtureUrl)) throw new Error('markdown missing cited URL');
      if (!/OpenBot Research Fixture/i.test(markdown)) throw new Error('markdown missing fixture heading');
      const blocked = await engine.act({
        workspace: browserWs,
        tool: 'browser.fetch',
        args: { url: 'http://example.com/', path: 'blocked.md' }
      });
      if (blocked.status !== 'denied') throw new Error(`non-allowlisted fetch status ${blocked.status}`);
      if (existsSync(join(browserWs, 'blocked.md'))) throw new Error('blocked fetch wrote a file');

      const cliBrowser = await runNode([
        'cli/openbot.mjs', 'act', '--workspace', browserWs, '--tool', 'browser.fetch',
        '--url', fixtureUrl, '--path', 'cli-research.md'
      ], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' }, { timeoutMs: 20000 });
      const cliBrowserJson = parseCliJson(cliBrowser.output);
      if (!cliBrowserJson.ok) throw new Error(`CLI browser: ${cliBrowser.output}`);
      const cliMd = await readFile(join(browserWs, 'cli-research.md'), 'utf8');
      if (!cliMd.includes(fixtureUrl)) throw new Error('CLI markdown missing cited URL');
      pass('CLI browser.fetch saves cited Markdown for an allowlisted URL');
    } finally {
      await closeServer(fixture);
    }
    pass('BROWSER benchmark: allowlisted loopback fetch saved cited markdown');

    const auditEvents = await first.listEvents();
    const actions = auditEvents.filter((event) => String(event.type).startsWith('action.'));
    if (actions.length < 8) throw new Error(`expected action events, got ${actions.length}`);
    for (const event of actions) {
      const actor = event.actor || event.payload?.actor;
      const tool = event.tool || event.payload?.tool;
      const args = event.args ?? event.payload?.args;
      const result = event.result ?? event.payload?.result;
      if (!actor || !tool || args == null || result == null || !event.ts) {
        throw new Error(`audit fields missing on ${event.type} seq=${event.seq}`);
      }
    }
    const byTool = new Map();
    for (const event of actions) {
      const tool = event.tool || event.payload?.tool;
      const types = byTool.get(tool) || new Set();
      types.add(event.type);
      byTool.set(tool, types);
    }
    if (!byTool.get('file.write')?.has('action.executed') || !byTool.get('file.write')?.has('action.denied')) {
      throw new Error('file.write audit trail incomplete');
    }
    if (!byTool.get('shell.exec')?.has('action.executed') || !byTool.get('shell.exec')?.has('action.denied')) {
      throw new Error('shell.exec audit trail incomplete');
    }
    if (!byTool.get('browser.fetch')?.has('action.executed')) {
      throw new Error('browser.fetch audit trail incomplete');
    }
    pass('consequential actions have actor/tool/args/result/timestamp events');
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await rm(fileWs, { recursive: true, force: true }).catch(() => {});
    await rm(shellWs, { recursive: true, force: true }).catch(() => {});
    await rm(browserWs, { recursive: true, force: true }).catch(() => {});
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length) process.exitCode = 1;
  console.log(`Release harness: ${checks.length - failed.length}/${checks.length} passed.`);
}

main().catch((error) => { console.error(`Release harness failed: ${error.message}`); process.exitCode = 1; });
