import { createEngine } from './engine.mjs';
import { loadConfig } from './config.mjs';

const TOOL_ALIAS = {
  'browser.visit': 'browser.fetch',
  'browser.save': 'browser.fetch',
  'file.edit': 'file.write'
};

function mapTool(value) {
  const tool = String(value || '').trim().toLowerCase();
  return TOOL_ALIAS[tool] || tool;
}

function argsFrom(input = {}, tool) {
  if (input.args && typeof input.args === 'object') {
    const args = { ...input.args };
    if (args.content != null && args.contents == null) args.contents = args.content;
    if (tool === 'browser.fetch' && input.outputPath && !args.path) args.path = input.outputPath;
    return args;
  }
  if (tool === 'file.write' || tool === 'file.read' || tool === 'file.diff') {
    return { path: input.path, contents: input.contents ?? input.content ?? '' };
  }
  if (tool === 'shell.exec') {
    return { command: input.command };
  }
  if (tool === 'browser.fetch') {
    return { url: input.url, path: input.outputPath || input.path || 'research.md' };
  }
  if (tool === 'connector.fetch') {
    return { connectorId: input.connectorId || input.connector, path: input.path };
  }
  return {};
}

async function resolveWorkspace(store, input) {
  if (input.workspace && input.workspace !== 'local') return input.workspace;
  if (input.taskId) {
    const task = await store.getTask(input.taskId);
    if (task?.workspace && task.workspace !== 'local') return task.workspace;
  }
  const error = new Error('workspace is required.');
  error.statusCode = 400;
  throw error;
}

export async function proposeAction(store, input = {}, env = process.env) {
  const tool = mapTool(input.tool || input.kind);
  const workspace = await resolveWorkspace(store, input);
  const engine = createEngine({ store, actor: input.actor || 'operator', browserAllowHosts: loadConfig(env).browserAllowHosts });
  return engine.act({
    actor: input.actor || 'operator',
    taskId: input.taskId,
    workspace,
    tool,
    args: argsFrom(input, tool),
    prompt: input.title || input.prompt,
    execute: false
  });
}

export async function executeAction(store, actionId, env = process.env) {
  if (!actionId) {
    const error = new Error('Action id is required.');
    error.statusCode = 400;
    throw error;
  }
  let action = await store.getAction(actionId);
  if (!action) {
    const approval = await store.getApprovalByActionId(actionId);
    if (approval?.boundArgs) {
      action = {
        id: actionId,
        taskId: approval.taskId,
        tool: approval.tool || approval.boundArgs.tool,
        args: approval.boundArgs.args,
        workspace: approval.boundArgs.workspace,
        approvalId: approval.id,
        status: approval.status === 'consumed' ? 'executed' : 'proposed'
      };
    }
  }
  if (!action) {
    const error = new Error('Action not found.');
    error.statusCode = 404;
    throw error;
  }
  if (action.status === 'executed') {
    const error = new Error('Action already executed.');
    error.statusCode = 409;
    throw error;
  }
  const engine = createEngine({ store, actor: 'openbot', browserAllowHosts: loadConfig(env).browserAllowHosts });
  return engine.act({
    actor: 'openbot',
    taskId: action.taskId,
    workspace: action.workspace,
    tool: action.tool,
    args: action.args,
    approvalId: action.approvalId,
    execute: true
  });
}
