#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig, publicConfig, ROOT } from '../lib/config.mjs';
import { assertBindHost, isLoopbackHost } from '../lib/loopback.mjs';
import { createProviderHub } from '../lib/provider.mjs';
import { createExecutor } from '../lib/executor.mjs';
import { createWorkerHub } from '../lib/workers.mjs';
import { openStore, redactSecrets } from '../lib/store.mjs';

const USAGE = `OpenBot CLI (control-plane preview)

Usage: openbot <command> [options]

Commands:
  start              Start the local OpenBot daemon
  run <prompt>       Create and run a task when its policy permits
  list               List tasks
  show <id>          Show one task
  approve <id>       Approve a waiting approval
  reject <id>        Reject a waiting approval
  pause <task-id>    Pause a task
  cancel <task-id>   Cancel a task
  resume <task-id>   Resume a paused task
  logs [task-id]     Show event log
  export <task-id>   Export a redacted audit bundle
  doctor             Check loopback, Ollama, and store
  config             Show local configuration

Options:
  --json             Print machine-readable JSON
  --kind <kind>      Task action kind for policy (plan, send, delete, ...)
  --action-json <json>  Structured local action (file/shell/browser worker)
  -h, --help         Show this help
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') flags.json = true;
    else if (arg === '--kind') flags.kind = argv[index += 1];
    else if (arg.startsWith('--kind=')) flags.kind = arg.slice(7);
    else if (arg === '--action-json') flags.actionJson = argv[index += 1];
    else if (arg.startsWith('--action-json=')) flags.actionJson = arg.slice(14);
    else if (arg === '--title') flags.title = argv[index += 1];
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('-')) {
      const error = new Error(`Unknown option: ${arg}`);
      error.exitCode = 1;
      throw error;
    } else positional.push(arg);
  }
  return { flags, positional };
}

function print(value, asJson) {
  if (asJson || typeof value !== 'string') console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function fail(error) {
  const message = error && error.message ? error.message : String(error);
  console.error(message);
  process.exit(error && error.exitCode ? error.exitCode : 1);
}

function parseAction(value) {
  if (!value) return null;
  try {
    const action = JSON.parse(value);
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('action must be a JSON object');
    return action;
  } catch (error) {
    throw Object.assign(new Error(`--action-json must contain a valid JSON object: ${error.message}`), { exitCode: 1 });
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (flags.help || command === 'help') {
    console.log(USAGE);
    return;
  }
  if (!command) {
    console.error(USAGE);
    process.exit(1);
  }

  const config = loadConfig();
  const asJson = Boolean(flags.json);

  if (command === 'config') {
    print(publicConfig(config), true);
    return;
  }

  if (command === 'start') {
    try {
      const bind = assertBindHost(config.host, process.env);
      if (bind.overridden) {
        console.warn(`WARNING: HOST=${config.host} is not loopback. OpenBot preview has no authentication. OPENBOT_ALLOW_NON_LOOPBACK=1 is set.`);
      }
    } catch (error) {
      fail(error);
    }
    const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
      stdio: 'inherit',
      env: process.env,
      cwd: ROOT
    });
    const code = await new Promise((resolve) => child.once('exit', (exitCode) => resolve(exitCode)));
    process.exit(code ?? 1);
  }

  if (command === 'doctor') {
    const checks = [];
    try {
      const bind = assertBindHost(config.host, process.env);
      checks.push({ name: 'loopback', ok: true, host: bind.host, overridden: bind.overridden });
      if (bind.overridden) {
        console.warn(`WARNING: HOST=${config.host} is not loopback. OPENBOT_ALLOW_NON_LOOPBACK=1 is set.`);
      }
    } catch (error) {
      checks.push({ name: 'loopback', ok: false, error: error.message, loopback: isLoopbackHost(config.host) });
    }
    try {
      const hub = createProviderHub(process.env, { ollamaUrl: config.ollamaUrl });
      const tags = await hub.ollama.tags();
      checks.push({ name: 'ollama', ok: Boolean(tags.ok), models: tags.models || [], url: config.ollamaUrl });
    } catch (error) {
      checks.push({ name: 'ollama', ok: false, error: error.message, url: config.ollamaUrl });
    }
    try {
      const store = await openStore({ dataDir: config.dataDir });
      const info = await store.doctor();
      checks.push({ name: 'store', ok: true, ...info });
    } catch (error) {
      checks.push({ name: 'store', ok: false, error: error.message, dataDir: config.dataDir });
    }
    const failed = checks.filter((check) => !check.ok);
    if (asJson) print({ ok: failed.length === 0, checks }, true);
    else {
      for (const check of checks) {
        console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.error ? `: ${check.error}` : ''}`);
      }
    }
    if (failed.length) process.exit(1);
    return;
  }

  const store = await openStore({ dataDir: config.dataDir });
  const workers = createWorkerHub({
    dataDir: config.dataDir,
    localOnly: config.localOnly,
    browserAllowlist: config.browserAllowlist,
    sandboxMode: config.sandboxMode,
    limits: { shellTimeoutMs: config.limits.shellTimeoutMs }
  });
  const executor = createExecutor({ store, workers });

  if (command === 'run') {
    const prompt = positional.slice(1).join(' ').trim();
    if (!prompt) fail(Object.assign(new Error('run requires a prompt.'), { exitCode: 1 }));
    const created = await store.createTask({ prompt, kind: flags.kind || 'plan', title: flags.title, action: parseAction(flags.actionJson) });
    let task = created.task;
    if (task.status === 'pending') task = await executor.start(task.id);
    print(redactSecrets({ ...created, task }), true);
    return;
  }

  if (command === 'list') {
    const tasks = await store.listTasks();
    const safeTasks = redactSecrets(tasks);
    if (asJson || !tasks.length) print(tasks.length ? safeTasks : (asJson ? [] : 'No tasks.'), asJson || Boolean(tasks.length));
    else for (const task of tasks) console.log(`${task.id}\t${task.status}\t${task.kind}\t${task.prompt}`);
    return;
  }

  if (command === 'show') {
    const id = positional[1];
    if (!id) fail(Object.assign(new Error('Task id is required.'), { exitCode: 1 }));
    const task = await store.getTask(id);
    if (!task) fail(Object.assign(new Error('Task not found'), { exitCode: 1 }));
    const events = await store.listEvents({ taskId: id });
    print(redactSecrets({ task, events }), true);
    return;
  }

  if (command === 'approve' || command === 'reject') {
    const id = positional[1];
    if (!id) fail(Object.assign(new Error('Approval id is required.'), { exitCode: 1 }));
    const approval = await store.decideApproval(id, command === 'approve' ? 'approved' : 'rejected');
    let task = approval.taskId ? await store.getTask(approval.taskId) : null;
    if (command === 'approve' && task && approval.actionDigest) {
      await store.consumeApproval(approval.id, approval.actionDigest);
      task = await executor.start(task.id);
    }
    print(redactSecrets({ approval, task }), true);
    return;
  }

  if (command === 'pause' || command === 'cancel' || command === 'resume') {
    const id = positional[1];
    if (!id) fail(Object.assign(new Error('Task id is required.'), { exitCode: 1 }));
    const task = command === 'resume' ? await store.resumeTask(id) : await store.setTaskStatus(id, command);
    const next = task.status === 'pending' ? await executor.start(task.id) : task;
    print(redactSecrets({ task: next }), true);
    return;
  }

  if (command === 'logs') {
    const events = await store.listEvents({ taskId: positional[1] });
    print(redactSecrets(events), true);
    return;
  }

  if (command === 'export') {
    const id = positional[1];
    if (!id) fail(Object.assign(new Error('Task id is required.'), { exitCode: 1 }));
    print(redactSecrets(await store.exportTask(id)), true);
    return;
  }

  fail(Object.assign(new Error(`Unknown command: ${command}`), { exitCode: 1 }));
}

main().catch(fail);
