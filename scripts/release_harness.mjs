import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = 4199;
const base = `http://127.0.0.1:${port}`;
const checks = [];
const pass = (name) => { checks.push({ name, ok: true }); console.log(`PASS ${name}`); };

async function expectFailure(operation, statusCode) {
  try {
    await operation();
  } catch (error) {
    if (statusCode !== undefined && error.statusCode !== statusCode) {
      throw new Error(`expected status ${statusCode}, got ${error.statusCode || error.message}`);
    }
    return;
  }
  throw new Error('expected operation to fail');
}

async function http(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject); req.end(options.body);
  });
}

async function streamHttp(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { ...options, headers: { accept: 'text/event-stream', ...(options.headers || {}) } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      const finish = () => resolve({ status: res.statusCode, headers: res.headers, body: data });
      res.on('data', (chunk) => {
        data += chunk;
        if (data.includes('event: done')) {
          req.destroy();
          finish();
        }
      });
      res.on('end', finish);
    });
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
    req.end(options.body);
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
    'cli/openbot.mjs',
    'desktop/openbot.mjs',
    'desktop/openbot.desktop',
    'scripts/install-ubuntu.sh',
    'scripts/uninstall-ubuntu.sh',
    '.env.example',
    'CHANGELOG.md',
    'docs/ubuntu.md'
  ];
  for (const file of required) {
    await access(join(root, file)); pass(`required file: ${file}`);
  }
  const syntaxChecks = [
    await runNode(['--check', 'desktop/openbot.mjs'], {}),
    await runNode(['--check', 'scripts/release_package.mjs'], {})
  ];
  if (syntaxChecks.some((result) => result.code !== 0)) throw new Error('release script syntax check failed');
  pass('Ubuntu launcher and release artifacts are present and syntactically valid');

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
    const safeAction = await first.createTask({
      prompt: 'list the workspace',
      kind: 'file',
      action: { tool: 'file.list', path: '.' }
    });
    if (safeAction.task.status !== 'pending' || !safeAction.task.actionDigest) throw new Error('safe action metadata');
    const gated = await first.createTask({
      prompt: 'send a draft',
      kind: 'send',
      action: { tool: 'shell.exec', command: 'echo approved' }
    });
    if (gated.policy !== 'require_approval' || !gated.approval?.taskId || !gated.approval?.actionId || !gated.approval?.actionDigest) throw new Error('bound approval');
    await first.decideApproval(gated.approval.id, 'approved');
    await first.consumeApproval(gated.approval.id, gated.approval.actionDigest);
    await expectFailure(() => first.consumeApproval(gated.approval.id, gated.approval.actionDigest), 409);
    const bundle = await first.exportTask(gated.task.id);
    if (!bundle.events.some((event) => event.type === 'approval.consumed')) throw new Error('consume event missing');
    pass('structured actions, approval digests, one-time consumption, and audit export');

    const { createWorkerHub } = await import(pathToFileURL(join(root, 'lib/workers.mjs')).href);
    const workspace = join(dataDir, 'workspaces', 'worker-task');
    await mkdir(workspace, { recursive: true });
    const workers = createWorkerHub({ dataDir, localOnly: true, sandboxMode: 'allowlist', limits: { maxOutputBytes: 256, shellTimeoutMs: 1000 } });
    const context = { taskId: 'worker-task', workspace };
    await workers.run({ tool: 'file.write', path: 'safe/note.txt', content: 'local worker' }, context);
    const read = await workers.run({ tool: 'file.read', path: 'safe/note.txt' }, context);
    if (read.output !== 'local worker') throw new Error('file worker read mismatch');
    await workers.run({ tool: 'file.delete', path: 'safe/note.txt' }, context);
    await expectFailure(() => workers.run({ tool: 'file.read', path: 'safe/note.txt' }, context), 404);
    await expectFailure(() => workers.run({ tool: 'file.read', path: '../outside.txt' }, context), 400);
    await writeFile(join(dataDir, 'outside.txt'), 'outside');
    await symlink(join(dataDir, 'outside.txt'), join(workspace, 'escape.txt'));
    await expectFailure(() => workers.run({ tool: 'file.read', path: 'escape.txt' }, context), 400);
    await expectFailure(() => workers.run({ tool: 'browser.fetch', url: 'https://example.com' }, context), 403);
    await expectFailure(() => workers.run({ tool: 'shell.exec', command: 'sleep', args: ['5'] }, context), 408);
    pass('bounded workers enforce workspace, symlink, local-only, and timeout boundaries');

    const { createExecutor } = await import(pathToFileURL(join(root, 'lib/executor.mjs')).href);
    const executor = createExecutor({ store: first, workers });
    const quick = await first.createTask({ prompt: 'create an evidence file', kind: 'file', action: { tool: 'file.write', path: 'evidence.txt', content: 'verified' } });
    await first.decideApproval(quick.approval.id, 'approved');
    await first.consumeApproval(quick.approval.id, quick.approval.actionDigest);
    await executor.start(quick.task.id);
    const completed = await first.getTask(quick.task.id);
    if (completed.status !== 'completed') throw new Error(`executor status ${completed.status}`);
    if (!(await first.listEvents({ taskId: quick.task.id })).some((event) => event.type === 'task.execution_result')) throw new Error('execution result missing');
    const slow = await first.createTask({ prompt: 'long local operation', kind: 'shell', action: { tool: 'shell.exec', command: 'sleep', args: ['5'] } });
    await first.decideApproval(slow.approval.id, 'approved');
    await first.consumeApproval(slow.approval.id, slow.approval.actionDigest);
    const running = executor.start(slow.task.id);
    await expectFailure(() => executor.start(slow.task.id), 409);
    await executor.shutdown();
    await running.catch(() => {});
    const recoverable = await first.getTask(slow.task.id);
    if (recoverable.status !== 'recoverable') throw new Error(`shutdown status ${recoverable.status}`);
    pass('executor runs approved actions once and marks shutdown work recoverable');
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
    const cliAction = await runNode(['cli/openbot.mjs', 'run', '--kind', 'file', '--action-json', '{"tool":"file.write","path":"cli-evidence.txt","content":"cli verified"}', 'harness cli action'], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' });
    if (cliAction.code !== 0) throw new Error(cliAction.output || `cli action exit ${cliAction.code}`);
    const cliApproval = JSON.parse(cliAction.output);
    if (!cliApproval.approval?.id || cliApproval.task?.status !== 'waiting_approval') throw new Error('cli action did not create approval');
    const cliApprove = await runNode(['cli/openbot.mjs', 'approve', cliApproval.approval.id], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' });
    if (cliApprove.code !== 0) throw new Error(cliApprove.output || `cli approve exit ${cliApprove.code}`);
    const cliCompleted = await second.getTask(cliApproval.task.id);
    if (cliCompleted.status !== 'completed') throw new Error(`cli action status ${cliCompleted.status}`);
    const cliExport = await runNode(['cli/openbot.mjs', 'export', cliApproval.task.id], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' });
    if (cliExport.code !== 0 || !cliExport.output.includes('task.execution_result')) throw new Error(cliExport.output || 'cli export failed');
    const cliFail = await runNode(['cli/openbot.mjs', 'show', 'missing-task-id'], { OPENBOT_DATA_DIR: dataDir });
    if (cliFail.code === 0) throw new Error('show missing should fail');
    pass('CLI creates, approves, executes, exports tasks, and fails on missing show');

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
      const configResponse = await http('/api/config');
      const publicConfig = JSON.parse(configResponse.body);
      if (configResponse.status !== 200 || publicConfig.localOnly !== true || JSON.stringify(publicConfig).includes('secret-value')) throw new Error('invalid public config');
      pass('public config reports local-only mode without secrets');
      const taskResponse = await http('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          prompt: 'write a release evidence file',
          kind: 'file',
          action: { tool: 'file.write', path: 'api-evidence.txt', content: 'api verified' }
        })
      });
      const taskPayload = JSON.parse(taskResponse.body);
      if (taskResponse.status !== 201 || !taskPayload.task?.id || !taskPayload.approval?.id) throw new Error(`task create ${taskResponse.status} ${taskResponse.body}`);
      const approveResponse = await http(`/api/tasks/${encodeURIComponent(taskPayload.task.id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approvalId: taskPayload.approval.id })
      });
      if (approveResponse.status !== 202) throw new Error(`task approve ${approveResponse.status} ${approveResponse.body}`);
      let taskState;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const current = await http(`/api/tasks/${encodeURIComponent(taskPayload.task.id)}`);
        taskState = JSON.parse(current.body);
        if (taskState.task?.status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (taskState.task?.status !== 'completed') throw new Error(`task did not complete: ${JSON.stringify(taskState)}`);
      const listed = JSON.parse((await http('/api/tasks')).body).tasks;
      if (!listed.some((item) => item.id === taskPayload.task.id)) throw new Error('task list missing task');
      const taskEvents = JSON.parse((await http(`/api/tasks/${encodeURIComponent(taskPayload.task.id)}/events`)).body).events;
      if (!taskEvents.some((event) => event.type === 'task.execution_result')) throw new Error('task events missing result');
      const stream = await streamHttp(`/api/tasks/${encodeURIComponent(taskPayload.task.id)}/stream`);
      if (stream.status !== 200 || !stream.body.includes('event: done')) throw new Error('task stream missing done');
      const exported = await http(`/api/tasks/${encodeURIComponent(taskPayload.task.id)}/export`);
      if (exported.status !== 200 || !String(exported.headers['content-disposition']).includes('attachment')) throw new Error('audit export headers');
      pass('task API, approval, execution, list/show/events, SSE, and audit export work end-to-end');
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
