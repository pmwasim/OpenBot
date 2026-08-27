const SENSITIVE_KEY = /^(api[_-]?key|authorization|token|secret|password|credential|access[_-]?token)$/i;

function publicEndpoint(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch { return '[invalid-url]'; }
}

export function redactSecrets(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    return value
      .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs]-)[A-Za-z0-9_-]+/gi, '[redacted]')
      .replace(/\b(?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.split(/[:=]/)[0]}=[redacted]`);
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [nextKey, nextValue] of Object.entries(value)) out[nextKey] = redactSecrets(nextValue, nextKey);
    return out;
  }
  return value;
}

export function createLocalModelAdapter({ baseUrl = 'http://127.0.0.1:11434', timeoutMs = 120000, protocol = 'native' } = {}) {
  const url = String(baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const adapterProtocol = String(protocol || 'native').trim().toLowerCase();
  if (!['native', 'chat-completions'].includes(adapterProtocol)) throw new Error('OPENBOT_MODEL_PROTOCOL must be "native" or "chat-completions".');
  async function request(path, options = {}, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      return await fetch(`${url}${path}`, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async function responseData(response) {
    try { return await response.json(); }
    catch { return {}; }
  }
  function replyFrom(data) {
    if (adapterProtocol === 'native') return data.message?.content || '';
    const content = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    return Array.isArray(content) ? content.map((part) => part?.text || '').join('') : String(content || '');
  }
  return {
    id: 'local-model',
    local: true,
    enabled: true,
    baseUrl: url,
    protocol: adapterProtocol,
    async tags() {
      const response = await request(adapterProtocol === 'native' ? '/api/tags' : '/v1/models');
      const data = await responseData(response);
      const models = adapterProtocol === 'native'
        ? (data.models || []).map((model) => model.name)
        : (data.data || []).map((model) => model.id || model.name);
      return { ok: response.ok, models: models.filter(Boolean) };
    },
    async chat({ model, messages, stream = false, signal }) {
      const response = await request(adapterProtocol === 'native' ? '/api/chat' : '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream, messages })
      }, signal);
      const data = await responseData(response);
      return {
        ok: response.ok,
        status: response.status,
        model,
        reply: replyFrom(data),
        error: data.error
      };
    },
    async chatStructured({ model, messages, tools = [], signal }) {
      const response = await request(adapterProtocol === 'native' ? '/api/chat' : '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          ...(adapterProtocol === 'native' ? { format: 'json' } : { response_format: { type: 'json_object' } }),
          messages: [
            ...messages,
            { role: 'system', content: `Enabled tools: ${tools.map((tool) => tool.name || tool).join(', ')}` }
          ]
        })
      }, signal);
      const data = await responseData(response);
      return {
        ok: response.ok,
        status: response.status,
        model,
        reply: replyFrom(data),
        error: data.error
      };
    }
  };
}

export function createRemoteCompatibleAdapter({ baseUrl = '', apiKey = '', timeoutMs = 10000 } = {}) {
  const url = String(baseUrl || '').replace(/\/$/, '');
  const enabled = Boolean(url);
  async function request(path, options = {}, signal) {
    if (!enabled) {
      const error = new Error('Remote-compatible provider is disabled. Set OPENBOT_REMOTE_BASE_URL to enable it.');
      error.statusCode = 501;
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const headers = { ...(options.headers || {}) };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    try {
      return await fetch(`${url}${path}`, { ...options, headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async function responseData(response) {
    try { return await response.json(); }
    catch { return {}; }
  }
  function replyFrom(data) {
    const content = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    return Array.isArray(content) ? content.map((part) => part?.text || '').join('') : String(content || '');
  }
  return {
    id: 'remote-compatible',
    local: false,
    enabled,
    baseUrl: url || null,
    protocol: 'chat-completions',
    async tags() {
      const response = await request('/v1/models');
      const data = await responseData(response);
      return { ok: response.ok, models: (data.data || []).map((model) => model.id || model.name).filter(Boolean) };
    },
    async chat({ model, messages, stream = false, signal }) {
      const response = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream, messages })
      }, signal);
      const data = await responseData(response);
      return { ok: response.ok, status: response.status, model, reply: replyFrom(data), error: data.error };
    },
    async chatStructured({ model, messages, tools = [], signal }) {
      const response = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          response_format: { type: 'json_object' },
          messages: [
            ...messages,
            { role: 'system', content: `Enabled tools: ${tools.map((tool) => tool.name || tool).join(', ')}` }
          ]
        })
      }, signal);
      const data = await responseData(response);
      return { ok: response.ok, status: response.status, model, reply: replyFrom(data), error: data.error };
    }
  };
}

export function createProviderHub(env = process.env, options = {}) {
  const localOnly = env.OPENBOT_LOCAL_ONLY !== '0';
  const modelUrl = options.modelUrl || env.OPENBOT_MODEL_URL || 'http://127.0.0.1:11434';
  const modelProtocol = options.modelProtocol || env.OPENBOT_MODEL_PROTOCOL || 'native';
  let modelHost;
  try { modelHost = new URL(modelUrl).hostname; }
  catch { throw new Error('OPENBOT_MODEL_URL must be a valid http(s) URL.'); }
  if (localOnly && !['127.0.0.1', 'localhost', '::1'].includes(modelHost)) {
    const error = new Error('Local-only mode requires the model runtime on loopback. Set OPENBOT_LOCAL_ONLY=0 to opt into a remote endpoint.');
    error.statusCode = 400;
    throw error;
  }
  const remoteBaseUrl = options.remoteBaseUrl || env.OPENBOT_REMOTE_BASE_URL || '';
  if (remoteBaseUrl) {
    let remoteUrl;
    try { remoteUrl = new URL(remoteBaseUrl); }
    catch { throw new Error('OPENBOT_REMOTE_BASE_URL must be a valid http(s) URL.'); }
    if (!['http:', 'https:'].includes(remoteUrl.protocol)) throw new Error('OPENBOT_REMOTE_BASE_URL must use http or https.');
  }
  const localModel = createLocalModelAdapter({
    baseUrl: modelUrl,
    protocol: modelProtocol
  });
  const remote = createRemoteCompatibleAdapter({
    baseUrl: remoteBaseUrl,
    apiKey: env.OPENBOT_REMOTE_API_KEY || '',
    timeoutMs: Number(env.OPENBOT_REMOTE_TIMEOUT_MS) > 0 ? Number(env.OPENBOT_REMOTE_TIMEOUT_MS) : 10000
  });

  function get(name) {
    if (name === 'local-model') return localModel;
    if (localOnly && name !== 'local-model') {
      const error = new Error('Local-only mode is on; external providers are disabled.');
      error.statusCode = 403;
      throw error;
    }
    if (name === 'remote-compatible') return remote;
    throw new Error(`Unknown provider: ${name}`);
  }

  return {
    localOnly,
    localModel,
    remoteCompatible: localOnly ? { ...remote, enabled: false } : remote,
    get,
    describe() {
      return redactSecrets({
        localOnly,
        localModel: { id: localModel.id, local: true, enabled: true, baseUrl: publicEndpoint(localModel.baseUrl), protocol: localModel.protocol },
        remoteCompatible: {
          id: remote.id,
          local: false,
          enabled: localOnly ? false : remote.enabled,
          baseUrl: localOnly ? null : publicEndpoint(remote.baseUrl),
          protocol: remote.protocol,
          apiKey: env.OPENBOT_REMOTE_API_KEY || ''
        }
      });
    }
  };
}

export function listProviders(env = process.env) {
  return createProviderHub(env).describe();
}
