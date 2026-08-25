#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig, publicConfig, ROOT } from '../lib/config.mjs';
import { assertBindHost, isLoopbackHost } from '../lib/loopback.mjs';
import { createProviderHub } from '../lib/provider.mjs';
import { detectIsolation } from '../lib/sandbox.mjs';
import { openStore } from '../lib/store.mjs';
import { createEngine } from '../lib/engine.mjs';

const USAGE = `OpenBot CLI (control-plane preview)

Usage: node cli/openbot.mjs <command> [options]

Commands:
  start              Start the local OpenBot daemon
  run <prompt>       Create a task
  propose            Propose a worker action (file/shell/browser)
  execute <id>       Execute an allowed or approved action
  list               List tasks
  show <id>          Show one task
  approve <id>       Approve a waiting approval (id or --action)
  reject <id>        Reject a waiting approval
  pause <task-id>    Pause a task
  cancel <task-id>   Cancel a task
  resume <task-id>   Resume a paused task
  logs [task-id]     Show event log
  export <task-id>   Export an append-only audit bundle
  doctor             Check loopback, Ollama, store, and isolation
  config             Show local configuration

Options:
  --json             Print machine-readable JSON
  --kind <kind>      Task or action kind (plan, file.write, shell.exec, browser.visit, ...)
  --workspace <dir>  Task workspace directory
  --task <id>        Task id for propose
  --path <path>      Workspace-relative file path
  --content <text>   File contents for a proposed write
  --command <cmd>    Shell command for a proposed exec
  --url <url>        URL for a proposed browser visit
  --output <path>    Markdown output path for browser research
  --action <id>      Action id (approve --action)
  --title <text>     Approval title
  -h, --help         Show this help
`;

const VALUE_FLAGS = {
  '--kind': 'kind',
  '--title': 'title',
  '--workspace': 'workspace',
  '--path': 'path',
  '--content': 'content',
  '--command': 'command',
  '--url': 'url',
  '--output': 'outputPath',
  '--tool': 'tool',
  '--contents': 'contents',
  '--approval': 'approvalId',
  '--task': 'taskId',
  '--action': 'actionId'
};

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(0, eq);
      const mapped = VALUE_FLAGS[name];
      if (!mapped) {
        const error = new Error(`Unknown option: ${name}`);
        error.exitCode = 1;
        throw error;
      }
      flags[mapped] = arg.slice(eq + 1);
    } else if (VALUE_FLAGS[arg]) {
      flags[VALUE_FLAGS[arg]] = argv[index += 1];
    } else if (arg.startsWith('-')) {
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

async function resolveApprovalId(store, id, actionId) {
  const state = await store.getState();
  const approvals = state.approvals || [];
  if (actionId) {
    const bound = approvals.find((item) => item.actionId === actionId);
    if (!bound) fail(Object.assign(new Error('No approval is bound to that action.'), { exitCode: 1 }));
    return bound.id;
  }
  if (!id) fail(Object.assign(new Error('Approval id is required.'), { exitCode: 1 }));
  const direct = approvals.find((item) => item.id === id) || await store.getApproval(id);
  if (direct) return direct.id;
  const byAction = approvals.find((item) => item.actionId === id);
  if (byAction) return byAction.id;
  fail(Object.assign(new Error('Approval not found'), { exitCode: 1 }));
}

function workerTool(flags) {
  return flags.tool || flags.kind || '';
}

async function runWorker(store, flags) {
  const tool = workerTool(flags);
  if (!tool) fail(Object.assign(new Error('Worker tool is required (--tool).'), { exitCode: 1 }));
  if (!flags.workspace) fail(Object.assign(new Error('Workspace is required (--workspace).'), { exitCode: 1 }));
  const engine = createEngine({ store, actor: 'cli' });
  const args = {};
  if (flags.path) args.path = flags.path;
  if (flags.outputPath) args.path = flags.outputPath;
  const contents = flags.contents != null ? flags.contents : flags.content;
  if (contents != null) args.contents = contents;
  if (flags.command) args.command = flags.command;
  if (flags.url) args.url = flags.url;
  const result = await engine.act({
    tool,
    args,
    workspace: flags.workspace,
    taskId: flags.taskId,
    approvalId: flags.approvalId,
    prompt: tool
  });
  print(result, true);
  if (!result.ok && result.status !== 'needs_approval') {
    process.exit(result.status === 'denied' ? 2 : 1);
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
    try {
      const isolation = await detectIsolation(process.env);
      checks.push({ name: 'isolation', ok: true, ...isolation });
    } catch (error) {
      checks.push({ name: 'isolation', ok: false, error: error.message });
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

  if (command === 'run') {
    const prompt = positional.slice(1).join(' ').trim();
    if (!prompt) fail(Object.assign(new Error('run requires a prompt.'), { exitCode: 1 }));
    const created = await store.createTask({
      prompt,
      kind: flags.kind || 'plan',
      title: flags.title,
      workspace: flags.workspace
    });
    print(created, true);
    return;
  }

  if (command === 'act' || command === 'propose') {
    await runWorker(store, flags);
    return;
  }

  if (command === 'execute') {
    await runWorker(store, { ...flags, approvalId: flags.approvalId || positional[1] });
    return;
  }

  if (command === 'list') {
    const tasks = await store.listTasks();
    if (asJson || !tasks.length) print(tasks.length ? tasks : (asJson ? [] : 'No tasks.'), asJson || Boolean(tasks.length));
    else for (const task of tasks) console.log(`${task.id}\t${task.status}\t${task.kind}\t${task.prompt}`);
    return;
  }

  if (command === 'show') {
    const id = positional[1];
    if (!id) fail(Object.assign(new Error('Task id is required.'), { exitCode: 1 }));
    const task = await store.getTask(id);
    if (!task) fail(Object.assign(new Error('Task not found'), { exitCode: 1 }));
    const events = await store.listEvents({ taskId: id });
    print({ task, events }, true);
    return;
  }

  if (command === 'approve' || command === 'reject') {
    const id = await resolveApprovalId(store, positional[1], flags.actionId);
    try {
      const approval = await store.decideApproval(id, command === 'approve' ? 'approved' : 'rejected');
      print({ approval }, true);
    } catch (error) {
      print({ ok: false, error: error.message, statusCode: error.statusCode || 500 }, true);
      process.exit(error.statusCode === 409 ? 2 : 1);
    }
    return;
  }

  if (command === 'pause' || command === 'cancel' || command === 'resume') {
    const id = positional[1];
    if (!id) fail(Object.assign(new Error('Task id is required.'), { exitCode: 1 }));
    const task = await store.setTaskStatus(id, command);
    print({ task }, true);
    return;
  }

  if (command === 'logs') {
    const events = await store.listEvents({ taskId: positional[1] });
    print(events, true);
    return;
  }

  if (command === 'export') {
    const id = positional[1];
    if (!id) fail(Object.assign(new Error('Task id is required.'), { exitCode: 1 }));
    const task = await store.getTask(id);
    if (!task) fail(Object.assign(new Error('Task not found'), { exitCode: 1 }));
    const events = await store.listEvents({ taskId: id });
    print({ exportedAt: new Date().toISOString(), task, events }, true);
    return;
  }

  fail(Object.assign(new Error(`Unknown command: ${command}`), { exitCode: 1 }));
}

main().catch(fail);
