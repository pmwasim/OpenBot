export const REQUIRE_APPROVAL_KINDS = Object.freeze([
  'send',
  'publish',
  'purchase',
  'delete',
  'production-change'
]);

export const DECISIONS = Object.freeze(['allow', 'deny', 'require_approval']);

function kindOf(action = {}) {
  const raw = action.kind || action.type || action.class || '';
  const value = String(raw).trim().toLowerCase();
  if (value === 'production') return 'production-change';
  return value;
}

export function decide(action = {}) {
  const kind = kindOf(action);
  if (action.deny === true || action.decision === 'deny' || kind === 'deny' || kind === 'forbidden') return 'deny';
  if (REQUIRE_APPROVAL_KINDS.includes(kind)) return 'require_approval';
  return 'allow';
}

export function describePolicy() {
  return {
    default: 'allow',
    require_approval: [...REQUIRE_APPROVAL_KINDS],
    note: 'Approvals created going forward bind to a task and action id.'
  };
}
