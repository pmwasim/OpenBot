import { isAbsolute, relative, resolve, sep } from 'node:path';

export const REQUIRE_APPROVAL_KINDS = Object.freeze([
  'send',
  'publish',
  'purchase',
  'delete',
  'production-change'
]);

export const DECISIONS = Object.freeze(['allow', 'deny', 'require_approval']);

export const SAFE_SHELL_PROGRAMS = Object.freeze(['uname', 'pwd', 'date', 'whoami', 'id', 'true']);

const SIMPLE_COMMAND = /^[a-zA-Z0-9@%+=:,._/\-\s]+$/;
const DESTRUCTIVE_PROGRAMS = new Set(['mkfs', 'mkfs.ext4', 'dd', 'shutdown', 'reboot', 'halt', 'format', 'sudo']);

function kindOf(action = {}) {
  const raw = action.kind || action.type || action.class || '';
  const value = String(raw).trim().toLowerCase();
  if (value === 'production') return 'production-change';
  return value;
}

function connectorPathAllowed(path, allowedPaths = []) {
  const requested = String(path || '').split('?')[0].split('#')[0];
  return allowedPaths.some((allowed) => {
    const prefix = String(allowed || '');
    return requested === prefix || prefix === '/' || requested.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
  });
}

export function pathOutsideWorkspace(workspace, inputPath) {
  if (inputPath == null || String(inputPath).trim() === '') return true;
  const value = String(inputPath);
  if (value === '/' || value === '~' || value.startsWith('~/')) return true;
  if (!workspace) return isAbsolute(value) || value.includes('..');
  const root = resolve(workspace);
  const candidate = resolve(root, value);
  if (candidate === root) return false;
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export function classifyShellCommand(command, workspace) {
  const raw = String(command || '').trim();
  if (!raw) {
    return { safe: false, destructive: true, outsideWorkspace: false, deletes: false, reason: 'Command is required.', argv: [] };
  }
  if (!SIMPLE_COMMAND.test(raw)) {
    return { safe: false, destructive: true, outsideWorkspace: false, deletes: false, reason: 'Shell metacharacters are not allowed.', argv: [] };
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  const program = tokens[0];
  const args = tokens.slice(1);
  const argv = [program, ...args];

  if (DESTRUCTIVE_PROGRAMS.has(program)) {
    return { safe: false, destructive: true, outsideWorkspace: false, deletes: false, reason: `Program "${program}" is not allowed.`, argv };
  }

  if (program === 'node') {
    if (args.length === 1 && (args[0] === '-v' || args[0] === '--version')) {
      return { safe: true, destructive: false, outsideWorkspace: false, deletes: false, argv };
    }
    return { safe: false, destructive: true, outsideWorkspace: false, deletes: false, reason: 'Only node version reporting is allowed.', argv };
  }

  if (SAFE_SHELL_PROGRAMS.includes(program) && args.every((arg) => arg.startsWith('-') || /^[A-Za-z0-9._-]+$/.test(arg))) {
    return { safe: true, destructive: false, outsideWorkspace: false, deletes: false, argv };
  }

  if (program === 'ls') {
    const outsideWorkspace = args.some((arg) => !arg.startsWith('-') && pathOutsideWorkspace(workspace, arg));
    if (outsideWorkspace) return { safe: false, destructive: true, outsideWorkspace: true, deletes: false, reason: 'Listing outside the workspace is refused.', argv };
    return { safe: true, destructive: false, outsideWorkspace: false, deletes: false, argv };
  }

  if (program === 'rm') {
    const paths = args.filter((arg) => !arg.startsWith('-'));
    const recursive = args.some((arg) => arg.startsWith('-') && arg.includes('r'));
    const force = args.some((arg) => arg.startsWith('-') && arg.includes('f'));
    const outside = paths.some((item) => item === '/' || item === '/*' || pathOutsideWorkspace(workspace, item));
    const rooted = paths.some((item) => item === '/' || item === '/*' || item === '/**');
    if (outside || rooted || (recursive && force && (outside || !paths.length))) {
      return {
        safe: false,
        destructive: true,
        outsideWorkspace: outside || rooted,
        deletes: true,
        reason: 'Destructive or out-of-workspace rm is refused.',
        argv
      };
    }
    return {
      safe: false,
      destructive: false,
      outsideWorkspace: false,
      deletes: true,
      reason: 'Deleting files requires approval.',
      argv
    };
  }

  return {
    safe: false,
    destructive: false,
    outsideWorkspace: false,
    deletes: false,
    reason: 'Command is not on the safe allowlist.',
    argv
  };
}

export function classifyBrowserUrl(url, { allowHosts = ['127.0.0.1', 'localhost'] } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return { allowlisted: false, reason: 'URL is invalid.', parsed: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowlisted: false, reason: 'Only http(s) URLs are allowed.', parsed };
  }
  if (parsed.username || parsed.password) {
    return { allowlisted: false, reason: 'URLs with credentials are not allowed.', parsed };
  }
  const normalizedHosts = allowHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean);
  if (!normalizedHosts.includes(parsed.hostname.toLowerCase())) {
    return { allowlisted: false, reason: `Host ${parsed.hostname} is not allowlisted.`, parsed };
  }
  return { allowlisted: true, parsed };
}

export function classifyAction(action = {}) {
  const tool = String(action.tool || '').trim().toLowerCase();
  const args = action.args || {};
  const workspace = action.workspace;
  const base = { ...action, tool, args, workspace, kind: action.kind || tool };

  if (!tool) return { ...base, deny: true, reason: 'Tool is required.' };
  if (tool.startsWith('desktop')) {
    return { ...base, deny: true, reason: 'Desktop worker is disabled in Phase 1.' };
  }
  if (tool === 'file.write' || tool === 'file.read' || tool === 'file.diff') {
    if (!args.path) return { ...base, deny: true, outsideWorkspace: true, reason: 'Path is required.' };
    const outsideWorkspace = pathOutsideWorkspace(workspace, args.path);
    return {
      ...base,
      outsideWorkspace,
      reason: outsideWorkspace ? 'Path escapes workspace.' : undefined
    };
  }
  if (tool === 'shell.exec') {
    const classified = classifyShellCommand(args.command, workspace);
    return { ...base, ...classified, kind: classified.deletes ? 'delete' : 'shell' };
  }
  if (tool === 'browser.fetch' || tool === 'browser.save' || tool === 'browser.visit') {
    const classified = classifyBrowserUrl(args.url, { allowHosts: Array.isArray(action.browserAllowHosts) ? action.browserAllowHosts : undefined });
    return { ...base, ...classified, kind: 'browser' };
  }
  if (tool === 'connector.fetch') {
    const connector = action.connector;
    const endpoint = connector?.baseUrl ? classifyBrowserUrl(connector.baseUrl, { allowHosts: Array.isArray(action.browserAllowHosts) ? action.browserAllowHosts : undefined }) : { allowlisted: false };
    const pathAllowed = connector && connectorPathAllowed(args.path, connector.allowedPaths);
    const reason = !connector ? 'Connector is not registered.'
      : connector.enabled === false ? 'Connector is disabled.'
        : !endpoint.allowlisted ? (endpoint.reason || 'Connector host is not allowlisted.')
          : !pathAllowed ? 'Connector request path is not allowlisted.' : undefined;
    return { ...base, connector, allowlisted: endpoint.allowlisted, deny: Boolean(reason), reason, kind: 'connector' };
  }
  return base;
}

export function decide(action = {}) {
  const classified = action.tool ? (action.safe !== undefined || action.allowlisted !== undefined || action.outsideWorkspace !== undefined || action.deny !== undefined ? action : classifyAction(action)) : action;
  const kind = kindOf(classified);
  const tool = String(classified.tool || '').trim().toLowerCase();

  if (classified.deny === true || classified.decision === 'deny' || kind === 'deny' || kind === 'forbidden') return 'deny';

  if (tool === 'file.write') {
    if (classified.outsideWorkspace) return 'deny';
    return 'require_approval';
  }
  if (tool === 'file.read' || tool === 'file.diff') {
    return classified.outsideWorkspace ? 'deny' : 'allow';
  }
  if (tool === 'shell.exec') {
    if (classified.destructive || classified.outsideWorkspace) return 'deny';
    if (classified.safe) return 'allow';
    if (classified.deletes || kind === 'delete') return 'require_approval';
    return 'require_approval';
  }
  if (tool === 'browser.fetch' || tool === 'browser.save' || tool === 'browser.visit') {
    if (classified.allowlisted === false || classified.outsideWorkspace) return 'deny';
    return 'require_approval';
  }
  if (tool === 'connector.fetch') return classified.deny ? 'deny' : 'require_approval';
  if (tool.startsWith('desktop')) return 'deny';

  if (REQUIRE_APPROVAL_KINDS.includes(kind)) return 'require_approval';
  return 'allow';
}

export function describePolicy() {
  return {
    default: 'allow',
    require_approval: [...REQUIRE_APPROVAL_KINDS, 'file.write', 'browser.fetch', 'connector.fetch', 'shell.delete'],
    deny: ['workspace-escape', 'destructive-shell', 'non-allowlisted-browser', 'desktop'],
    note: 'Approvals created going forward bind to a task and action id and are one-shot.'
  };
}

export function evaluateAction(action = {}, context = {}) {
  const workspace = context.workspace || action.workspace;
  const kind = String(action.kind || action.tool || action.class || '').trim();
  const tool = action.tool || kind;
  const args = action.args || {
    path: action.path,
    command: action.command,
    url: action.url,
    content: action.content
  };
  const classified = classifyAction({ ...action, tool, args, workspace, kind });
  const decision = decide(classified);
  const resolvedPath = classified.outsideWorkspace || !args.path || !workspace
    ? undefined
    : resolve(workspace, String(args.path));
  return { ...classified, decision, resolvedPath };
}

export function inspectUrl(url, options) {
  const classified = classifyBrowserUrl(url, options);
  return { ...classified, ok: classified.allowlisted === true };
}

export function parseCommand(command, workspace) {
  const classified = classifyShellCommand(command, workspace);
  return {
    ...classified,
    ok: Boolean(classified.argv?.length) && !classified.destructive,
    args: (classified.argv || []).slice(1)
  };
}
