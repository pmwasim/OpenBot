import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  return httpOn(port, path, options);
}

async function httpOn(targetPort, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${targetPort}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } }, (res) => {
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
    'CHANGELOG.md',
    'SECURITY.md',
    'LICENSE',
    'lib/store.mjs',
    'lib/routines.mjs',
    'lib/policy.mjs',
    'lib/provider.mjs',
    'lib/daemon.mjs',
    'lib/client.mjs',
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
  const indexSource = await readFile(join(root, 'public/index.html'), 'utf8');
  const appSource = await readFile(join(root, 'public/app.js'), 'utf8');
  if (!indexSource.includes('id="workspace"') || !indexSource.includes('id="task-form"') || !indexSource.includes('id="recent-tasks"') || !indexSource.includes('id="memories"') || !indexSource.includes('id="memory-form"') || !indexSource.includes('id="skills"') || !indexSource.includes('id="skill-form"') || !indexSource.includes('id="routine-form"') || !indexSource.includes('id="routine-schedule"') || !indexSource.includes('id="bot"') || !indexSource.includes('id="bot-form"') || !indexSource.includes('id="bot-name"')) throw new Error('dashboard is missing workspace, bot, task history, memory, skill, or routine controls');
  if (!appSource.includes('workspace') || !appSource.includes('action-card') || !appSource.includes('/audit') || !appSource.includes('/resume') || !appSource.includes('resumeTask') || !appSource.includes('Resume') || !appSource.includes('/api/tasks') || !appSource.includes('/api/tasks/') || !appSource.includes('after=') || !appSource.includes('/api/memories') || !appSource.includes('/api/skills') || !appSource.includes('/api/routines') || !appSource.includes('/api/bots') || !appSource.includes('Run now') || !appSource.includes('botId') || !appSource.includes('skill')) throw new Error('dashboard does not expose agent actions, recovery, task history, live activity, memory, skills, routines, bots, and audit links');
  if (appSource.includes('e.innerHTML=`')) throw new Error('dashboard renders state with unsafe innerHTML');
  pass('dashboard exposes workspace, action cards, and audit links safely');
  const publicSurfaceFiles = ['README.md', 'PRD.md', 'SECURITY.md', 'CHANGELOG.md', 'cli/openbot.mjs', 'server.mjs', 'lib/config.mjs', 'lib/provider.mjs', 'lib/daemon.mjs', 'lib/client.mjs', 'lib/agent.mjs', 'lib/store.mjs', 'public/index.html', 'public/app.js', 'public/styles.css'];
  const forbiddenPublicBrand = /\b(?:Grok|Ollama|OpenAI|Anthropic|Gemini|Claude|Cursor|Groq)\b|x\.ai/i;
  for (const file of publicSurfaceFiles) {
    const source = await readFile(join(root, file), 'utf8');
    if (forbiddenPublicBrand.test(source.replace(/\bcursor\s*:/gi, ''))) throw new Error(`public brand reference in ${file}`);
  }
  pass('public repository surfaces are brand-neutral');

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
  if (decide({ tool: 'browser.fetch', args: { url: 'http://127.0.0.1:1234/' }, workspace: '/tmp/ws' }) !== 'require_approval') {
    throw new Error('policy(browser.fetch approval)');
  }
  if (decide({ tool: 'shell.exec', args: { command: 'uname' }, workspace: '/tmp/ws' }) !== 'allow') {
    throw new Error('policy(shell uname)');
  }
  if (decide({ tool: 'shell.exec', args: { command: 'rm -rf /' }, workspace: '/tmp/ws' }) !== 'deny') {
    throw new Error('policy(shell destructive)');
  }
  if (decide({ tool: 'shell.exec', args: { command: 'node -e test' }, workspace: '/tmp/ws' }) !== 'deny') throw new Error('policy(node execution)');
  if (decide({ tool: 'shell.exec', args: { command: 'ls /etc' }, workspace: '/tmp/ws' }) !== 'deny') throw new Error('policy(ls escape)');
  pass('policy requires approval for send/publish/purchase/delete/production-change');

  const { assertBindHost, isLoopbackHost, hasBearerToken } = await import(pathToFileURL(join(root, 'lib/loopback.mjs')).href);
  if (!isLoopbackHost('127.0.0.1') || isLoopbackHost('0.0.0.0')) throw new Error('loopback helper');
  let refused = false;
  try { assertBindHost('0.0.0.0', {}); } catch { refused = true; }
  if (!refused) throw new Error('expected non-loopback refuse');
  const overridden = assertBindHost('0.0.0.0', { OPENBOT_ALLOW_NON_LOOPBACK: '1' });
  if (!overridden.overridden) throw new Error('expected override');
  if (!hasBearerToken({ headers: { authorization: 'Bearer local-secret' } }, 'local-secret') || hasBearerToken({ headers: { authorization: 'Bearer wrong' } }, 'local-secret')) throw new Error('bearer auth helper');
  pass('loopback bind is refused unless explicitly overridden');

  const { createProviderHub, redactSecrets, createRemoteCompatibleAdapter } = await import(pathToFileURL(join(root, 'lib/provider.mjs')).href);
  const hub = createProviderHub({ OPENBOT_REMOTE_API_KEY: 'sk-secret-value' });
  if (!hub.localOnly || hub.localModel.baseUrl !== 'http://127.0.0.1:11434') throw new Error('local model default');
  if (createRemoteCompatibleAdapter().enabled) throw new Error('remote-compatible provider should be disabled');
  const redacted = redactSecrets({ apiKey: 'sk-secret-value', model: 'local' });
  if (redacted.apiKey !== '[redacted]' || redacted.model !== 'local') throw new Error('redact');
  if (JSON.stringify(hub.describe()).includes('sk-secret-value')) throw new Error('secret leaked');
  let remoteModelRejected = false;
  try { createProviderHub({ OPENBOT_MODEL_URL: 'http://example.com:11434' }); } catch { remoteModelRejected = true; }
  if (!remoteModelRejected) throw new Error('remote model endpoint should require opt-in');
  if (!createProviderHub({ OPENBOT_LOCAL_ONLY: '0', OPENBOT_MODEL_URL: 'http://example.com:11434' }).localModel.baseUrl.includes('example.com')) throw new Error('explicit remote model opt-in');
  pass('provider hub defaults to the local model and redacts secrets');

  const protocolFixture = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'small-local' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      let requestBody = '';
      for await (const chunk of req) requestBody += chunk;
      const parsed = JSON.parse(requestBody);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: `protocol:${parsed.model}` }) } }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await listen(protocolFixture);
  try {
    const protocolPort = protocolFixture.address().port;
    const protocolHub = createProviderHub({ OPENBOT_MODEL_PROTOCOL: 'chat-completions', OPENBOT_MODEL_URL: `http://127.0.0.1:${protocolPort}` });
    const protocolTags = await protocolHub.localModel.tags();
    const protocolReply = await protocolHub.localModel.chatStructured({ model: 'small-local', messages: [{ role: 'user', content: 'test' }], tools: [] });
    if (protocolHub.localModel.protocol !== 'chat-completions' || !protocolTags.models.includes('small-local') || !protocolReply.ok || !protocolReply.reply.includes('protocol:small-local')) throw new Error('chat-completions protocol adapter');
  } finally {
    await closeServer(protocolFixture);
  }
  pass('chat-completions local model protocol works without changing the default');

  const { loadConfig, publicConfig } = await import(pathToFileURL(join(root, 'lib/config.mjs')).href);
  const legacyConfig = loadConfig({ OPENBOT_RESOURCE_PROFILE: 'legacy' });
  if (legacyConfig.resourceProfile !== 'legacy' || legacyConfig.agentMaxTurns !== 3 || legacyConfig.agentMaxActions !== 3 || legacyConfig.isolation !== 'cwd') {
    throw new Error(`legacy profile defaults ${JSON.stringify(legacyConfig)}`);
  }
  if (publicConfig(legacyConfig).resourceProfile !== 'legacy') throw new Error('legacy profile is not public');
  const protocolConfig = loadConfig({ OPENBOT_MODEL_PROTOCOL: 'chat-completions' });
  if (protocolConfig.modelProtocol !== 'chat-completions' || publicConfig(protocolConfig).modelProtocol !== 'chat-completions') throw new Error('model protocol configuration');
  const pidConfig = loadConfig({ OPENBOT_DATA_DIR: '/tmp/openbot-test-data' });
  if (pidConfig.pidFile !== '/tmp/openbot-test-data/openbot.pid') throw new Error(`daemon pid path ${pidConfig.pidFile}`);
  pass('legacy resource profile caps agent work for older CPU-only laptops');

  const { parseAgentEnvelope, createAgentController } = await import(pathToFileURL(join(root, 'lib/agent.mjs')).href);
  const parsedReply = parseAgentEnvelope(JSON.stringify({ reply: 'Ready.' }));
  if (parsedReply.reply !== 'Ready.' || parsedReply.action !== null) throw new Error('agent reply envelope');
  const parsedAction = parseAgentEnvelope(JSON.stringify({ action: { tool: 'file.read', args: { path: 'notes.txt' } } }));
  if (parsedAction.action.tool !== 'file.read' || parsedAction.reply !== null) throw new Error('agent action envelope');
  let malformedRejected = false;
  try { parseAgentEnvelope('{"reply":"a","action":{"tool":"file.read","args":{}}}'); } catch { malformedRejected = true; }
  if (!malformedRejected) throw new Error('agent should reject two-part envelope');
  let unknownRejected = false;
  try { parseAgentEnvelope(JSON.stringify({ action: { tool: 'shell.exec;rm', args: {} } })); } catch { unknownRejected = true; }
  if (!unknownRejected) throw new Error('agent should reject unknown tool');

  function fakeAgentStore() {
    const events = [];
    return {
      events,
      async createTask(input) { return { task: { id: 'task-agent-harness', ...input, status: 'pending' } }; },
      async append(event) { events.push(event); return event; },
      async getTask() { return { id: 'task-agent-harness', workspace: '/tmp/agent-harness' }; },
      async listEvents() { return events; }
    };
  }
  const loopStore = fakeAgentStore();
  const loopReplies = [
    JSON.stringify({ action: { tool: 'file.read', args: { path: 'notes.txt' } } }),
    JSON.stringify({ reply: 'I read the notes.' })
  ];
  const loopCalls = [];
  const loopEngine = { async act(input) { loopCalls.push(input); return { ok: true, status: 'executed', result: { content: 'hello' }, taskId: input.taskId, actionId: 'action-read' }; } };
  const loop = createAgentController({
    store: loopStore,
    engine: loopEngine,
    provider: { async chatStructured() { return { ok: true, model: 'fixture', reply: loopReplies.shift() }; } },
    maxTurns: 3,
    maxActions: 3
  });
  const loopResult = await loop.run({ prompt: 'Read notes.', workspace: '/tmp/agent-harness', model: 'fixture' });
  if (loopResult.status !== 'completed' || loopResult.reply !== 'I read the notes.' || loopCalls.length !== 1) throw new Error('agent multi-turn loop');
  if (!loopStore.events.some((event) => event.type === 'agent.action.executed')) throw new Error('agent action audit');
  pass('agent contract rejects malformed tools and completes a safe multi-turn loop');

  const memoryContextStore = fakeAgentStore();
  memoryContextStore.listMemories = async () => [{ key: 'response_style', value: 'Use concise bullet points.', workspace: '/tmp/agent-harness' }];
  let capturedMemoryMessages = [];
  const memoryContext = createAgentController({
    store: memoryContextStore,
    engine: loopEngine,
    provider: { async chatStructured(input) { capturedMemoryMessages = input.messages; return { ok: true, model: 'fixture', reply: JSON.stringify({ reply: 'Memory loaded.' }) }; } }
  });
  const memoryResult = await memoryContext.run({ prompt: 'Use my preferences.', workspace: '/tmp/agent-harness', model: 'fixture' });
  if (memoryResult.status !== 'completed' || !capturedMemoryMessages.some((message) => String(message.content).includes('response_style') && String(message.content).includes('concise bullet points'))) {
    throw new Error('agent memory context');
  }
  pass('agent receives only matching scoped local memory');

  const skillContextStore = fakeAgentStore();
  skillContextStore.getSkill = async (selector) => selector === 'release-check' ? {
    id: 'skill-release-check', name: 'release-check', description: 'Review a release safely.', instructions: 'Inspect the project and report the smallest release checklist.'
  } : null;
  let capturedSkillMessages = [];
  const skillContext = createAgentController({
    store: skillContextStore,
    engine: loopEngine,
    provider: { async chatStructured(input) { capturedSkillMessages = input.messages; return { ok: true, model: 'fixture', reply: JSON.stringify({ reply: 'Skill loaded.' }) }; } }
  });
  const skillResult = await skillContext.run({ prompt: 'Review this project.', workspace: '/tmp/agent-harness', model: 'fixture', skill: 'release-check' });
  if (skillResult.status !== 'completed' || !capturedSkillMessages.some((message) => String(message.content).includes('release-check') && String(message.content).includes('smallest release checklist'))) {
    throw new Error('agent skill context');
  }
  if (!skillContextStore.events.some((event) => event.type === 'agent.started' && event.payload.skill === 'release-check')) throw new Error('skill selection audit');
  pass('agent receives an explicitly selected local skill as bounded, audited guidance');

  const approvalStore = fakeAgentStore();
  const approval = createAgentController({
    store: approvalStore,
    engine: { async act(input) { return { ok: false, status: 'needs_approval', approval: { id: 'approval-agent' }, taskId: input.taskId, actionId: 'action-write' }; } },
    provider: { async chatStructured() { return { ok: true, model: 'fixture', reply: JSON.stringify({ action: { tool: 'file.write', args: { path: 'notes.txt', contents: 'changed' } } }) }; } }
  });
  const approvalResult = await approval.run({ prompt: 'Change notes.', workspace: '/tmp/agent-harness', model: 'fixture' });
  if (approvalResult.status !== 'waiting_approval' || !approvalResult.approvals?.length) throw new Error('agent approval stop');
  pass('agent loop stops at approval without auto-approving');

  const limitStore = fakeAgentStore();
  const limited = createAgentController({
    store: limitStore,
    maxTurns: 1,
    maxActions: 3,
    engine: { async act(input) { return { ok: true, status: 'executed', result: { ok: true }, taskId: input.taskId, actionId: 'action-limit' }; } },
    provider: { async chatStructured() { return { ok: true, model: 'fixture', reply: JSON.stringify({ action: { tool: 'file.read', args: { path: 'notes.txt' } } }) }; } }
  });
  const limitResult = await limited.run({ prompt: 'Keep working.', workspace: '/tmp/agent-harness', model: 'fixture' });
  if (limitResult.status !== 'turn_limit' || limitResult.actions.length !== 1) throw new Error('agent turn limit');
  pass('agent loop enforces a bounded turn limit');

  const dataDir = await mkdtemp(join(tmpdir(), 'openbot-harness-'));
  const freshDataDir = await mkdtemp(join(tmpdir(), 'openbot-fresh-'));
  const fileWs = await mkdtemp(join(tmpdir(), 'openbot-file-'));
  const shellWs = await mkdtemp(join(tmpdir(), 'openbot-shell-'));
  const browserWs = await mkdtemp(join(tmpdir(), 'openbot-browser-'));
  const agentWs = await mkdtemp(join(tmpdir(), 'openbot-agent-'));
  const daemonDataDir = await mkdtemp(join(tmpdir(), 'openbot-daemon-'));
  const clientDataDir = await mkdtemp(join(tmpdir(), 'openbot-client-'));
  const { openStore } = await import(pathToFileURL(join(root, 'lib/store.mjs')).href);
  const { createRoutineScheduler, nextRoutineRun, parseRoutineSchedule } = await import(pathToFileURL(join(root, 'lib/routines.mjs')).href);
  const { fileRead, fileWrite } = await import(pathToFileURL(join(root, 'lib/workers/file.mjs')).href);
  try {
    const freshStore = await openStore({ dataDir: freshDataDir });
    const freshState = await freshStore.getState();
    if (freshState.approvals.length || freshState.routines.length) throw new Error('fresh store contains synthetic approvals or routines');
    pass('fresh store starts without synthetic user work');
    const savedMemory = await freshStore.createMemory({ workspace: '/tmp/agent-harness', key: 'secret_note', value: 'token=sk-memory-secret' });
    if (!savedMemory.memory?.id || savedMemory.memory.value.includes('sk-memory-secret')) throw new Error('memory redaction or creation');
    const listedMemory = await freshStore.listMemories({ workspace: '/tmp/agent-harness' });
    if (listedMemory.length !== 1 || listedMemory[0].key !== 'secret_note') throw new Error('memory listing');
    await freshStore.deleteMemory(savedMemory.memory.id);
    if ((await freshStore.listMemories({ workspace: '/tmp/agent-harness' })).length !== 0) throw new Error('memory deletion');
    pass('local memory is durable, scoped, redacted, and removable');
    const savedSkill = await freshStore.createSkill({ name: 'release-check', description: 'Safe release review', instructions: 'Check tests and report token=sk-skill-secret.' });
    if (!savedSkill.skill?.id || savedSkill.skill.instructions.includes('sk-skill-secret')) throw new Error('skill redaction or creation');
    if (!(await freshStore.getSkill('RELEASE-CHECK'))?.id) throw new Error('skill name lookup');
    if ((await freshStore.listSkills()).length !== 1) throw new Error('skill listing');
    await freshStore.deleteSkill(savedSkill.skill.id);
    if ((await freshStore.listSkills()).length !== 0) throw new Error('skill deletion');
    pass('local skills are durable, redacted, explicitly addressable, and removable');
    const savedBot = await freshStore.createBot({ name: 'Release steward', role: 'Review local releases', instructions: 'Check tests, summarize risks, and never publish without approval.', workspace: '/tmp/agent-harness' });
    if (!savedBot.bot?.id || savedBot.bot.name !== 'Release steward' || savedBot.bot.workspace !== '/tmp/agent-harness') throw new Error('bot creation');
    await freshStore.recordBotMessage(savedBot.bot.id, { role: 'user', content: 'Review the workspace.', taskId: 'task-bot-1' });
    await freshStore.recordBotMessage(savedBot.bot.id, { role: 'assistant', content: 'I will review it.', taskId: 'task-bot-1' });
    const reopenedBot = await (await openStore({ dataDir: freshDataDir })).getBot(savedBot.bot.id);
    if (!reopenedBot || reopenedBot.messages.length !== 2 || reopenedBot.messages[0].role !== 'user') throw new Error('bot persistence or conversation history');
    pass('named bots persist bounded profiles and conversation history');
    if (parseRoutineSchedule('every 15m').intervalMs !== 900000 || parseRoutineSchedule('daily 09:30').hour !== 9) throw new Error('routine schedule parser');
    let invalidRoutineSchedule = false;
    try { parseRoutineSchedule('hourly'); } catch (error) { invalidRoutineSchedule = error.statusCode === 400; }
    if (!invalidRoutineSchedule) throw new Error('invalid routine schedule accepted');
    const routineCreated = await freshStore.createRoutine({ title: 'Workspace review', schedule: 'every 15m', prompt: 'Review the workspace and report risks.', workspace: '/tmp/agent-harness' });
    if (!routineCreated.routine?.id || routineCreated.routine.enabled !== true || !routineCreated.routine.nextRunAt) throw new Error('routine creation');
    for (let run = 0; run < 25; run += 1) await freshStore.recordRoutineRun(routineCreated.routine.id, { runId: `run-${run}`, status: 'completed' });
    const durableRoutine = (await openStore({ dataDir: freshDataDir })).getRoutine
      ? await (await openStore({ dataDir: freshDataDir })).getRoutine(routineCreated.routine.id)
      : null;
    if (!durableRoutine || durableRoutine.runs.length !== 20) throw new Error('routine run history cap or durability');
    await freshStore.updateRoutine(routineCreated.routine.id, { enabled: false });
    if ((await freshStore.getRoutine(routineCreated.routine.id)).enabled) throw new Error('routine pause');
    pass('local routines validate, persist, pause, and cap run history');
    let schedulerCalls = 0;
    const schedulerRoutine = { id: 'scheduler-test', title: 'Scheduler test', schedule: 'every 15m', enabled: true, nextRunAt: new Date(Date.now() - 1000).toISOString() };
    const schedulerStore = {
      async listRoutines() { return [schedulerRoutine]; },
      async getRoutine() { return schedulerRoutine; },
      async recordRoutineRun() {},
      async updateRoutine() {}
    };
    const scheduler = createRoutineScheduler({ store: schedulerStore, tickMs: 60_000, runRoutine: async () => { schedulerCalls += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return { status: 'waiting_approval', taskId: 'task-routine' }; } });
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (schedulerCalls !== 1) throw new Error(`routine scheduler duplicate run: ${schedulerCalls}`);
    pass('routine scheduler deduplicates concurrent runs and preserves approval status');

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
    const cliMemoryAdd = await runNode(['cli/openbot.mjs', 'memory', 'add', '--workspace', fileWs, '--key', 'tone', '--value', 'Concise'], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' });
    if (cliMemoryAdd.code !== 0) throw new Error(`CLI memory add: ${cliMemoryAdd.output}`);
    const cliMemoryList = await runNode(['cli/openbot.mjs', 'memory', 'list', '--workspace', fileWs, '--json'], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' });
    const cliMemoryListJson = parseCliJson(cliMemoryList.output);
    if (cliMemoryList.code !== 0 || !cliMemoryListJson.memories?.some((memory) => memory.key === 'tone')) throw new Error(`CLI memory list: ${cliMemoryList.output}`);
    const cliMemoryId = cliMemoryListJson.memories.find((memory) => memory.key === 'tone').id;
    const cliMemoryDelete = await runNode(['cli/openbot.mjs', 'memory', 'delete', cliMemoryId, '--json'], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' });
    if (cliMemoryDelete.code !== 0) throw new Error(`CLI memory delete: ${cliMemoryDelete.output}`);
    pass('CLI memory add/list/delete manages operator-owned facts');
    const cliSkillAdd = await runNode(['cli/openbot.mjs', 'skill', 'add', '--name', 'summarize', '--description', 'Summarize safely', '--instructions', 'Read relevant files and summarize findings.', '--json'], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' });
    if (cliSkillAdd.code !== 0) throw new Error(`CLI skill add: ${cliSkillAdd.output}`);
    const cliSkillList = await runNode(['cli/openbot.mjs', 'skill', 'list', '--json'], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' });
    const cliSkillListJson = parseCliJson(cliSkillList.output);
    if (cliSkillList.code !== 0 || !cliSkillListJson.skills?.some((skill) => skill.name === 'summarize')) throw new Error(`CLI skill list: ${cliSkillList.output}`);
    const cliSkillId = cliSkillListJson.skills.find((skill) => skill.name === 'summarize').id;
    const cliSkillDelete = await runNode(['cli/openbot.mjs', 'skill', 'delete', cliSkillId, '--json'], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' });
    if (cliSkillDelete.code !== 0) throw new Error(`CLI skill delete: ${cliSkillDelete.output}`);
    pass('CLI skill add/list/delete manages reusable local instructions');
    const cliBotAdd = await runNode(['cli/openbot.mjs', 'bot', 'add', '--name', 'CLI steward', '--role', 'Review local work', '--instructions', 'Review tests and report risks.', '--workspace', fileWs, '--json'], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' });
    const cliBotAddJson = parseCliJson(cliBotAdd.output);
    if (cliBotAdd.code !== 0 || !cliBotAddJson.bot?.id || cliBotAddJson.bot.name !== 'CLI steward') throw new Error(`CLI bot add: ${cliBotAdd.output}`);
    const cliBotList = await runNode(['cli/openbot.mjs', 'bot', 'list', '--json'], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' });
    const cliBotListJson = parseCliJson(cliBotList.output);
    if (cliBotList.code !== 0 || !cliBotListJson.bots?.some((bot) => bot.id === cliBotAddJson.bot.id && bot.messageCount === 0)) throw new Error(`CLI bot list: ${cliBotList.output}`);
    pass('CLI bot add/list manages named local profiles');
    const legacyDoctor = await runNode(['cli/openbot.mjs', 'doctor', '--json'], {
      OPENBOT_DATA_DIR: dataDir,
      OPENBOT_RESOURCE_PROFILE: 'legacy',
      HOST: '127.0.0.1'
    });
    const legacyDoctorJson = parseCliJson(legacyDoctor.output);
    const resourceCheck = legacyDoctorJson.checks?.find((check) => check.name === 'resources');
    if (!resourceCheck || resourceCheck.profile !== 'legacy' || resourceCheck.agentMaxTurns !== 3 || resourceCheck.agentMaxActions !== 3 || !resourceCheck.guidance) {
      throw new Error(`legacy doctor: ${legacyDoctor.output}`);
    }
    pass('doctor explains legacy resource limits without requiring a model');

    const daemonEnv = { OPENBOT_DATA_DIR: daemonDataDir, HOST: '127.0.0.1', PORT: '4214' };
    const daemonStart = await runNode(['cli/openbot.mjs', 'start', '--detach', '--json'], daemonEnv, { timeoutMs: 15000 });
    const daemonStartJson = parseCliJson(daemonStart.output);
    if (daemonStart.code !== 0 || daemonStartJson.status !== 'running' || !daemonStartJson.pid) {
      throw new Error(`detached daemon start: ${daemonStart.output}`);
    }
    const daemonStatus = await runNode(['cli/openbot.mjs', 'status', '--json'], daemonEnv, { timeoutMs: 10000 });
    const daemonStatusJson = parseCliJson(daemonStatus.output);
    if (daemonStatus.code !== 0 || daemonStatusJson.status !== 'running' || daemonStatusJson.pid !== daemonStartJson.pid) {
      throw new Error(`daemon status: ${daemonStatus.output}`);
    }
    const duplicateStart = await runNode(['cli/openbot.mjs', 'start', '--detach', '--json'], daemonEnv, { timeoutMs: 10000 });
    const duplicateStartJson = parseCliJson(duplicateStart.output);
    if (duplicateStart.code !== 0 || !duplicateStartJson.alreadyRunning || duplicateStartJson.pid !== daemonStartJson.pid) {
      throw new Error(`duplicate daemon start: ${duplicateStart.output}`);
    }
    const daemonStop = await runNode(['cli/openbot.mjs', 'stop', '--json'], daemonEnv, { timeoutMs: 15000 });
    const daemonStopJson = parseCliJson(daemonStop.output);
    if (daemonStop.code !== 0 || daemonStopJson.status !== 'stopped' || daemonStopJson.pid !== daemonStartJson.pid) {
      throw new Error(`daemon stop: ${daemonStop.output}`);
    }
    const stoppedStatus = await runNode(['cli/openbot.mjs', 'status', '--json'], daemonEnv, { timeoutMs: 10000 });
    const stoppedStatusJson = parseCliJson(stoppedStatus.output);
    if (stoppedStatus.code === 0 || stoppedStatusJson.status !== 'stopped') {
      throw new Error(`stopped daemon status: ${stoppedStatus.output}`);
    }
    pass('detached daemon start/status/duplicate-start/stop lifecycle is portable');

    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        OPENBOT_DATA_DIR: dataDir,
        OPENBOT_TEST_AGENT_RESPONSES: JSON.stringify([
          JSON.stringify({ reply: 'The named bot completed the review.' }),
          JSON.stringify({ action: { tool: 'file.read', args: { path: 'notes.txt' } } }),
          JSON.stringify({ reply: 'The notes are ready.' }),
          JSON.stringify({ action: { tool: 'file.write', args: { path: 'notes.txt', contents: 'changed by agent\n' } } }),
          JSON.stringify({ action: { tool: 'file.write', args: { path: 'notes.txt', contents: 'changed by agent\n' } } }),
          JSON.stringify({ reply: 'The approved change is complete.' }),
          'not-json',
          JSON.stringify({ reply: 'The skill is loaded.' }),
          JSON.stringify({ reply: 'The routine completed.' }),
          JSON.stringify({ reply: 'The interrupted task is complete.' }),
          JSON.stringify({ reply: 'The daemon client completed the task.' })
        ])
      },
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
      if (state.status !== 200 || !parsed.approvals || !Array.isArray(parsed.bots)) throw new Error('invalid state');
      pass('state endpoint responds with approvals');
      const botCreate = await http('/api/bots', { method: 'POST', body: JSON.stringify({ name: 'Release steward', role: 'Review local releases', instructions: 'Check tests, summarize risks, and never publish without approval.', workspace: agentWs }) });
      const botCreateBody = JSON.parse(botCreate.body);
      if (botCreate.status !== 200 || !botCreateBody.bot?.id || botCreateBody.bot.name !== 'Release steward') throw new Error(`bot create ${botCreate.status} ${botCreate.body}`);
      const botList = await http('/api/bots');
      if (botList.status !== 200 || !JSON.parse(botList.body).bots.some((item) => item.id === botCreateBody.bot.id)) throw new Error(`bot list ${botList.status} ${botList.body}`);
      pass('bot API creates and lists durable named profiles');
      const botChat = await http(`/api/bots/${encodeURIComponent(botCreateBody.bot.id)}/chat`, { method: 'POST', body: JSON.stringify({ message: 'Review the workspace.', model: 'fixture' }) });
      const botChatBody = JSON.parse(botChat.body);
      const botAfterChat = JSON.parse((await http(`/api/bots/${encodeURIComponent(botCreateBody.bot.id)}`)).body).bot;
      if (botChat.status !== 200 || botChatBody.status !== 'completed' || botChatBody.botId !== botCreateBody.bot.id || botAfterChat.messages?.length !== 2 || botAfterChat.messages?.[1]?.role !== 'assistant') throw new Error(`bot chat ${botChat.status} ${botChat.body}`);
      pass('bot chat uses the named profile and persists a bounded conversation');
      const routineCreate = await http('/api/routines', { method: 'POST', body: JSON.stringify({ title: 'Nightly review', schedule: 'daily 23:00', prompt: 'Review the workspace and report risks.', workspace: agentWs, botId: botCreateBody.bot.id }) });
      const routineCreateBody = JSON.parse(routineCreate.body);
      if (routineCreate.status !== 200 || !routineCreateBody.routine?.id || routineCreateBody.routine.botId !== botCreateBody.bot.id || !routineCreateBody.routine.nextRunAt) throw new Error(`routine create ${routineCreate.status} ${routineCreate.body}`);
      const routineList = await http('/api/routines');
      if (routineList.status !== 200 || !JSON.parse(routineList.body).routines.some((item) => item.id === routineCreateBody.routine.id)) throw new Error(`routine list ${routineList.status} ${routineList.body}`);
      pass('routine API creates and lists durable local schedules');
      const taskList = await http('/api/tasks');
      const taskListBody = JSON.parse(taskList.body);
      if (taskList.status !== 200 || !Array.isArray(taskListBody.tasks)) throw new Error(`task list ${taskList.status} ${taskList.body}`);
      pass('task history endpoint returns durable tasks');
      const memoryCreate = await http('/api/memories', { method: 'POST', body: JSON.stringify({ workspace: agentWs, key: 'response_style', value: 'Use concise bullet points.' }) });
      const memoryCreateBody = JSON.parse(memoryCreate.body);
      if (memoryCreate.status !== 200 || !memoryCreateBody.memory?.id) throw new Error(`memory create ${memoryCreate.status} ${memoryCreate.body}`);
      const memoryList = await http(`/api/memories?workspace=${encodeURIComponent(agentWs)}`);
      const memoryListBody = JSON.parse(memoryList.body);
      if (memoryList.status !== 200 || memoryListBody.memories?.[0]?.key !== 'response_style') throw new Error(`memory list ${memoryList.status} ${memoryList.body}`);
      const memoryDelete = await http(`/api/memories/${encodeURIComponent(memoryCreateBody.memory.id)}`, { method: 'DELETE' });
      if (memoryDelete.status !== 200) throw new Error(`memory delete ${memoryDelete.status} ${memoryDelete.body}`);
      pass('memory API creates, lists, scopes, and deletes local facts');
      const skillCreate = await http('/api/skills', { method: 'POST', body: JSON.stringify({ name: 'release-check', description: 'Release review', instructions: 'Read tests, then report release risks.' }) });
      const skillCreateBody = JSON.parse(skillCreate.body);
      if (skillCreate.status !== 200 || !skillCreateBody.skill?.id) throw new Error(`skill create ${skillCreate.status} ${skillCreate.body}`);
      const skillList = await http('/api/skills');
      const skillListBody = JSON.parse(skillList.body);
      if (skillList.status !== 200 || skillListBody.skills?.[0]?.name !== 'release-check') throw new Error(`skill list ${skillList.status} ${skillList.body}`);
      const skillDelete = await http(`/api/skills/${encodeURIComponent(skillCreateBody.skill.id)}`, { method: 'DELETE' });
      if (skillDelete.status !== 200) throw new Error(`skill delete ${skillDelete.status} ${skillDelete.body}`);
      pass('skill API creates, lists, selects by durable id, and deletes local guidance');
      const tasksBeforeBadSkill = taskListBody.tasks.length;
      const badSkill = await http('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'This must not start.', workspace: agentWs, model: 'fixture', skill: 'missing-skill' }) });
      const tasksAfterBadSkill = JSON.parse((await http('/api/tasks')).body).tasks || [];
      if (badSkill.status !== 404 || tasksAfterBadSkill.length !== tasksBeforeBadSkill) throw new Error(`unknown skill ${badSkill.status} ${badSkill.body}`);
      pass('unknown local skills are rejected before a task is created');
      await writeFile(join(agentWs, 'notes.txt'), 'agent fixture\n');
      const agentRead = await http('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'Read the notes.', workspace: agentWs, model: 'fixture' }) });
      const agentReadBody = JSON.parse(agentRead.body);
      if (agentRead.status !== 200 || agentReadBody.status !== 'completed' || agentReadBody.actions?.[0]?.status !== 'executed') throw new Error(`agent read ${agentRead.status} ${agentRead.body}`);
      if (!agentReadBody.reply || !agentReadBody.taskId) throw new Error('agent read result');
      pass('agent chat executes safe structured work and returns a final reply');
      const agentWrite = await http('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'Change the notes.', workspace: agentWs, model: 'fixture' }) });
      const agentWriteBody = JSON.parse(agentWrite.body);
      if (agentWrite.status !== 200 || agentWriteBody.status !== 'waiting_approval' || !agentWriteBody.approvals?.length) throw new Error(`agent write approval ${agentWrite.status} ${agentWrite.body}`);
      if ((await readFile(join(agentWs, 'notes.txt'), 'utf8')) !== 'agent fixture\n') throw new Error('agent wrote before approval');
      pass('agent chat stops consequential work for explicit approval');
      const approvalId = agentWriteBody.approvals[0].id;
      const approved = await http('/api/approval', { method: 'POST', body: JSON.stringify({ id: approvalId, decision: 'approved' }) });
      if (approved.status !== 200) throw new Error(`approval decision ${approved.status} ${approved.body}`);
      const resumed = await http(`/api/tasks/${encodeURIComponent(agentWriteBody.taskId)}/resume`, { method: 'POST', body: JSON.stringify({ approvalId, model: 'fixture' }) });
      const resumedBody = JSON.parse(resumed.body);
      if (resumed.status !== 200 || resumedBody.status !== 'completed' || (await readFile(join(agentWs, 'notes.txt'), 'utf8')) !== 'changed by agent\n') {
        throw new Error(`agent resume ${resumed.status} ${resumed.body}`);
      }
      pass('approved agent work resumes the same task and continues to completion');
      const agentMalformed = await http('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'Keep going.', workspace: agentWs, model: 'fixture' }) });
      const agentMalformedBody = JSON.parse(agentMalformed.body);
      if (agentMalformed.status !== 502 || agentMalformedBody.status !== 'failed' || !String(agentMalformedBody.error).includes('contract')) throw new Error(`agent malformed ${agentMalformed.status} ${agentMalformed.body}`);
      pass('agent chat reports malformed model output as a bounded contract failure');
      const skillForChat = await http('/api/skills', { method: 'POST', body: JSON.stringify({ name: 'chat-skill', instructions: 'Use a concise release checklist.' }) });
      const skillForChatBody = JSON.parse(skillForChat.body);
      const agentWithSkill = await http('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'Use the skill.', workspace: agentWs, model: 'fixture', skill: skillForChatBody.skill.id }) });
      const agentWithSkillBody = JSON.parse(agentWithSkill.body);
      if (agentWithSkill.status !== 200 || agentWithSkillBody.status !== 'completed') throw new Error(`agent skill ${agentWithSkill.status} ${agentWithSkill.body}`);
      pass('agent chat accepts an explicit local skill without changing approval boundaries');
      const routineRun = await http(`/api/routines/${encodeURIComponent(routineCreateBody.routine.id)}/run`, { method: 'POST' });
      const routineRunBody = JSON.parse(routineRun.body);
      if (routineRun.status !== 200 || routineRunBody.result?.status !== 'completed' || !routineRunBody.result?.taskId) throw new Error(`routine run ${routineRun.status} ${routineRun.body}`);
      const routinePaused = await http(`/api/routines/${encodeURIComponent(routineCreateBody.routine.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
      if (routinePaused.status !== 200 || routinePaused.body.includes('"enabled":true')) throw new Error(`routine pause ${routinePaused.status} ${routinePaused.body}`);
      pass('routine Run now uses the normal agent loop and pause is durable');
      const staleTask = await first.createTask({ prompt: 'Recover after restart.', workspace: agentWs });
      await first.append({ type: 'task.status', taskId: staleTask.task.id, payload: { status: 'running' } });
      const recovered = await http(`/api/tasks/${encodeURIComponent(staleTask.task.id)}/resume`, { method: 'POST', body: JSON.stringify({ model: 'fixture' }) });
      const recoveredBody = JSON.parse(recovered.body);
      if (recovered.status !== 200 || recoveredBody.status !== 'completed' || recoveredBody.taskId !== staleTask.task.id) throw new Error(`restart recovery ${recovered.status} ${recovered.body}`);
      pass('interrupted running tasks resume after daemon restart without changing task identity');
      const daemonCli = await runNode([
        'cli/openbot.mjs', 'chat', '--daemon', '--workspace', agentWs, '--json', 'Use the shared daemon client.'
      ], { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), OPENBOT_DAEMON_URL: base }, { timeoutMs: 20000 });
      const daemonCliJson = parseCliJson(daemonCli.output);
      if (daemonCli.code !== 0 || daemonCliJson.status !== 'completed' || daemonCliJson.reply !== 'The daemon client completed the task.') {
        throw new Error(`daemon CLI chat: ${daemonCli.output}`);
      }
      const daemonTasks = JSON.parse((await http('/api/tasks')).body).tasks || [];
      if (!daemonTasks.some((task) => task.prompt === 'Use the shared daemon client.' && task.status === 'completed')) throw new Error('daemon client task was not persisted by the server');
      pass('CLI chat can use the shared daemon and persists server-owned task state');
      const isolatedDaemonEnv = { OPENBOT_DATA_DIR: clientDataDir, HOST: '127.0.0.1', PORT: String(port), OPENBOT_DAEMON_URL: base };
      const daemonListCli = await runNode(['cli/openbot.mjs', 'list', '--daemon', '--json'], isolatedDaemonEnv);
      const daemonListJson = JSON.parse(daemonListCli.output.trim());
      if (daemonListCli.code !== 0 || !Array.isArray(daemonListJson) || !daemonListJson.some((task) => task.id === daemonCliJson.taskId)) throw new Error(`daemon CLI list: ${daemonListCli.output}`);
      const daemonShowCli = await runNode(['cli/openbot.mjs', 'show', daemonCliJson.taskId, '--daemon', '--json'], isolatedDaemonEnv);
      const daemonShowJson = parseCliJson(daemonShowCli.output);
      if (daemonShowCli.code !== 0 || daemonShowJson.task?.id !== daemonCliJson.taskId || !Array.isArray(daemonShowJson.events)) throw new Error(`daemon CLI show: ${daemonShowCli.output}`);
      const daemonLogsCli = await runNode(['cli/openbot.mjs', 'logs', daemonCliJson.taskId, '--daemon', '--json'], isolatedDaemonEnv);
      const daemonLogsJson = JSON.parse(daemonLogsCli.output.trim());
      if (daemonLogsCli.code !== 0 || !Array.isArray(daemonLogsJson) || !daemonLogsJson.length) throw new Error(`daemon CLI logs: ${daemonLogsCli.output}`);
      const remoteApproval = await http('/api/tasks', { method: 'POST', body: JSON.stringify({ prompt: 'Remote approval parity', kind: 'send' }) });
      const remoteApprovalBody = JSON.parse(remoteApproval.body);
      if (remoteApproval.status !== 200 || !remoteApprovalBody.approval?.id) throw new Error(`remote approval setup ${remoteApproval.status} ${remoteApproval.body}`);
      const daemonApproveCli = await runNode(['cli/openbot.mjs', 'approve', remoteApprovalBody.approval.id, '--daemon', '--json'], isolatedDaemonEnv);
      const daemonApproveJson = parseCliJson(daemonApproveCli.output);
      if (daemonApproveCli.code !== 0 || daemonApproveJson.approval?.status !== 'approved') throw new Error(`daemon CLI approve: ${daemonApproveCli.output}`);
      const remoteRejection = await http('/api/tasks', { method: 'POST', body: JSON.stringify({ prompt: 'Remote rejection parity', kind: 'delete' }) });
      const remoteRejectionBody = JSON.parse(remoteRejection.body);
      if (remoteRejection.status !== 200 || !remoteRejectionBody.approval?.id) throw new Error(`remote rejection setup ${remoteRejection.status} ${remoteRejection.body}`);
      const daemonRejectCli = await runNode(['cli/openbot.mjs', 'reject', remoteRejectionBody.approval.id, '--daemon', '--json'], isolatedDaemonEnv);
      const daemonRejectJson = parseCliJson(daemonRejectCli.output);
      if (daemonRejectCli.code !== 0 || daemonRejectJson.approval?.status !== 'rejected') throw new Error(`daemon CLI reject: ${daemonRejectCli.output}`);
      pass('CLI task inspection, logs, and approval decisions can use the shared daemon');
      const daemonTaskId = daemonCliJson.taskId;
      const taskEvents = await http(`/api/tasks/${encodeURIComponent(daemonTaskId)}/events`);
      const taskEventsBody = JSON.parse(taskEvents.body);
      if (taskEvents.status !== 200 || taskEventsBody.task?.id !== daemonTaskId || !Array.isArray(taskEventsBody.events) || !taskEventsBody.events.length || !Number.isInteger(taskEventsBody.nextSeq)) {
        throw new Error(`task events ${taskEvents.status} ${taskEvents.body}`);
      }
      const latestSeq = taskEventsBody.nextSeq;
      const emptyAfter = await http(`/api/tasks/${encodeURIComponent(daemonTaskId)}/events?after=${latestSeq}`);
      const emptyAfterBody = JSON.parse(emptyAfter.body);
      if (emptyAfter.status !== 200 || emptyAfterBody.events?.length !== 0 || emptyAfterBody.nextSeq !== latestSeq) throw new Error(`task event cursor ${emptyAfter.status} ${emptyAfter.body}`);
      const invalidAfter = await http(`/api/tasks/${encodeURIComponent(daemonTaskId)}/events?after=not-a-number`);
      if (invalidAfter.status !== 400) throw new Error(`invalid task event offset ${invalidAfter.status} ${invalidAfter.body}`);
      pass('task activity can be read incrementally with a durable event cursor');
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
    const unauthenticatedLan = await runNode(['server.mjs'], {
      HOST: '0.0.0.0', PORT: '4212', OPENBOT_DATA_DIR: dataDir, OPENBOT_ALLOW_NON_LOOPBACK: '1'
    }, { timeoutMs: 4000 });
    if (unauthenticatedLan.code === 0 || !unauthenticatedLan.output.includes('OPENBOT_AUTH_TOKEN')) throw new Error(`server allowed unauthenticated LAN mode: ${unauthenticatedLan.output}`);
    pass('server refuses non-loopback mode without an authentication token');
    const protectedChild = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: { ...process.env, HOST: '0.0.0.0', PORT: '4213', OPENBOT_DATA_DIR: dataDir, OPENBOT_ALLOW_NON_LOOPBACK: '1', OPENBOT_AUTH_TOKEN: 'harness-token' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let protectedOutput = '';
    protectedChild.stdout.on('data', (chunk) => { protectedOutput += chunk; });
    protectedChild.stderr.on('data', (chunk) => { protectedOutput += chunk; });
    try {
      let protectedReady = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try { const response = await httpOn(4213, '/api/health'); if ([200, 401].includes(response.status)) { protectedReady = true; break; } } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!protectedReady) throw new Error(`protected server did not start: ${protectedOutput}`);
      const unauthorized = await httpOn(4213, '/api/health');
      const authorized = await httpOn(4213, '/api/health', { headers: { authorization: 'Bearer harness-token' } });
      if (unauthorized.status !== 401 || authorized.status !== 200) throw new Error(`LAN auth statuses ${unauthorized.status}/${authorized.status}`);
    } finally {
      protectedChild.kill('SIGTERM');
      await new Promise((resolve) => protectedChild.once('exit', resolve));
    }
    pass('non-loopback requests require and accept the configured bearer token');

    const { createEngine } = await import(pathToFileURL(join(root, 'lib/engine.mjs')).href);
    const engine = createEngine({ store: first, actor: 'harness' });
    const scopedTask = await first.createTask({ prompt: 'workspace binding', kind: 'plan', workspace: fileWs });
    let workspaceMismatchRejected = false;
    try { await engine.act({ taskId: scopedTask.task.id, workspace: shellWs, tool: 'file.read', args: { path: 'notes.txt' } }); } catch (error) { workspaceMismatchRejected = error.statusCode === 409; }
    if (!workspaceMismatchRejected) throw new Error('task workspace mismatch was accepted');
    pass('existing task actions are bound to their canonical workspace');

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
    const otherTask = await first.createTask({ prompt: 'wrong approval task', kind: 'plan', workspace: fileWs });
    const wrongTaskApproval = await engine.act({ workspace: fileWs, tool: 'file.write', args: { path: 'notes.txt', contents: 'hello openbot\n' }, approvalId: proposed.approval.id, taskId: otherTask.task.id });
    if (wrongTaskApproval.status !== 'denied') throw new Error(`approval crossed task boundary: ${wrongTaskApproval.status}`);
    pass('approval consumption is bound to the originating task');
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

    const linkTarget = join(shellWs, 'outside-target.txt');
    const linkPath = join(fileWs, 'link.txt');
    await writeFile(linkTarget, 'outside target\n', 'utf8');
    await symlink(linkTarget, linkPath);
    let symlinkRejected = false;
    try { await fileRead(fileWs, 'link.txt'); } catch (error) { symlinkRejected = error.code === 'ELOOP' || error.statusCode === 403; }
    if (!symlinkRejected) throw new Error('file.read followed a symlink');
    let symlinkWriteRejected = false;
    try { await fileWrite(fileWs, 'link.txt', 'must not write\n'); } catch (error) { symlinkWriteRejected = error.code === 'ELOOP' || error.statusCode === 403; }
    if (!symlinkWriteRejected) throw new Error('file.write followed a symlink');
    pass('FILE hardening: workspace escapes through symlink targets are rejected');

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

    const previousIsolation = process.env.OPENBOT_ISOLATION;
    const previousImage = process.env.OPENBOT_DOCKER_IMAGE;
    const previousPath = process.env.PATH;
    process.env.OPENBOT_ISOLATION = 'cwd';
    process.env.OPENBOT_DOCKER_IMAGE = 'openbot-image-must-not-run-in-legacy-mode';
    process.env.PATH = '/path-that-cannot-provide-a-command';
    const portableSafe = await engine.act({ workspace: shellWs, tool: 'shell.exec', args: { command: 'uname' } });
    if (!portableSafe.ok || !String(portableSafe.result?.stdout || '').trim()) throw new Error(`legacy shell fallback failed: ${JSON.stringify(portableSafe.result)}`);
    const portableUnknown = await engine.act({ workspace: shellWs, tool: 'shell.exec', args: { command: 'env' } });
    if (portableUnknown.status !== 'needs_approval' || portableUnknown.result?.needsApproval !== true) throw new Error(`legacy shell did not gate unknown command: ${portableUnknown.status}`);
    if (previousIsolation === undefined) delete process.env.OPENBOT_ISOLATION; else process.env.OPENBOT_ISOLATION = previousIsolation;
    if (previousImage === undefined) delete process.env.OPENBOT_DOCKER_IMAGE; else process.env.OPENBOT_DOCKER_IMAGE = previousImage;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    pass('legacy shell mode runs only allowlisted diagnostics without Docker');

    const cliEnv = { OPENBOT_DATA_DIR: dataDir, HOST: '127.0.0.1' };
    const cliAgent = await runNode([
      'cli/openbot.mjs', 'chat', '--workspace', fileWs, '--json', 'read the notes file'
    ], {
      ...cliEnv,
      OPENBOT_TEST_AGENT_RESPONSES: JSON.stringify([
        JSON.stringify({ action: { tool: 'file.read', args: { path: 'notes.txt' }, reason: 'Read the requested file.' } }),
        JSON.stringify({ reply: 'The notes are available.' })
      ])
    }, { timeoutMs: 20000 });
    const cliAgentJson = parseCliJson(cliAgent.output);
    if (cliAgent.code !== 0 || cliAgentJson.status !== 'completed' || cliAgentJson.reply !== 'The notes are available.') {
      throw new Error(`CLI agent: ${cliAgent.output}`);
    }
    pass('CLI chat runs the bounded local agent loop');

    const cliStaleTask = await first.createTask({ prompt: 'Resume this CLI task.', workspace: fileWs });
    await first.append({ type: 'task.status', taskId: cliStaleTask.task.id, payload: { status: 'running' } });
    const cliResume = await runNode(['cli/openbot.mjs', 'resume', cliStaleTask.task.id, '--json'], {
      ...cliEnv,
      OPENBOT_TEST_AGENT_RESPONSES: JSON.stringify([JSON.stringify({ reply: 'The CLI task is complete.' })])
    }, { timeoutMs: 20000 });
    const cliResumeJson = parseCliJson(cliResume.output);
    if (cliResume.code !== 0 || cliResumeJson.taskId !== cliStaleTask.task.id || cliResumeJson.status !== 'completed') {
      throw new Error(`CLI resume: ${cliResume.output}`);
    }
    pass('CLI resumes an interrupted running task with the same task identity');

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
      if (fetched.status !== 'needs_approval' || !fetched.approval?.id) throw new Error(`browser fetch approval ${fetched.status}`);
      if (existsSync(join(browserWs, 'research.md'))) throw new Error('browser fetch wrote before approval');
      await first.decideApproval(fetched.approval.id, 'approved');
      const fetchedApproved = await engine.act({
        workspace: browserWs,
        tool: 'browser.fetch',
        args: { url: fixtureUrl, path: 'research.md' },
        taskId: fetched.taskId,
        approvalId: fetched.approval.id
      });
      if (!fetchedApproved.ok) throw new Error(`browser fetch failed: ${fetchedApproved.result?.reason || fetchedApproved.result?.error || ''}`);
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
      if (cliBrowserJson.status !== 'needs_approval' || !cliBrowserJson.approval?.id) throw new Error(`CLI browser approval: ${cliBrowser.output}`);
      const cliBrowserApprove = await runNode(['cli/openbot.mjs', 'approve', cliBrowserJson.approval.id], cliEnv);
      if (cliBrowserApprove.code !== 0) throw new Error(`CLI browser approve: ${cliBrowserApprove.output}`);
      const cliBrowserWrite = await runNode([
        'cli/openbot.mjs', 'act', '--workspace', browserWs, '--tool', 'browser.fetch',
        '--url', fixtureUrl, '--path', 'cli-research.md', '--approval', cliBrowserJson.approval.id, '--task', cliBrowserJson.taskId
      ], cliEnv, { timeoutMs: 20000 });
      const cliBrowserWritten = parseCliJson(cliBrowserWrite.output);
      if (!cliBrowserWritten.ok) throw new Error(`CLI browser execute: ${cliBrowserWrite.output}`);
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
    const auditSecret = 'sk-live-test-secret';
    const proposedSecret = await engine.act({ workspace: fileWs, tool: 'file.write', args: { path: 'secret.txt', contents: `token=${auditSecret}\n` } });
    if (proposedSecret.status !== 'needs_approval') throw new Error('secret audit probe did not require approval');
    const afterSecretProbe = await first.listEvents();
    if (JSON.stringify(afterSecretProbe).includes(auditSecret)) throw new Error('secret leaked into persisted audit event');
    pass('audit events redact sensitive action results and diffs');
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
    await rm(freshDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(fileWs, { recursive: true, force: true }).catch(() => {});
    await rm(shellWs, { recursive: true, force: true }).catch(() => {});
    await rm(browserWs, { recursive: true, force: true }).catch(() => {});
    await rm(daemonDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(clientDataDir, { recursive: true, force: true }).catch(() => {});
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length) process.exitCode = 1;
  console.log(`Release harness: ${checks.length - failed.length}/${checks.length} passed.`);
}

main().catch((error) => { console.error(`Release harness failed: ${error.message}`); process.exitCode = 1; });
