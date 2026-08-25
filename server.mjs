import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const port = Number(process.env.PORT || 4178);
const host = process.env.HOST || '127.0.0.1';
const maxBodyBytes = 64 * 1024;
const root = new URL('.', import.meta.url).pathname;
const publicDir = join(root, 'public');
const stateFile = join(root, 'data', 'state.json');

const seedState = {
  approvals: [{ id: 'approval-1', title: 'Send the weekly operations draft', detail: 'Creates a draft only. No external message is sent.', status: 'waiting' }],
  routines: [{ id: 'routine-1', title: 'Morning systems brief', schedule: 'Weekdays at 08:30', enabled: true }]
};

async function getState() {
  if (!existsSync(stateFile)) return seedState;
  return JSON.parse(await readFile(stateFile, 'utf8'));
}
async function saveState(state) {
  await mkdir(join(root, 'data'), { recursive: true });
  const temporary = `${stateFile}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2));
  const { rename } = await import('node:fs/promises');
  await rename(temporary, stateFile);
}
function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let text = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    text += chunk;
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }); }
}
async function ollama(path, options = {}) {
  // Local models may take longer to load or respond on consumer GPUs. Keep the
  // dashboard responsive while allowing a realistic first-token window.
  return fetch(`http://127.0.0.1:11434${path}`, { signal: AbortSignal.timeout(120000), ...options });
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const app = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, await getState());
    if (url.pathname === '/api/health' && req.method === 'GET') {
      try {
        const response = await ollama('/api/tags');
        const data = await response.json();
        return json(res, 200, { online: response.ok, models: (data.models || []).map((m) => m.name) });
      } catch { return json(res, 200, { online: false, models: [] }); }
    }
    if (url.pathname === '/api/approval' && req.method === 'POST') {
      const { id, decision } = await body(req);
      const state = await getState();
      const item = state.approvals.find((approval) => approval.id === id);
      if (!item || !['approved', 'rejected'].includes(decision)) return json(res, 400, { error: 'Invalid approval request' });
      item.status = decision;
      await saveState(state);
      return json(res, 200, { approval: item });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { message, model } = await body(req);
      if (typeof message !== 'string' || !message.trim()) return json(res, 400, { error: 'A task is required.' });
      const health = await ollama('/api/tags');
      if (!health.ok) return json(res, 503, { error: 'Ollama is not available. Start Ollama, then download a local model.' });
      const tags = await health.json();
      const installed = (tags.models || []).map((entry) => entry.name).filter(Boolean);
      const selected = model || installed[0];
      if (!selected) return json(res, 503, { error: 'Ollama has no local model yet.' });
      if (!installed.includes(selected)) return json(res, 400, { error: 'Requested model is not installed locally.' });
      const response = await ollama('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: selected, stream: false, messages: [
          { role: 'system', content: 'You are OpenBot, a local-first assistant. Plan tasks carefully. Do not claim that you executed actions. When an action could send, publish, purchase, delete, or change a production system, explicitly ask for approval.' },
          { role: 'user', content: message }
        ] })
      });
      const data = await response.json();
      if (!response.ok) return json(res, response.status, { error: data.error || 'Ollama could not complete the task.' });
      return json(res, 200, { model: selected, reply: data.message?.content || 'No response returned.' });
    }
    const file = url.pathname === '/' ? join(publicDir, 'index.html') : join(publicDir, url.pathname);
    if (!file.startsWith(publicDir) || !existsSync(file)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'content-type': mime[extname(file)] || 'application/octet-stream',
      'cache-control': extname(file) === '.html' ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff'
    });
    res.end(await readFile(file));
  } catch (error) { json(res, error.statusCode || 500, { error: error.message || 'OpenBot failed unexpectedly.' }); }
});
app.listen(port, host, () => console.log(`OpenBot is ready at http://${host}:${port}`));
