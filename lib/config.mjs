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
    pidFile: env.OPENBOT_PID_FILE || join(env.OPENBOT_DATA_DIR || join(ROOT, 'data'), 'openbot.pid'),
    modelUrl: env.OPENBOT_MODEL_URL || 'http://127.0.0.1:11434',
    modelProtocol: env.OPENBOT_MODEL_PROTOCOL || 'native',
    localOnly: env.OPENBOT_LOCAL_ONLY !== '0',
    allowNonLoopback: env.OPENBOT_ALLOW_NON_LOOPBACK === '1',
    remoteBaseUrl: env.OPENBOT_REMOTE_BASE_URL || '',
    remoteApiKeySet: Boolean(env.OPENBOT_REMOTE_API_KEY),
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
    modelUrl: config.modelUrl,
    modelProtocol: config.modelProtocol,
    localOnly: config.localOnly,
    allowNonLoopback: config.allowNonLoopback,
    remoteCompatible: config.remoteBaseUrl ? 'configured' : 'disabled',
    remoteApiKey: config.remoteApiKeySet ? 'set' : 'unset',
    resourceProfile: config.resourceProfile,
    agentMaxTurns: config.agentMaxTurns,
    agentMaxActions: config.agentMaxActions,
    agentContextChars: config.agentContextChars,
    isolation: config.isolation
  };
}
