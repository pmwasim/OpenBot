const chat = document.querySelector('#chat');
const form = document.querySelector('#task-form');
const task = document.querySelector('#task');
const workspace = document.querySelector('#workspace');
const memoryForm = document.querySelector('#memory-form');
const skillForm = document.querySelector('#skill-form');
const routineForm = document.querySelector('#routine-form');
const botForm = document.querySelector('#bot-form');
const connectorForm = document.querySelector('#connector-form');
const skillSelect = document.querySelector('#skill');
const botSelect = document.querySelector('#bot');
const providerSelect = document.querySelector('#provider');
const modelSelect = document.querySelector('#model');
const conversationSearch = (() => {
  const existing = document.querySelector('#conversation-search');
  if (existing) return existing;
  const bar = element('div', 'conversation-search');
  const input = element('input');
  input.id = 'conversation-search';
  input.placeholder = 'Search selected bot history';
  input.autocomplete = 'off';
  const search = element('button', 'text', 'Search history');
  search.id = 'conversation-search-button';
  search.type = 'button';
  const clear = element('button', 'text', 'Clear');
  clear.id = 'conversation-search-clear';
  clear.type = 'button';
  bar.append(input, search, clear);
  botSelect?.after(bar);
  return input;
})();
let botProfiles = new Map();
let providerProfiles = new Map();
let modelName = '';
let taskEventOffsets = new Map();
let taskActivityNodes = new Map();
let taskMessages = new Map();
let taskEventStreams = new Map();
let watchedTasks = [];
let taskActivityTimer = null;
let taskActivityBusy = false;
let taskStreamFallback = false;
let conversationRequest = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const notificationButton = (() => {
  const existing = document.querySelector('#notifications');
  if (existing) return existing;
  const button = element('button', 'text', 'Enable completion notifications');
  button.id = 'notifications';
  button.type = 'button';
  document.querySelector('.right section')?.append(button);
  return button;
})();
const settingsButton = document.querySelector('.side-bottom button');
settingsButton.id = 'settings';

function syncNotificationControl() {
  if (typeof Notification === 'undefined') {
    notificationButton.textContent = 'Notifications unavailable in this browser';
    notificationButton.disabled = true;
    return;
  }
  if (Notification.permission === 'granted') {
    notificationButton.textContent = 'Completion notifications enabled';
    notificationButton.disabled = true;
  } else if (Notification.permission === 'denied') {
    notificationButton.textContent = 'Notifications blocked by browser';
    notificationButton.disabled = true;
  } else {
    notificationButton.textContent = 'Enable completion notifications';
  }
}

async function enableNotifications() {
  if (typeof Notification === 'undefined') return;
  try { await Notification.requestPermission(); } catch {}
  syncNotificationControl();
}

function notifyTaskCompletion(taskItem) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const status = String(taskItem?.status || 'finished').toLowerCase();
  const summary = String(taskItem?.result || taskItem?.error || `Task ${status}.`).slice(0, 180);
  try { new Notification(`OpenBot task ${status}`, { body: summary }); } catch {}
}

async function showSettings() {
  let dialog = document.querySelector('#settings-dialog');
  if (!dialog) {
    dialog = element('dialog');
    dialog.id = 'settings-dialog';
    const panel = element('form', 'settings-panel');
    panel.method = 'dialog';
    panel.append(element('h2', '', 'Effective settings'), element('p', 'hint', 'Read-only values used by this local daemon. Change configuration through the documented environment settings, then restart the daemon.'));
    const content = element('div', 'settings-values');
    content.id = 'settings-values';
    panel.append(content);
    const close = element('button', 'primary', 'Close');
    close.type = 'submit';
    panel.append(close);
    dialog.append(panel);
    document.body.append(dialog);
  }
  const content = dialog.querySelector('#settings-values');
  content.replaceChildren(element('small', '', 'Loading…'));
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || 'Settings could not be loaded.');
    const values = [
      ['Resource profile', config.resourceProfile],
      ['Resource selection', config.resourceProfileMode],
      ['Isolation', config.isolation],
      ['Local-only mode', config.localOnly ? 'enabled' : 'disabled'],
      ['Local model protocol', config.modelProtocol],
      ['Local model endpoint', config.modelUrl],
      ['Compatible provider', config.remoteCompatible],
      ['Provider key', config.remoteApiKey],
      ['Daemon binding', `${config.host}:${config.port}`],
      ['Browser hosts', (config.browserAllowHosts || []).join(', ') || 'loopback defaults'],
      ['Agent limits', `${config.agentMaxTurns} turns · ${config.agentMaxActions} actions · ${config.agentContextChars} context chars`]
    ];
    content.replaceChildren(...values.map(([label, value]) => {
      const row = element('div', 'settings-row');
      row.append(element('b', '', label), element('span', '', String(value ?? 'not set')));
      return row;
    }));
  } catch (error) {
    content.replaceChildren(element('small', 'error', error.message || 'Settings could not be loaded.'));
  }
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

function renderBotConversation(bot, messages) {
  chat.replaceChildren();
  addMessage('bot', bot?.name || 'OpenBot', bot
    ? `This is the durable conversation for ${bot.name}. Tasks remain approval-gated and scoped to its workspace.`
    : 'Give me a task. I will use your local model to plan it and will stop before any consequential action.');
  for (const message of Array.isArray(messages) ? messages : []) {
    addMessage(message.role === 'user' ? 'user' : 'bot', message.role === 'user' ? 'You' : (bot?.name || 'OpenBot'), message.content || '');
  }
}

async function loadBotConversation(id, query = conversationSearch.value.trim()) {
  const requestId = ++conversationRequest;
  if (!id) {
    renderBotConversation(null, []);
    return;
  }
  const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
  const response = await fetch(`/api/bots/${encodeURIComponent(id)}/messages${suffix}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Bot conversation could not be loaded.');
  if (requestId !== conversationRequest || botSelect.value !== id) return;
  const bot = botProfiles.get(id) || { name: 'OpenBot' };
  renderBotConversation(bot, data.messages);
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

function describeTaskEvent(event) {
  const type = String(event?.type || 'task activity').replaceAll('.', ' ');
  const status = event?.payload?.status ? ` · ${event.payload.status}` : '';
  return `${type}${status}`;
}

function renderModels(models) {
  const selected = modelSelect.value;
  modelSelect.replaceChildren();
  const automatic = element('option', '', models.length ? `Use the first available local model (${models[0]})` : 'No local model available');
  automatic.value = '';
  modelSelect.append(automatic);
  for (const model of models) {
    const option = element('option', '', model);
    option.value = model;
    modelSelect.append(option);
  }
  modelSelect.disabled = models.length === 0;
  if (models.includes(selected)) modelSelect.value = selected;
}

function renderProviders(providers) {
  const available = providers.filter((provider) => provider && provider.enabled !== false && provider.id);
  const selected = providerSelect.value || 'local-model';
  providerProfiles = new Map(available.map((provider) => [String(provider.id), provider]));
  providerSelect.replaceChildren();
  for (const provider of available) {
    const option = element('option', '', provider.label || provider.id);
    option.value = provider.id;
    providerSelect.append(option);
  }
  if (providerProfiles.has(selected)) providerSelect.value = selected;
  else if (providerProfiles.has('local-model')) providerSelect.value = 'local-model';
  else providerSelect.value = available[0]?.id || '';
}

function updateModelLabel() {
  const profile = providerProfiles.get(providerSelect.value);
  const available = Boolean(profile?.online && profile?.models?.length);
  document.querySelector('#model-label').textContent = modelSelect.value || modelName || (available ? 'No model selected' : `${profile?.label || 'Provider'} offline`);
}

function updateTaskMessage(taskItem) {
  const message = taskMessages.get(taskItem?.id);
  if (!message) return;
  const status = String(taskItem.status || '').toLowerCase();
  const reply = message.querySelector('p');
  if (!reply) return;
  if (status === 'completed') {
    reply.textContent = taskItem.result || 'Task completed.';
    notifyTaskCompletion(taskItem);
    taskMessages.delete(taskItem.id);
    if (taskItem.botId && botSelect.value === taskItem.botId) void loadBotConversation(taskItem.botId).catch(() => {});
  } else if (status === 'failed') {
    reply.textContent = taskItem.error || 'Task failed.';
    message.classList.add('error');
    notifyTaskCompletion(taskItem);
    taskMessages.delete(taskItem.id);
    if (taskItem.botId && botSelect.value === taskItem.botId) void loadBotConversation(taskItem.botId).catch(() => {});
  } else if (status === 'cancelled') {
    reply.textContent = 'Task cancelled.';
    notifyTaskCompletion(taskItem);
    taskMessages.delete(taskItem.id);
    if (taskItem.botId && botSelect.value === taskItem.botId) void loadBotConversation(taskItem.botId).catch(() => {});
  } else if (status === 'paused') {
    reply.textContent = 'Task paused. Resume it from Recent tasks when ready.';
  } else {
    reply.textContent = 'Working with the local model…';
  }
}

async function refreshTaskActivity() {
  if (taskActivityBusy) return;
  taskActivityBusy = true;
  try {
    const visible = watchedTasks.slice(-8);
    await Promise.all(visible.map(async (taskItem) => {
      const offset = taskEventOffsets.get(taskItem.id) || 0;
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskItem.id)}/events?after=${offset}`);
      const data = await response.json();
      if (!response.ok) return;
      updateTaskMessage(data.task || taskItem);
      if (Array.isArray(data.events) && data.events.length) {
        taskEventOffsets.set(taskItem.id, Number(data.nextSeq) || offset);
        const node = taskActivityNodes.get(taskItem.id);
        if (node) node.textContent = `Activity: ${describeTaskEvent(data.events[data.events.length - 1])}`;
      }
    }));
  } catch {
    // The next scheduled refresh will retry without interrupting the dashboard.
  } finally {
    taskActivityBusy = false;
  }
}

function closeTaskEventStream(taskId) {
  const stream = taskEventStreams.get(taskId);
  if (!stream) return;
  stream.close();
  taskEventStreams.delete(taskId);
}

function finalTaskStatus(status) {
  return ['completed', 'failed', 'cancelled'].includes(String(status || '').toLowerCase());
}

function openTaskEventStream(taskItem) {
  if (typeof EventSource !== 'function' || taskEventStreams.has(taskItem.id)) return;
  const offset = taskEventOffsets.get(taskItem.id) || 0;
  const stream = new EventSource(`/api/tasks/${encodeURIComponent(taskItem.id)}/events/stream?after=${offset}`);
  taskEventStreams.set(taskItem.id, stream);
  stream.addEventListener('task', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    const nextEvent = data.event;
    const nextOffset = Number(nextEvent?.seq);
    if (Number.isSafeInteger(nextOffset) && nextOffset > (taskEventOffsets.get(taskItem.id) || 0)) taskEventOffsets.set(taskItem.id, nextOffset);
    const node = taskActivityNodes.get(taskItem.id);
    if (node && nextEvent) node.textContent = `Activity: ${describeTaskEvent(nextEvent)}`;
    const current = data.task || taskItem;
    updateTaskMessage(current);
    if (finalTaskStatus(current.status)) {
      closeTaskEventStream(taskItem.id);
      void load();
    }
  });
  stream.addEventListener('stream.end', () => {
    closeTaskEventStream(taskItem.id);
    taskStreamFallback = true;
    void refreshTaskActivity();
  });
  stream.onerror = () => {
    closeTaskEventStream(taskItem.id);
    taskStreamFallback = true;
    void refreshTaskActivity();
  };
}

function watchTaskActivity(tasks) {
  watchedTasks = tasks;
  if (taskActivityTimer) {
    clearInterval(taskActivityTimer);
    taskActivityTimer = null;
  }
  const active = tasks.filter((item) => ['pending', 'running', 'waiting_approval', 'paused'].includes(String(item.status || '').toLowerCase()));
  const activeIds = new Set(active.map((item) => item.id));
  for (const taskId of taskEventStreams.keys()) if (!activeIds.has(taskId)) closeTaskEventStream(taskId);
  if (!taskStreamFallback && typeof EventSource === 'function') for (const taskItem of active) openTaskEventStream(taskItem);
  void refreshTaskActivity();
  if (taskStreamFallback || typeof EventSource !== 'function') {
    taskActivityTimer = setInterval(() => { void refreshTaskActivity(); }, 1500);
  }
}

function editField(labelText, value, { multiline = false, required = false } = {}) {
  const label = element('label', 'edit-field');
  label.append(element('span', '', labelText));
  const control = element(multiline ? 'textarea' : 'input');
  control.value = value || '';
  control.required = required;
  label.append(control);
  return control;
}

function renderEditor(card, fields, saveEdit, cancelEdit) {
  const editor = element('form', 'edit-form');
  const controls = fields.map((field) => editField(field.label, field.value, field));
  const actions = element('div', 'routine-controls');
  const cancel = element('button', 'text', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', cancelEdit);
  const save = element('button', 'text', 'Save');
  save.type = 'submit';
  actions.append(cancel, save);
  editor.append(...controls, actions);
  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const values = Object.fromEntries(fields.map((field, index) => [field.key, controls[index].value.trim()]));
      await saveEdit(values);
    } catch (error) {
      addMessage('error', 'OpenBot', error.message || 'The change could not be saved.');
      save.disabled = false;
    }
  });
  card.replaceChildren(editor);
}

async function patchRecord(url, payload) {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The change could not be saved.');
  return data;
}

function editMemory(memory, card) {
  renderEditor(card, [
    { key: 'key', label: 'Key', value: memory.key, required: true },
    { key: 'value', label: 'Value', value: memory.value, required: true }
  ], async (values) => {
    await patchRecord(`/api/memories/${encodeURIComponent(memory.id)}`, values);
    await loadMemories(workspace.value.trim());
  }, () => loadMemories(workspace.value.trim()).catch(() => {}));
}

function editSkill(skill, card) {
  renderEditor(card, [
    { key: 'name', label: 'Name', value: skill.name, required: true },
    { key: 'description', label: 'Description', value: skill.description },
    { key: 'instructions', label: 'Instructions', value: skill.instructions, multiline: true, required: true }
  ], async (values) => {
    await patchRecord(`/api/skills/${encodeURIComponent(skill.id)}`, values);
    await loadSkills();
  }, () => loadSkills().catch(() => {}));
}

function editBot(bot, card) {
  renderEditor(card, [
    { key: 'name', label: 'Name', value: bot.name, required: true },
    { key: 'role', label: 'Role', value: bot.role },
    { key: 'instructions', label: 'Instructions', value: bot.instructions, multiline: true, required: true }
  ], async (values) => {
    await patchRecord(`/api/bots/${encodeURIComponent(bot.id)}`, values);
    await load();
  }, () => load().catch(() => {}));
}

function renderMemories(memories) {
  const container = document.querySelector('#memories');
  container.replaceChildren();
  for (const memory of memories) {
    const card = element('div', 'health memory-card');
    const details = element('div');
    details.append(element('b', '', memory.key), element('small', '', memory.value));
    const edit = element('button', 'text', 'Edit');
    edit.addEventListener('click', () => editMemory(memory, card));
    const remove = element('button', 'text', 'Delete');
    remove.addEventListener('click', async () => {
      await fetch(`/api/memories/${encodeURIComponent(memory.id)}`, { method: 'DELETE' });
      await loadMemories(workspace.value.trim());
    });
    card.append(details, edit, remove);
    container.append(card);
  }
}

async function loadMemories(root) {
  const container = document.querySelector('#memories');
  if (!root) {
    container.replaceChildren(element('small', '', 'Enter a workspace to view its local memory.'));
    return;
  }
  const response = await fetch(`/api/memories?workspace=${encodeURIComponent(root)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Memory could not be loaded.');
  renderMemories(Array.isArray(data.memories) ? data.memories : []);
}

function renderSkills(skills) {
  const container = document.querySelector('#skills');
  const selected = skillSelect.value;
  skillSelect.replaceChildren(element('option', '', 'No local skill'));
  container.replaceChildren();
  for (const skill of skills) {
    const option = element('option', '', skill.name);
    option.value = skill.id;
    skillSelect.append(option);
    const card = element('div', 'health memory-card');
    const details = element('div');
    details.append(element('b', '', skill.name), element('small', '', skill.description || 'Reusable local instructions'));
    const edit = element('button', 'text', 'Edit');
    edit.addEventListener('click', () => editSkill(skill, card));
    const remove = element('button', 'text', 'Delete');
    remove.addEventListener('click', async () => {
      await fetch(`/api/skills/${encodeURIComponent(skill.id)}`, { method: 'DELETE' });
      await loadSkills();
    });
    card.append(details, edit, remove);
    container.append(card);
  }
  if ([...skillSelect.options].some((option) => option.value === selected)) skillSelect.value = selected;
}

function renderBots(bots) {
  const container = document.querySelector('#bots');
  const selected = botSelect.value;
  botProfiles = new Map(bots.map((bot) => [bot.id, bot]));
  botSelect.replaceChildren(element('option', '', 'Use the general local agent'));
  container.replaceChildren();
  for (const bot of bots) {
    const option = element('option', '', bot.name);
    option.value = bot.id;
    botSelect.append(option);
    const card = element('div', 'health memory-card');
    const details = element('div');
    details.append(element('b', '', bot.name), element('small', '', `${bot.role || 'Local bot'} · ${bot.messageCount || 0} messages`));
    const edit = element('button', 'text', 'Edit');
    edit.addEventListener('click', () => editBot(bot, card));
    const remove = element('button', 'text', 'Delete');
    remove.addEventListener('click', async () => {
      await fetch(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'DELETE' });
      await load();
    });
    card.append(details, edit, remove);
    container.append(card);
  }
  if ([...botSelect.options].some((option) => option.value === selected)) botSelect.value = selected;
}

function renderRoutines(routines) {
  const container = document.querySelector('#routines');
  container.replaceChildren();
  for (const routine of routines) {
    const card = element('div', 'routine');
    const details = element('div');
    details.append(
      element('b', '', routine.title || 'Routine'),
      element('p', '', `${routine.schedule || ''} · ${routine.enabled ? 'enabled' : 'paused'}`),
      element('small', '', routine.lastStatus ? `Last run: ${routine.lastStatus}` : `Next run: ${routine.nextRunAt || 'not scheduled'}`)
    );
    const controls = element('div', 'routine-controls');
    const toggle = element('button', `toggle ${routine.enabled ? 'on' : ''}`, routine.enabled ? 'Pause' : 'Enable');
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      await fetch(`/api/routines/${encodeURIComponent(routine.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !routine.enabled })
      });
      await load();
    });
    const run = element('button', 'text', 'Run now');
    run.addEventListener('click', async () => {
      run.disabled = true;
      const response = await fetch(`/api/routines/${encodeURIComponent(routine.id)}/run`, { method: 'POST' });
      const data = await response.json();
      addMessage(response.ok ? 'bot' : 'error', 'OpenBot', data.result?.reply || data.result?.error || data.error || data.result?.status || 'Routine finished.');
      await load();
    });
    controls.append(toggle, run);
    card.append(details, controls);
    container.append(card);
  }
}

function editConnector(connector, card) {
  renderEditor(card, [
    { key: 'name', label: 'Name', value: connector.name, required: true },
    { key: 'description', label: 'Description', value: connector.description },
    { key: 'baseUrl', label: 'Base URL', value: connector.baseUrl, required: true },
    { key: 'allowedPaths', label: 'Allowed paths', value: connector.allowedPaths.join(', '), required: true }
  ], async (values) => {
    values.allowedPaths = values.allowedPaths.split(',').map((path) => path.trim()).filter(Boolean);
    await patchRecord(`/api/connectors/${encodeURIComponent(connector.id)}`, values);
    await loadConnectors();
  }, () => loadConnectors().catch(() => {}));
}

function renderConnectors(connectors) {
  const container = document.querySelector('#connectors');
  container.replaceChildren();
  for (const connector of connectors) {
    const card = element('div', 'health memory-card');
    const details = element('div');
    details.append(
      element('b', '', connector.name),
      element('small', '', `${connector.baseUrl} · ${connector.allowedPaths.join(', ')} · ${connector.enabled ? 'enabled' : 'paused'} · tool: connector.fetch`)
    );
    const edit = element('button', 'text', 'Edit');
    edit.addEventListener('click', () => editConnector(connector, card));
    const toggle = element('button', 'text', connector.enabled ? 'Pause' : 'Enable');
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        await patchRecord(`/api/connectors/${encodeURIComponent(connector.id)}`, { enabled: !connector.enabled });
        await loadConnectors();
      } catch (error) {
        addMessage('error', 'OpenBot', error.message || 'Connector could not be updated.');
        toggle.disabled = false;
      }
    });
    const remove = element('button', 'text', 'Delete');
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        const response = await fetch(`/api/connectors/${encodeURIComponent(connector.id)}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Connector could not be deleted.');
        await loadConnectors();
      } catch (error) {
        addMessage('error', 'OpenBot', error.message || 'Connector could not be deleted.');
        remove.disabled = false;
      }
    });
    card.append(details, edit, toggle, remove);
    container.append(card);
  }
}

async function loadConnectors() {
  const response = await fetch('/api/connectors');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Connectors could not be loaded.');
  renderConnectors(Array.isArray(data.connectors) ? data.connectors : []);
}

async function loadSkills() {
  const response = await fetch('/api/skills');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Skills could not be loaded.');
  renderSkills(Array.isArray(data.skills) ? data.skills : []);
}

async function load() {
  const [health, state, taskResponse] = await Promise.all([
    fetch('/api/health').then((response) => response.json()),
    fetch('/api/state').then((response) => response.json()),
    fetch('/api/tasks').then((response) => response.json())
  ]);
  const dot = document.querySelector('#health-dot');
  const providers = Array.isArray(health.providers) ? health.providers : [{ id: 'local-model', label: 'Local model', enabled: true, online: health.online, models: health.models || [] }];
  renderProviders(providers);
  const activeProvider = providerProfiles.get(providerSelect.value);
  const models = Array.isArray(activeProvider?.models) ? activeProvider.models.map((model) => String(model)).filter(Boolean) : [];
  modelName = models[0] || '';
  renderModels(models);
  document.querySelector('#local-model').textContent = health.online ? 'Local model online' : 'Local model offline';
  document.querySelector('#model-count').textContent = health.online
    ? `${health.models.length} model${health.models.length === 1 ? '' : 's'} available`
    : 'Start the local model service to activate local intelligence';
  updateModelLabel();
  dot.style.background = health.online ? 'var(--green)' : '#e78290';
  renderState(state, taskResponse);
  await Promise.all([loadMemories(workspace.value.trim()), loadSkills(), loadConnectors()]);
}

function renderState(state, taskResponse = {}) {
  const tasks = Array.isArray(taskResponse.tasks) ? taskResponse.tasks : [];
  watchedTasks = tasks;
  const recent = document.querySelector('#recent-tasks');
  recent.replaceChildren();
  taskActivityNodes = new Map();
  document.querySelector('#task-count').textContent = String(tasks.length);
  for (const taskItem of tasks.slice(-8).reverse()) {
    updateTaskMessage(taskItem);
    const card = element('div', 'health recent-task');
    const details = element('div');
    const activity = element('small', '', 'Activity: checking…');
    details.append(element('b', '', taskItem.prompt || 'Untitled task'), element('small', '', taskItem.status || 'unknown'), activity);
    taskActivityNodes.set(taskItem.id, activity);
    const taskStatus = String(taskItem.status || '').toLowerCase();
    const resultText = taskItem.result ?? taskItem.error ?? (taskStatus === 'cancelled' ? 'Task cancelled.' : null);
    if (resultText != null) {
      const preview = element('details', 'task-result');
      preview.append(element('summary', '', 'Result preview'));
      preview.append(element('p', '', String(resultText)));
      const resultLink = element('a', '', 'Open structured result ↗');
      resultLink.href = `/api/tasks/${encodeURIComponent(taskItem.id)}/result`;
      resultLink.target = '_blank';
      resultLink.rel = 'noopener';
      preview.append(resultLink);
      card.append(preview);
    }
    const artifacts = element('a', '', 'Artifacts ↗');
    artifacts.href = `/api/tasks/${encodeURIComponent(taskItem.id)}/artifacts`;
    artifacts.target = '_blank';
    artifacts.rel = 'noopener';
    const audit = element('a', '', 'Audit');
    audit.href = `/api/tasks/${encodeURIComponent(taskItem.id)}/audit`;
    audit.target = '_blank';
    audit.rel = 'noopener';
    const download = element('a', '', 'Download audit');
    download.href = `/api/tasks/${encodeURIComponent(taskItem.id)}/export`;
    download.download = 'openbot-task-audit.json';
    download.rel = 'noopener';
    card.append(details, artifacts, audit, download);
    if (['pending', 'running', 'paused'].includes(taskStatus)) {
      const resume = element('button', 'text', 'Resume');
      resume.addEventListener('click', () => resumeTask(taskItem, resume));
      card.append(resume);
    }
    if (['pending', 'running', 'waiting_approval'].includes(taskStatus)) {
      const pause = element('button', 'text', 'Pause');
      pause.addEventListener('click', () => controlTask(taskItem, 'pause', pause));
      card.append(pause);
    }
    if (['pending', 'running', 'paused', 'waiting_approval'].includes(taskStatus)) {
      const cancel = element('button', 'text', 'Cancel task');
      cancel.addEventListener('click', () => controlTask(taskItem, 'cancel', cancel));
      card.append(cancel);
    }
    recent.append(card);
  }
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
      approve.addEventListener('click', () => decide(approval, 'approved'));
      reject.addEventListener('click', () => decide(approval, 'rejected'));
      controls.append(approve, reject);
    } else controls.append(element('small', '', approval.status || 'closed'));
    card.append(controls);
    approvals.append(card);
  }
  renderBots(Array.isArray(state.bots) ? state.bots : []);
  renderRoutines(Array.isArray(state.routines) ? state.routines : []);
  watchTaskActivity(tasks);
}

async function resumeTask(taskItem, button) {
  button.disabled = true;
  const taskProvider = taskItem.provider || providerSelect.value || 'local-model';
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskItem.id)}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: taskProvider, model: providerSelect.value === taskProvider ? (modelSelect.value || modelName || undefined) : undefined })
  });
  const data = await response.json();
  addMessage(response.ok ? 'bot' : 'error', 'OpenBot', data.reply || data.error || data.status || 'Task recovery finished.');
  await load();
}

async function controlTask(taskItem, action, button) {
  button.disabled = true;
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskItem.id)}/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Task could not be ${action}ed.`);
    addMessage('bot', 'OpenBot', action === 'pause' ? 'Task paused.' : 'Task cancelled.');
    await load();
  } catch (error) {
    addMessage('error', 'OpenBot', error.message || 'Task control failed.');
    button.disabled = false;
  }
}

async function decide(approval, decision) {
  const response = await fetch('/api/approval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: approval.id, decision })
  });
  if (response.ok && decision === 'approved' && approval.taskId) {
    const taskProvider = watchedTasks.find((item) => item.id === approval.taskId)?.provider || providerSelect.value || 'local-model';
    await fetch(`/api/tasks/${encodeURIComponent(approval.taskId)}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalId: approval.id, provider: taskProvider, model: providerSelect.value === taskProvider ? (modelSelect.value || modelName || undefined) : undefined })
    });
  }
  await load();
}

async function startTask(message, pending, root) {
  const selectedSkill = skillSelect.value || undefined;
  const selectedBot = botSelect.value || undefined;
  const selectedProvider = providerSelect.value || 'local-model';
  const createResponse = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: message, kind: 'plan', workspace: root, owner: 'dashboard', provider: selectedProvider, skill: selectedSkill, botId: selectedBot })
  });
  const created = await createResponse.json();
  if (!createResponse.ok || !created.task?.id) throw new Error(created.error || 'Task could not be created.');
  const taskId = created.task.id;
  taskMessages.set(taskId, pending);
  renderAuditLink(pending, taskId);
  const runResponse = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: providerSelect.value || selectedProvider, model: modelSelect.value || undefined, skill: selectedSkill, botId: selectedBot, background: true })
  });
  const started = await runResponse.json();
  if (!runResponse.ok || started.taskId !== taskId || started.status !== 'started') throw new Error(started.error || 'Task could not be started.');
  pending.querySelector('p').textContent = 'Task started. Watching local activity…';
  await load();
  await refreshTaskActivity();
}

memoryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const root = workspace.value.trim();
  const key = document.querySelector('#memory-key').value.trim();
  const value = document.querySelector('#memory-value').value.trim();
  if (!root || !key || !value) {
    addMessage('error', 'OpenBot', 'Enter a workspace, memory key, and value first.');
    return;
  }
  const response = await fetch('/api/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: root, key, value })
  });
  const data = await response.json();
  if (!response.ok) {
    addMessage('error', 'OpenBot', data.error || 'Memory could not be saved.');
    return;
  }
  document.querySelector('#memory-key').value = '';
  document.querySelector('#memory-value').value = '';
  await loadMemories(root);
});

skillForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.querySelector('#skill-name').value.trim();
  const description = document.querySelector('#skill-description').value.trim();
  const instructions = document.querySelector('#skill-instructions').value.trim();
  if (!name || !instructions) {
    addMessage('error', 'OpenBot', 'Enter a skill name and reusable instructions first.');
    return;
  }
  const response = await fetch('/api/skills', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, description, instructions })
  });
  const data = await response.json();
  if (!response.ok) {
    addMessage('error', 'OpenBot', data.error || 'Skill could not be saved.');
    return;
  }
  document.querySelector('#skill-name').value = '';
  document.querySelector('#skill-description').value = '';
  document.querySelector('#skill-instructions').value = '';
  await loadSkills();
  skillSelect.value = data.skill.id;
});

botSelect.addEventListener('change', () => {
  const selected = botProfiles.get(botSelect.value);
  if (selected?.workspace && !workspace.value.trim()) workspace.value = selected.workspace;
  void loadBotConversation(botSelect.value).catch((error) => addMessage('error', 'OpenBot', error.message || 'Bot conversation could not be loaded.'));
});
document.querySelector('#conversation-search-button')?.addEventListener('click', () => {
  void loadBotConversation(botSelect.value, conversationSearch.value.trim()).catch((error) => addMessage('error', 'OpenBot', error.message || 'Conversation search failed.'));
});
document.querySelector('#conversation-search-clear')?.addEventListener('click', () => {
  conversationSearch.value = '';
  void loadBotConversation(botSelect.value, '').catch(() => {});
});
conversationSearch.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  document.querySelector('#conversation-search-button')?.click();
});

modelSelect.addEventListener('change', updateModelLabel);

providerSelect.addEventListener('change', () => {
  const profile = providerProfiles.get(providerSelect.value);
  modelName = Array.isArray(profile?.models) ? String(profile.models[0] || '') : '';
  renderModels(Array.isArray(profile?.models) ? profile.models : []);
  updateModelLabel();
});

notificationButton.addEventListener('click', enableNotifications);
syncNotificationControl();
settingsButton.addEventListener('click', showSettings);

botForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const root = workspace.value.trim();
  const name = document.querySelector('#bot-name').value.trim();
  const role = document.querySelector('#bot-role').value.trim();
  const instructions = document.querySelector('#bot-instructions').value.trim();
  if (!root || !name || !instructions) {
    addMessage('error', 'OpenBot', 'Enter a workspace, bot name, and bot instructions first.');
    return;
  }
  const response = await fetch('/api/bots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, role, instructions, workspace: root, skill: skillSelect.value || undefined })
  });
  const data = await response.json();
  if (!response.ok) {
    addMessage('error', 'OpenBot', data.error || 'Bot could not be saved.');
    return;
  }
  document.querySelector('#bot-name').value = '';
  document.querySelector('#bot-role').value = '';
  document.querySelector('#bot-instructions').value = '';
  await load();
  botSelect.value = data.bot.id;
  await loadBotConversation(data.bot.id);
});

routineForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const root = workspace.value.trim();
  const title = document.querySelector('#routine-title').value.trim();
  const schedule = document.querySelector('#routine-schedule').value.trim();
  const prompt = document.querySelector('#routine-prompt').value.trim();
  if (!root || !title || !schedule || !prompt) {
    addMessage('error', 'OpenBot', 'Enter a workspace, routine name, schedule, and prompt first.');
    return;
  }
  const response = await fetch('/api/routines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, schedule, prompt, workspace: root, skill: skillSelect.value || undefined, botId: botSelect.value || undefined })
  });
  const data = await response.json();
  if (!response.ok) {
    addMessage('error', 'OpenBot', data.error || 'Routine could not be saved.');
    return;
  }
  document.querySelector('#routine-title').value = '';
  document.querySelector('#routine-schedule').value = '';
  document.querySelector('#routine-prompt').value = '';
  await load();
});

connectorForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.querySelector('#connector-name').value.trim();
  const description = document.querySelector('#connector-description').value.trim();
  const baseUrl = document.querySelector('#connector-base-url').value.trim();
  const allowedPaths = document.querySelector('#connector-paths').value.trim();
  if (!name || !baseUrl || !allowedPaths) {
    addMessage('error', 'OpenBot', 'Enter a connector name, base URL, and at least one allowed path.');
    return;
  }
  const response = await fetch('/api/connectors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, description, baseUrl, allowedPaths })
  });
  const data = await response.json();
  if (!response.ok) {
    addMessage('error', 'OpenBot', data.error || 'Connector could not be saved.');
    return;
  }
  document.querySelector('#connector-name').value = '';
  document.querySelector('#connector-description').value = '';
  document.querySelector('#connector-base-url').value = '';
  document.querySelector('#connector-paths').value = '';
  await loadConnectors();
});

workspace.addEventListener('change', () => loadMemories(workspace.value.trim()).catch(() => {}));

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
    await startTask(message, pending, root);
  } catch {
    pending.classList.add('error');
    pending.querySelector('p').textContent = 'OpenBot could not reach the local service.';
  }
});

load().catch(() => addMessage('error', 'OpenBot', 'The local dashboard loaded, but service health could not be checked.'));
