export const REQUIRE_APPROVAL_KINDS = Object.freeze([
  'send',
  'publish',
  'purchase',
  'delete',
  'production-change'
]);

export const DECISIONS = Object.freeze(['allow', 'deny', 'require_approval']);

export const REQUIRE_APPROVAL_TOOLS = Object.freeze([
  'file.write',
  'file.append',
  'file.delete',
  'shell.exec',
  'browser.fetch'
]);

function kindOf(action = {}) {
  const raw = action.kind || action.type || action.class || '';
  const value = String(raw).trim().toLowerCase();
  if (value === 'production') return 'production-change';
  return value;
}

export function decide(action = {}) {
  const kind = kindOf(action);
  const tool = String(action.tool || '').trim().toLowerCase();
  if (action.deny === true || action.decision === 'deny' || kind === 'deny' || kind === 'forbidden') return 'deny';
  if (REQUIRE_APPROVAL_KINDS.includes(kind) || REQUIRE_APPROVAL_TOOLS.includes(tool)) return 'require_approval';
  return 'allow';
}

export function describePolicy() {
  return {
    default: 'allow',
    require_approval: [...REQUIRE_APPROVAL_KINDS],
    require_approval_tools: [...REQUIRE_APPROVAL_TOOLS],
    note: 'Approvals created going forward bind to a task, action id, and action digest.'
  };
}
