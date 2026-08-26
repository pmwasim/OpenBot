const chat = document.querySelector('#chat');
const form = document.querySelector('#task-form');
const task = document.querySelector('#task');
const workspace = document.querySelector('#workspace');
let modelName = '';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function addMessage(kind, title, text) {
  const article = element('article', `message ${kind}`);
  article.append(element('span', '', kind === 'user' ? 'YOU' : 'OB'));
  const body = element('div');
  body.append(element('b', '', title), element('p', '', text));
  article.append(body);
  chat.append(article);
  chat.scrollTop = chat.scrollHeight;
  return article;
}

function renderActions(message, data) {
  if (!Array.isArray(data.actions) || !data.actions.length) return;
  const cards = element('div', 'action-list');
  for (const action of data.actions) {
    const card = element('div', 'action-card');
    card.append(element('b', '', `${action.tool || 'action'} · ${action.status || 'unknown'}`));
    if (action.reason) card.append(element('p', '', action.reason));
    if (action.approvalId) card.append(element('small', '', `Approval required: ${action.approvalId}`));
    if (action.result && action.status === 'executed') card.append(element('pre', '', JSON.stringify(action.result, null, 2)));
    cards.append(card);
  }
  message.querySelector('div').append(cards);
}

function renderAuditLink(message, taskId) {
  if (!taskId) return;
  const link = element('a', 'audit-link', 'Open task audit ↗');
  link.href = `/api/tasks/${encodeURIComponent(taskId)}/audit`;
  link.target = '_blank';
  link.rel = 'noopener';
  message.querySelector('div').append(link);
}

async function load() {
  const [health, state] = await Promise.all([
    fetch('/api/health').then((response) => response.json()),
    fetch('/api/state').then((response) => response.json())
  ]);
  const dot = document.querySelector('#health-dot');
  modelName = health.models?.[0] || '';
  document.querySelector('#ollama').textContent = health.online ? 'Ollama local' : 'Ollama offline';
  document.querySelector('#model-count').textContent = health.online
    ? `${health.models.length} model${health.models.length === 1 ? '' : 's'} available`
    : 'Start Ollama to activate local intelligence';
  document.querySelector('#model-label').textContent = modelName || (health.online ? 'No model installed' : 'Ollama offline');
  dot.style.background = health.online ? 'var(--green)' : '#e78290';
  renderState(state);
}

function renderState(state) {
  const approvals = document.querySelector('#approvals');
  approvals.replaceChildren();
  const items = Array.isArray(state.approvals) ? state.approvals : [];
  const waiting = items.filter((approval) => approval.status === 'waiting');
  document.querySelector('#approval-count').textContent = String(waiting.length);
  for (const approval of items) {
    const card = element('div', 'approval');
    card.append(element('b', '', approval.title || 'Approval'), element('p', '', approval.detail || ''));
    const controls = element('div');
    if (approval.status === 'waiting') {
      const approve = element('button', 'approve', 'Approve');
      const reject = element('button', 'reject', 'Reject');
      approve.addEventListener('click', () => decide(approval.id, 'approved'));
      reject.addEventListener('click', () => decide(approval.id, 'rejected'));
      controls.append(approve, reject);
    } else controls.append(element('small', '', approval.status || 'closed'));
    card.append(controls);
    approvals.append(card);
  }
  const routines = document.querySelector('#routines');
  routines.replaceChildren();
  for (const routine of (Array.isArray(state.routines) ? state.routines : [])) {
    const card = element('div', 'routine');
    const details = element('div');
    details.append(element('b', '', routine.title || 'Routine'), element('p', '', routine.schedule || ''));
    card.append(details, element('button', `toggle ${routine.enabled ? 'on' : ''}`, ''));
    routines.append(card);
  }
}

async function decide(id, decision) {
  await fetch('/api/approval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, decision })
  });
  await load();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = task.value.trim();
  const root = workspace.value.trim();
  if (!message || !root) {
    addMessage('error', 'OpenBot', 'Enter a task workspace and a prompt first.');
    return;
  }
  addMessage('user', 'You', message);
  task.value = '';
  const pending = addMessage('bot', 'OpenBot', 'Working with the local model…');
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, workspace: root, model: modelName || undefined })
    });
    const data = await response.json();
    pending.querySelector('b').textContent = data.model || 'OpenBot';
    pending.querySelector('p').textContent = data.reply || data.error || data.status || 'OpenBot finished without a reply.';
    if (!response.ok) pending.classList.add('error');
    renderActions(pending, data);
    renderAuditLink(pending, data.taskId);
    await load();
  } catch {
    pending.classList.add('error');
    pending.querySelector('p').textContent = 'OpenBot could not reach the local service.';
  }
});

load().catch(() => addMessage('error', 'OpenBot', 'The local dashboard loaded, but service health could not be checked.'));
