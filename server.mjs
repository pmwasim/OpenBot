import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { assertBindHost } from './lib/loopback.mjs';
import { createProviderHub } from './lib/provider.mjs';
import { openStore } from './lib/store.mjs';

const config = loadConfig();
const maxBodyBytes = 64 * 1024;
const publicDir = join(config.root, 'public');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png'
};

let bind;
try {
  bind = assertBindHost(config.host, process.env);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (bind.overridden) {
  console.warn(`WARNING: HOST=${config.host} is not loopback. OpenBot preview has no authentication. OPENBOT_ALLOW_NON_LOOPBACK=1 is set.`);
}

const store = await openStore({ dataDir: config.dataDir });
const providers = createProviderHub(process.env, { ollamaUrl: config.ollamaUrl });
const ollama = providers.ollama;

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

const app = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, await store.getState());
    if (url.pathname === '/api/health' && req.method === 'GET') {
      try {
        const tags = await ollama.tags();
        return json(res, 200, { online: tags.ok, models: tags.models || [] });
      } catch { return json(res, 200, { online: false, models: [] }); }
    }
    if (url.pathname === '/api/approval' && req.method === 'POST') {
      const { id, decision } = await body(req);
      const approval = await store.decideApproval(id, decision);
      return json(res, 200, { approval });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { message, model } = await body(req);
      if (typeof message !== 'string' || !message.trim()) return json(res, 400, { error: 'A task is required.' });
      let tags;
      try { tags = await ollama.tags(); }
      catch { return json(res, 503, { error: 'Ollama is not available. Start Ollama, then download a local model.' }); }
      if (!tags.ok) return json(res, 503, { error: 'Ollama is not available. Start Ollama, then download a local model.' });
      const installed = tags.models || [];
      const selected = model || installed[0];
      if (!selected) return json(res, 503, { error: 'Ollama has no local model yet.' });
      if (!installed.includes(selected)) return json(res, 400, { error: 'Requested model is not installed locally.' });
      const response = await ollama.chat({
        model: selected,
        stream: false,
        messages: [
          { role: 'system', content: 'You are OpenBot, a local-first assistant. Plan tasks carefully. Do not claim that you executed actions. When an action could send, publish, purchase, delete, or change a production system, explicitly ask for approval.' },
          { role: 'user', content: message }
        ]
      });
      if (!response.ok) return json(res, response.status, { error: response.error || 'Ollama could not complete the task.' });
      return json(res, 200, { model: selected, reply: response.reply || 'No response returned.' });
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

app.listen(config.port, config.host, () => console.log(`OpenBot is ready at http://${config.host}:${config.port}`));
