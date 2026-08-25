import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  return {
    root: ROOT,
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 4178),
    dataDir: env.OPENBOT_DATA_DIR || join(ROOT, 'data'),
    ollamaUrl: env.OPENBOT_OLLAMA_URL || 'http://127.0.0.1:11434',
    localOnly: env.OPENBOT_LOCAL_ONLY !== '0',
    allowNonLoopback: env.OPENBOT_ALLOW_NON_LOOPBACK === '1',
    openaiBaseUrl: env.OPENBOT_OPENAI_BASE_URL || '',
    openaiApiKeySet: Boolean(env.OPENBOT_OPENAI_API_KEY)
  };
}

export function publicConfig(config = loadConfig()) {
  return {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    ollamaUrl: config.ollamaUrl,
    localOnly: config.localOnly,
    allowNonLoopback: config.allowNonLoopback,
    openaiCompatible: config.openaiBaseUrl ? 'configured' : 'disabled',
    openaiApiKey: config.openaiApiKeySet ? 'set' : 'unset'
  };
}
