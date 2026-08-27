import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { classifyAction, decide } from './policy.mjs';
import { redactSecrets } from './provider.mjs';
import { fileDiff, fileRead, fileWrite } from './workers/file.mjs';
import { shellExec } from './workers/shell.mjs';
import { browserFetch } from './workers/browser.mjs';
import { connectorFetch } from './connectors.mjs';

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function digestAction({ tool, args, workspace, connector }) {
  return createHash('sha256').update(JSON.stringify(stable({
    tool,
    args,
    workspace,
    connector: connector ? {
      id: connector.id,
      baseUrl: connector.baseUrl,
      allowedPaths: connector.allowedPaths,
      enabled: connector.enabled !== false
    } : null
  }))).digest('hex');
}

function normalizeTool(tool) {
  const value = String(tool || '').trim().toLowerCase();
  if (value === 'browser.visit' || value === 'browser.save') return 'browser.fetch';
  if (value === 'file.edit') return 'file.write';
  return value;
}

function normalizeArgs(args = {}) {
  const next = { ...args };
  if (next.content != null && next.contents == null) next.contents = next.content;
  return next;
}

async function dispatch(tool, args, workspace, signal, browserAllowHosts, connector) {
  if (tool === 'file.write') return fileWrite(workspace, args.path, args.contents ?? args.content ?? '');
  if (tool === 'file.read') return fileRead(workspace, args.path);
  if (tool === 'file.diff') return fileDiff(workspace, args.path, args.contents ?? args.content ?? '');
  if (tool === 'shell.exec') {
    const output = await shellExec(workspace, args.command, { signal });
    if (output.exitCode !== 0) {
      const error = new Error(`Command exited ${output.exitCode}${output.stderr ? `: ${output.stderr.trim()}` : ''}`);
      error.result = output;
      throw error;
    }
    return output;
  }
  if (tool === 'browser.fetch') {
    return browserFetch({ url: args.url, workspace, path: args.path || 'research.md', signal, allowHosts: browserAllowHosts });
  }
  if (tool === 'connector.fetch') return connectorFetch({ connector, path: args.path, signal, allowHosts: browserAllowHosts });
  const error = new Error(`Unknown or disabled tool: ${tool}`);
  error.statusCode = 400;
  throw error;
}

function auditFields(actor, tool, args, result) {
  const safeArgs = redactSecrets(args);
  return { actor, tool, args: safeArgs, result: redactSecrets(result) };
}

export function createEngine({ store, actor = 'openbot', browserAllowHosts } = {}) {
  if (!store) throw new Error('createEngine requires a store.');

  async function record(type, { taskId, actorName, tool, args, result, extra = {} }) {
    const fields = auditFields(actorName, tool, args, result);
    return store.append({
      type,
      taskId,
      ...fields,
      payload: redactSecrets({ ...fields, ...extra })
    });
  }

  async function act(input = {}) {
    const actorName = input.actor || actor;
    const tool = normalizeTool(input.tool);
    const args = normalizeArgs(input.args && typeof input.args === 'object' ? input.args : {});
    if (!input.workspace) {
      throw Object.assign(new Error('workspace is required.'), { statusCode: 400 });
    }
    const workspace = await realpath(input.workspace);

    const connector = tool === 'connector.fetch' && store.getConnector
      ? await store.getConnector(args.connectorId || args.connector)
      : null;

    let taskId = input.taskId;
    if (taskId && store.getTask) {
      const existingTask = await store.getTask(taskId);
      if (!existingTask) throw Object.assign(new Error('Task not found.'), { statusCode: 404 });
      let sameWorkspace = existingTask.workspace === workspace;
      if (!sameWorkspace) {
        try { sameWorkspace = (await realpath(existingTask.workspace)) === workspace; } catch {}
      }
      if (!sameWorkspace) throw Object.assign(new Error('Task workspace does not match the requested workspace.'), { statusCode: 409 });
      if (!['pending', 'running', 'waiting_approval'].includes(existingTask.status)) throw Object.assign(new Error(`Task is not active: ${existingTask.status}.`), { statusCode: 409 });
    }
    if (!taskId) {
      const created = await store.createTask({
        prompt: input.prompt || tool || 'action',
        kind: 'plan',
        workspace,
        owner: actorName
      });
      taskId = created.task.id;
    }

    const classified = classifyAction({ tool, args, workspace, browserAllowHosts, connector });
    const policy = decide(classified);
    const argsDigest = digestAction({ tool, args, workspace, connector });
    const actionId = `action-${argsDigest}`;

    if (policy === 'deny') {
      const result = { ok: false, denied: true, reason: classified.reason || 'Policy denied this action.' };
      const event = await record('action.denied', {
        taskId,
        actorName,
        tool,
        args,
        result,
        extra: { policy, reason: result.reason, actionId, argsDigest, workspace }
      });
      return { ok: false, status: 'denied', policy, result, event, taskId, actionId };
    }

    if (policy === 'require_approval') {
      if (!input.approvalId) {
        let diff = null;
        if (tool === 'file.write') {
          const preview = await fileDiff(workspace, args.path, args.contents ?? '');
          diff = preview.diff;
        }
        const approval = await store.createApproval({
          taskId,
          title: `Approve ${tool}`,
          detail: diff || JSON.stringify(redactSecrets(args)),
          actionId,
          argsDigest,
          tool,
          boundArgs: { tool, args, workspace }
        });
        const result = { ok: false, needsApproval: true, approvalId: approval.id, actionId, diff };
        const event = await record('action.proposed', {
          taskId,
          actorName,
          tool,
          args,
          result,
          extra: {
            policy,
            approvalId: approval.id,
            argsDigest,
            diff,
            actionId,
            workspace,
            status: 'proposed'
          }
        });
        return {
          ok: false,
          status: 'needs_approval',
          policy,
          approval,
          diff,
          result,
          event,
          taskId,
          argsDigest,
          actionId
        };
      }
      try {
        await store.consumeApproval({
          id: input.approvalId,
          argsDigest,
          actionId,
          taskId
        });
      } catch (error) {
        const result = { ok: false, denied: true, reason: error.message };
        const event = await record('action.denied', {
          taskId,
          actorName,
          tool,
          args,
          result,
          extra: { policy, approvalId: input.approvalId, reason: error.message, actionId, argsDigest, workspace }
        });
        return { ok: false, status: 'denied', policy, result, event, taskId, actionId };
      }
    } else if (input.execute === false) {
      const result = { ok: false, needsExecute: true, actionId };
      const event = await record('action.proposed', {
        taskId,
        actorName,
        tool,
        args,
        result,
        extra: { policy, actionId, argsDigest, workspace, status: 'proposed', approvalId: null }
      });
      return { ok: false, status: 'proposed', policy, result, event, taskId, argsDigest, actionId };
    }

    try {
      const output = await dispatch(tool, args, workspace, input.signal, browserAllowHosts, connector);
      const result = { ok: true, ...output };
      const event = await record('action.executed', {
        taskId,
        actorName,
        tool,
        args,
        result,
        extra: { policy, approvalId: input.approvalId || null, actionId, argsDigest, workspace }
      });
      return { ok: true, status: 'executed', policy, result, event, taskId, actionId };
    } catch (error) {
      const result = {
        ok: false,
        error: error.message,
        code: error.code || null,
        ...(error.result || {})
      };
      const event = await record('action.failed', {
        taskId,
        actorName,
        tool,
        args,
        result,
        extra: { policy, approvalId: input.approvalId || null, actionId, argsDigest, workspace }
      });
      return { ok: false, status: 'failed', policy, result, event, taskId, actionId };
    }
  }

  return { act };
}
