import { dirname, join } from 'node:path';
import { availableParallelism, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const RESOURCE_PROFILES = Object.freeze({
  legacy: Object.freeze({ agentMaxTurns: 3, agentMaxActions: 3, agentContextChars: 6000, isolation: 'cwd', maxConcurrentTasks: 1, maxQueuedTasks: 4 }),
  standard: Object.freeze({ agentMaxTurns: 6, agentMaxActions: 6, agentContextChars: 12000, isolation: 'auto', maxConcurrentTasks: 2, maxQueuedTasks: 8 })
});

export const DEFAULT_BROWSER_ALLOW_HOSTS = Object.freeze(['127.0.0.1', 'localhost']);
export const AUTO_LEGACY_CPU_COUNT = 2;
export const AUTO_LEGACY_MEMORY_BYTES = 8 * 1024 ** 3;

function detectedHardware(env) {
  const configuredCpuCount = Number(env.OPENBOT_CPU_COUNT);
  const configuredMemoryBytes = Number(env.OPENBOT_MEMORY_BYTES);
  return {
    cpuCount: Number.isFinite(configuredCpuCount) && configuredCpuCount > 0 ? configuredCpuCount : availableParallelism(),
    memoryBytes: Number.isFinite(configuredMemoryBytes) && configuredMemoryBytes > 0 ? configuredMemoryBytes : totalmem()
  };
}

export function selectResourceProfile(env = process.env) {
  const requested = String(env.OPENBOT_RESOURCE_PROFILE || 'standard').trim().toLowerCase();
  if (requested === 'legacy' || requested === 'standard') return { profile: requested, mode: requested };
  if (requested === 'auto') {
    const hardware = detectedHardware(env);
    const profile = hardware.cpuCount <= AUTO_LEGACY_CPU_COUNT || hardware.memoryBytes < AUTO_LEGACY_MEMORY_BYTES ? 'legacy' : 'standard';
    return { profile, mode: 'auto' };
  }
  return { profile: 'standard', mode: 'standard' };
}

function browserAllowHosts(env) {
  const configured = String(env.OPENBOT_BROWSER_ALLOW_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host && (host === 'localhost' || host === '::1' || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)));
  return [...new Set(configured.length ? configured : DEFAULT_BROWSER_ALLOW_HOSTS)];
}

export function loadConfig(env = process.env) {
  const selection = selectResourceProfile(env);
  const profile = selection.profile;
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
    resourceProfileMode: selection.mode,
    agentMaxTurns: Number(env.OPENBOT_AGENT_MAX_TURNS) > 0 ? Number(env.OPENBOT_AGENT_MAX_TURNS) : defaults.agentMaxTurns,
    agentMaxActions: Number(env.OPENBOT_AGENT_MAX_ACTIONS) > 0 ? Number(env.OPENBOT_AGENT_MAX_ACTIONS) : defaults.agentMaxActions,
    agentContextChars: Number(env.OPENBOT_AGENT_CONTEXT_CHARS) > 0 ? Number(env.OPENBOT_AGENT_CONTEXT_CHARS) : defaults.agentContextChars,
    maxConcurrentTasks: Number(env.OPENBOT_MAX_CONCURRENT_TASKS) > 0 ? Math.min(Number(env.OPENBOT_MAX_CONCURRENT_TASKS), 8) : defaults.maxConcurrentTasks,
    maxQueuedTasks: Number(env.OPENBOT_MAX_QUEUED_TASKS) > 0 ? Math.min(Number(env.OPENBOT_MAX_QUEUED_TASKS), 50) : defaults.maxQueuedTasks,
    isolation: env.OPENBOT_ISOLATION || defaults.isolation,
    browserAllowHosts: browserAllowHosts(env)
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
    resourceProfileMode: config.resourceProfileMode || config.resourceProfile,
    agentMaxTurns: config.agentMaxTurns,
    agentMaxActions: config.agentMaxActions,
    agentContextChars: config.agentContextChars,
    maxConcurrentTasks: config.maxConcurrentTasks,
    maxQueuedTasks: config.maxQueuedTasks,
    isolation: config.isolation,
    browserAllowHosts: [...(config.browserAllowHosts || DEFAULT_BROWSER_ALLOW_HOSTS)]
  };
}
