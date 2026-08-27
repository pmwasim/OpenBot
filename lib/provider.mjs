const SENSITIVE_KEY = /^(api[_-]?key|authorization|token|secret|password|credential|access[_-]?token)$/i;

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

export function createOllamaAdapter({ baseUrl = 'http://127.0.0.1:11434', timeoutMs = 120000 } = {}) {
  const url = String(baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  async function request(path, options = {}) {
    return fetch(`${url}${path}`, { signal: AbortSignal.timeout(timeoutMs), ...options });
  }
  return {
    id: 'ollama',
    local: true,
    enabled: true,
    baseUrl: url,
    async tags() {
      const response = await request('/api/tags');
      const data = await response.json();
      return { ok: response.ok, models: (data.models || []).map((model) => model.name).filter(Boolean) };
    },
    async chat({ model, messages, stream = false }) {
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream, messages })
      });
      const data = await response.json();
      return {
        ok: response.ok,
        status: response.status,
        model,
        reply: data.message?.content || '',
        error: data.error
      };
    },
    async chatStructured({ model, messages, tools = [] }) {
      const response = await request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          messages: [
            ...messages,
            { role: 'system', content: `Enabled tools: ${tools.map((tool) => tool.name || tool).join(', ')}` }
          ]
        })
      });
      const data = await response.json();
      return {
        ok: response.ok,
        status: response.status,
        model,
        reply: data.message?.content || '',
        error: data.error
      };
    }
  };
}

export function createOpenAICompatibleAdapter({ baseUrl = '', apiKey = '' } = {}) {
  const enabled = Boolean(baseUrl);
  return {
    id: 'openai-compatible',
    local: false,
    enabled,
    baseUrl: baseUrl || null,
    async chat() {
      if (!enabled) {
        const error = new Error('OpenAI-compatible provider is disabled. Set OPENBOT_OPENAI_BASE_URL to enable it.');
        error.statusCode = 501;
        throw error;
      }
      void apiKey;
      const error = new Error('OpenAI-compatible provider is a Phase 0 stub and is not implemented.');
      error.statusCode = 501;
      throw error;
    }
  };
}

export function createProviderHub(env = process.env, options = {}) {
  const localOnly = env.OPENBOT_LOCAL_ONLY !== '0';
  const ollama = createOllamaAdapter({
    baseUrl: options.ollamaUrl || env.OPENBOT_OLLAMA_URL || 'http://127.0.0.1:11434'
  });
  const openai = createOpenAICompatibleAdapter({
    baseUrl: options.openaiBaseUrl || env.OPENBOT_OPENAI_BASE_URL || '',
    apiKey: env.OPENBOT_OPENAI_API_KEY || ''
  });

  function get(name) {
    if (name === 'ollama') return ollama;
    if (localOnly && name !== 'ollama') {
      const error = new Error('Local-only mode is on; external providers are disabled.');
      error.statusCode = 403;
      throw error;
    }
    if (name === 'openai-compatible') return openai;
    throw new Error(`Unknown provider: ${name}`);
  }

  return {
    localOnly,
    ollama,
    openai: localOnly ? { ...openai, enabled: false } : openai,
    get,
    describe() {
      return redactSecrets({
        localOnly,
        ollama: { id: ollama.id, local: true, enabled: true, baseUrl: ollama.baseUrl },
        openaiCompatible: {
          id: openai.id,
          local: false,
          enabled: localOnly ? false : openai.enabled,
          apiKey: env.OPENBOT_OPENAI_API_KEY || ''
        }
      });
    }
  };
}

export function listProviders(env = process.env) {
  return createProviderHub(env).describe();
}
