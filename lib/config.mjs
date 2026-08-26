import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const RESOURCE_PROFILES = Object.freeze({
  legacy: Object.freeze({ agentMaxTurns: 3, agentMaxActions: 3, agentContextChars: 6000, isolation: 'cwd' }),
  standard: Object.freeze({ agentMaxTurns: 6, agentMaxActions: 6, agentContextChars: 12000, isolation: 'auto' })
});

function resourceProfile(env) {
  return env.OPENBOT_RESOURCE_PROFILE === 'legacy' ? 'legacy' : 'standard';
}

export function loadConfig(env = process.env) {
  const profile = resourceProfile(env);
  const defaults = RESOURCE_PROFILES[profile];
  return {
    root: ROOT,
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 4178),
    dataDir: env.OPENBOT_DATA_DIR || join(ROOT, 'data'),
    ollamaUrl: env.OPENBOT_OLLAMA_URL || 'http://127.0.0.1:11434',
    localOnly: env.OPENBOT_LOCAL_ONLY !== '0',
    allowNonLoopback: env.OPENBOT_ALLOW_NON_LOOPBACK === '1',
    openaiBaseUrl: env.OPENBOT_OPENAI_BASE_URL || '',
    openaiApiKeySet: Boolean(env.OPENBOT_OPENAI_API_KEY),
    resourceProfile: profile,
    agentMaxTurns: Number(env.OPENBOT_AGENT_MAX_TURNS) > 0 ? Number(env.OPENBOT_AGENT_MAX_TURNS) : defaults.agentMaxTurns,
    agentMaxActions: Number(env.OPENBOT_AGENT_MAX_ACTIONS) > 0 ? Number(env.OPENBOT_AGENT_MAX_ACTIONS) : defaults.agentMaxActions,
    agentContextChars: Number(env.OPENBOT_AGENT_CONTEXT_CHARS) > 0 ? Number(env.OPENBOT_AGENT_CONTEXT_CHARS) : defaults.agentContextChars,
    isolation: env.OPENBOT_ISOLATION || defaults.isolation
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
    openaiApiKey: config.openaiApiKeySet ? 'set' : 'unset',
    resourceProfile: config.resourceProfile,
    agentMaxTurns: config.agentMaxTurns,
    agentMaxActions: config.agentMaxActions,
    agentContextChars: config.agentContextChars,
    isolation: config.isolation
  };
}
