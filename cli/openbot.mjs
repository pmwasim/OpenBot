#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig, publicConfig, ROOT } from '../lib/config.mjs';
import { assertBindHost, isLoopbackHost } from '../lib/loopback.mjs';
import { createProviderHub } from '../lib/provider.mjs';
import { detectIsolation } from '../lib/sandbox.mjs';
import { openStore } from '../lib/store.mjs';
import { createEngine } from '../lib/engine.mjs';
import { createAgentController } from '../lib/agent.mjs';
import { createRoutineScheduler } from '../lib/routines.mjs';

const USAGE = `OpenBot CLI (local agent)

Usage: node cli/openbot.mjs <command> [options]

Commands:
  start              Start the local OpenBot daemon
  run <prompt>       Create a task
  chat <prompt>      Run the bounded local agent loop
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
  doctor             Check loopback, local model, store, and isolation
  config             Show local configuration
  memory list        List workspace-scoped local memory
  memory add         Save an operator-approved memory fact
  memory delete      Delete a local memory fact
  bot list           List named local bots
  bot add            Create a named local bot
  bot chat <id>      Chat with a named local bot
  bot delete <id>    Delete a named local bot
  skill list         List reusable local skills
  skill add          Save an operator-approved local skill
  skill delete       Delete a local skill
  routine list       List local scheduled routines
  routine add        Create a local scheduled routine
  routine run <id>   Run a routine once now
  routine pause <id> Pause a routine
  routine enable <id> Enable a routine

Options:
  --json             Print machine-readable JSON
  --kind <kind>      Task or action kind (plan, file.write, shell.exec, browser.visit, ...)
  --model <name>     Local model name (defaults to the first installed model)
  --key <name>       Memory key for memory add
  --value <text>     Memory value for memory add
  --name <name>      Skill name for skill add
  --role <text>      Bot role for bot add
  --description <t>  Skill description for skill add
  --instructions <t> Skill instructions for skill add
  --skill <name>     Select a local skill for chat
  --bot <id>         Select a named local bot
  --schedule <value> Routine schedule (every 15m or daily 09:30)
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
  '--action': 'actionId',
  '--model': 'model',
  '--key': 'key',
  '--value': 'value',
  '--name': 'name',
  '--role': 'role',
  '--description': 'description',
  '--instructions': 'instructions',
  '--skill': 'skill',
  '--bot': 'bot',
  '--schedule': 'schedule'
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

function fixtureAgentProvider(raw) {
  let replies;
  try { replies = JSON.parse(raw); }
  catch { replies = []; }
  let index = 0;
  return {
    async chatStructured({ model }) {
      if (index >= replies.length) return { ok: false, status: 502, model, error: 'Test agent response queue is exhausted.' };
      return { ok: true, status: 200, model: model || 'fixture', reply: replies[index++] };
    }
  };
}

async function runAgent(store, config, flags, prompt, options = {}) {
  if (!prompt) fail(Object.assign(new Error('chat requires a prompt.'), { exitCode: 1 }));
  const bot = flags.bot ? await store.getBot(flags.bot) : null;
  if (flags.bot && !bot) fail(Object.assign(new Error('Bot not found.'), { exitCode: 1 }));
  const workspace = flags.workspace || bot?.workspace;
  if (!workspace || workspace === 'local') fail(Object.assign(new Error('Workspace is required (--workspace) or provided by the bot.'), { exitCode: 1 }));

  const fixture = Boolean(process.env.OPENBOT_TEST_AGENT_RESPONSES);
  const hub = createProviderHub(process.env, { modelUrl: config.modelUrl, remoteBaseUrl: config.remoteBaseUrl });
  let model = flags.model || '';
  let provider = hub.localModel;
  if (fixture) {
    provider = fixtureAgentProvider(process.env.OPENBOT_TEST_AGENT_RESPONSES);
  } else {
    let tags;
    try { tags = await provider.tags(); }
    catch (error) { fail(Object.assign(new Error(`Local model runtime is unavailable: ${error.message}`), { exitCode: 1 })); }
    if (!tags.ok) fail(Object.assign(new Error('Local model runtime is unavailable. Start it, then install a local model.'), { exitCode: 1 }));
    model = model || tags.models[0] || '';
    if (!model) fail(Object.assign(new Error('The local model runtime has no model. Install one before using chat.'), { exitCode: 1 }));
    if (!tags.models.includes(model)) fail(Object.assign(new Error(`Requested model is not installed locally: ${model}`), { exitCode: 1 }));
  }

  const controller = createAgentController({
    store,
    provider,
    engine: createEngine({ store, actor: 'agent' }),
    actor: 'agent',
    maxTurns: config.agentMaxTurns,
    maxActions: config.agentMaxActions,
    maxContextChars: config.agentContextChars
  });
  const result = await controller.run({ prompt, workspace, taskId: flags.taskId, model, skill: flags.skill, bot });
  if (bot && !flags.taskId) {
    await store.recordBotMessage(bot.id, { role: 'user', content: prompt, taskId: result.taskId });
    await store.recordBotMessage(bot.id, {
      role: 'assistant',
      content: result.reply || (result.status === 'waiting_approval' ? 'Waiting for approval before continuing.' : `Task stopped with status: ${result.status}.`),
      taskId: result.taskId
    });
  }
  if (options.printResult !== false) {
    if (flags.json) print({ botId: bot?.id || null, model: model || 'fixture', ...result }, true);
    else print(result.reply || `${result.status}${result.approvals?.length ? `: approval ${result.approvals[0].id}` : ''}`);
    if (!['completed', 'waiting_approval'].includes(result.status)) process.exit(result.status === 'denied' ? 2 : 1);
  }
  return result;
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
        console.warn(`WARNING: HOST=${config.host} is protected by OPENBOT_AUTH_TOKEN; requests require a bearer token.`);
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
        console.warn(`WARNING: HOST=${config.host} is protected by OPENBOT_AUTH_TOKEN; requests require a bearer token.`);
      }
    } catch (error) {
      checks.push({ name: 'loopback', ok: false, error: error.message, loopback: isLoopbackHost(config.host) });
    }
    try {
      const hub = createProviderHub(process.env, { modelUrl: config.modelUrl, remoteBaseUrl: config.remoteBaseUrl });
      const tags = await hub.localModel.tags();
      checks.push({ name: 'local-model', ok: Boolean(tags.ok), models: tags.models || [], url: config.modelUrl });
    } catch (error) {
      checks.push({ name: 'local-model', ok: false, error: error.message, url: config.modelUrl });
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
    checks.push({
      name: 'resources',
      ok: true,
      profile: config.resourceProfile,
      agentMaxTurns: config.agentMaxTurns,
      agentMaxActions: config.agentMaxActions,
      agentContextChars: config.agentContextChars,
      guidance: config.resourceProfile === 'legacy'
        ? 'CPU-only profile: bounded agent work uses 3 turns/actions and allowlisted diagnostics do not require Docker.'
        : 'Standard profile: bounded agent work uses 6 turns/actions; use legacy on older CPU-only laptops.'
    });
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

  if (command === 'memory') {
    const subcommand = positional[1];
    if (subcommand === 'list') {
      if (!flags.workspace || flags.workspace === 'local') fail(Object.assign(new Error('Workspace is required (--workspace).'), { exitCode: 1 }));
      print({ memories: await store.listMemories({ workspace: flags.workspace }) }, true);
      return;
    }
    if (subcommand === 'add') {
      if (!flags.workspace || flags.workspace === 'local') fail(Object.assign(new Error('Workspace is required (--workspace).'), { exitCode: 1 }));
      const created = await store.createMemory({ workspace: flags.workspace, key: flags.key, value: flags.value });
      print(created, true);
      return;
    }
    if (subcommand === 'delete') {
      const id = positional[2];
      if (!id) fail(Object.assign(new Error('Memory id is required.'), { exitCode: 1 }));
      print(await store.deleteMemory(id), true);
      return;
    }
    fail(Object.assign(new Error('Use memory list, memory add, or memory delete.'), { exitCode: 1 }));
  }

  if (command === 'bot') {
    const subcommand = positional[1];
    if (subcommand === 'list') {
      const bots = await store.listBots();
      if (asJson) print({ bots }, true);
      else if (!bots.length) print('No bots.');
      else for (const bot of bots) console.log(`${bot.id}\t${bot.name}\t${bot.role || 'local bot'}\t${bot.messageCount || 0} messages`);
      return;
    }
    if (subcommand === 'add') {
      const created = await store.createBot({ name: flags.name || positional[2], role: flags.role, instructions: flags.instructions || positional.slice(3).join(' '), workspace: flags.workspace, skill: flags.skill });
      print(created, true);
      return;
    }
    if (subcommand === 'delete') {
      const id = positional[2];
      if (!id) fail(Object.assign(new Error('Bot id is required.'), { exitCode: 1 }));
      print(await store.deleteBot(id), true);
      return;
    }
    if (subcommand === 'chat') {
      const id = positional[2];
      if (!id) fail(Object.assign(new Error('Bot id is required.'), { exitCode: 1 }));
      const bot = await store.getBot(id);
      if (!bot) fail(Object.assign(new Error('Bot not found.'), { exitCode: 1 }));
      await runAgent(store, config, { ...flags, bot: id, workspace: flags.workspace || bot.workspace }, positional.slice(3).join(' ').trim());
      return;
    }
    fail(Object.assign(new Error('Use bot list, bot add, bot chat, or bot delete.'), { exitCode: 1 }));
  }

  if (command === 'skill') {
    const subcommand = positional[1];
    if (subcommand === 'list') {
      print({ skills: await store.listSkills() }, true);
      return;
    }
    if (subcommand === 'add') {
      const created = await store.createSkill({ name: flags.name, description: flags.description, instructions: flags.instructions });
      print(created, true);
      return;
    }
    if (subcommand === 'delete') {
      const id = positional[2];
      if (!id) fail(Object.assign(new Error('Skill id is required.'), { exitCode: 1 }));
      print(await store.deleteSkill(id), true);
      return;
    }
    fail(Object.assign(new Error('Use skill list, skill add, or skill delete.'), { exitCode: 1 }));
  }

  if (command === 'routine') {
    const subcommand = positional[1];
    if (subcommand === 'list') {
      const routines = await store.listRoutines();
      if (asJson) print({ routines }, true);
      else if (!routines.length) print('No routines.');
      else for (const routine of routines) console.log(`${routine.id}\t${routine.enabled ? 'enabled' : 'paused'}\t${routine.schedule}\t${routine.title}`);
      return;
    }
    if (subcommand === 'add') {
      const created = await store.createRoutine({ title: flags.title, schedule: flags.schedule, prompt: flags.prompt || positional.slice(2).join(' '), workspace: flags.workspace, skill: flags.skill, botId: flags.bot });
      print(created, true);
      return;
    }
    if (['pause', 'enable'].includes(subcommand)) {
      const id = positional[2];
      if (!id) fail(Object.assign(new Error('Routine id is required.'), { exitCode: 1 }));
      print(await store.updateRoutine(id, { enabled: subcommand === 'enable' }), true);
      return;
    }
    if (subcommand === 'run') {
      const id = positional[2];
      if (!id) fail(Object.assign(new Error('Routine id is required.'), { exitCode: 1 }));
      const routine = await store.getRoutine(id);
      if (!routine) fail(Object.assign(new Error('Routine not found.'), { exitCode: 1 }));
      const scheduler = createRoutineScheduler({
        store,
        runRoutine: async (item) => runAgent(store, config, { ...flags, workspace: item.workspace, skill: item.skill, bot: item.botId, json: true }, item.prompt, { printResult: false }),
        tickMs: 60_000
      });
      const result = await scheduler.runNow(id);
      print({ routineId: id, result }, true);
      if (!['completed', 'waiting_approval'].includes(result.status)) process.exit(1);
      return;
    }
    fail(Object.assign(new Error('Use routine list, routine add, routine run, routine pause, or routine enable.'), { exitCode: 1 }));
  }

  if (command === 'run') {
    const prompt = positional.slice(1).join(' ').trim();
    if (!prompt) fail(Object.assign(new Error('run requires a prompt.'), { exitCode: 1 }));
    const created = await store.createTask({
      prompt,
      kind: flags.kind || 'plan',
      title: flags.title,
      workspace: flags.workspace,
      skill: flags.skill
    });
    print(created, true);
    return;
  }

  if (command === 'act' || command === 'propose') {
    await runWorker(store, flags);
    return;
  }

  if (command === 'chat') {
    await runAgent(store, config, flags, positional.slice(1).join(' ').trim());
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
