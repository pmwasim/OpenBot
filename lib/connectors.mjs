import { randomUUID } from 'node:crypto';
import { redactSecrets } from './provider.mjs';
import { classifyBrowserUrl } from './policy.mjs';

export const CONNECTOR_LIMITS = Object.freeze({
  maxConnectors: 25,
  maxNameChars: 80,
  maxDescriptionChars: 400,
  maxPaths: 20,
  maxPathChars: 200,
  maxResponseBytes: 64 * 1024,
  timeoutMs: 10000
});

function connectorError(message, statusCode = 400, code = 'OPENBOT_CONNECTOR_INVALID') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function parseBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); }
  catch { throw connectorError('Connector base URL must be a valid http(s) URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw connectorError('Connector base URL must use http or https.');
  if (parsed.username || parsed.password) throw connectorError('Connector base URL cannot contain credentials.');
  if (parsed.search || parsed.hash) throw connectorError('Connector base URL cannot contain a query or fragment.');
  if (!parsed.hostname) throw connectorError('Connector base URL must include a host.');
  parsed.pathname = parsed.pathname || '/';
  if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`;
  return parsed.toString();
}

function normalizePath(value) {
  const path = String(value || '').trim();
  if (!path || path.length > CONNECTOR_LIMITS.maxPathChars || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw connectorError('Connector paths must be bounded absolute paths.');
  }
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) throw connectorError('Connector paths cannot contain traversal segments.');
  return path;
}

export function isConnectorPathAllowed(path, allowedPaths = []) {
  const requested = String(path || '').split('?')[0].split('#')[0];
  return allowedPaths.some((allowed) => {
    const prefix = String(allowed || '');
    return requested === prefix || prefix === '/' || requested.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
  });
}

export function validateConnectorDefinition(input = {}) {
  const name = redactSecrets(String(input.name || '').trim());
  const description = redactSecrets(String(input.description || '').trim());
  const rawPaths = Array.isArray(input.allowedPaths)
    ? input.allowedPaths
    : String(input.allowedPaths || '').split(',').map((item) => item.trim()).filter(Boolean);
  const allowedPaths = [...new Set(rawPaths.map(normalizePath))];
  if (!name || name.length > CONNECTOR_LIMITS.maxNameChars) throw connectorError(`Connector name must be between 1 and ${CONNECTOR_LIMITS.maxNameChars} characters.`);
  if (description.length > CONNECTOR_LIMITS.maxDescriptionChars) throw connectorError(`Connector description must be ${CONNECTOR_LIMITS.maxDescriptionChars} characters or fewer.`);
  if (!allowedPaths.length || allowedPaths.length > CONNECTOR_LIMITS.maxPaths) throw connectorError(`Connector must define between 1 and ${CONNECTOR_LIMITS.maxPaths} allowed paths.`);
  return {
    id: input.id || `connector-${randomUUID()}`,
    name,
    description,
    baseUrl: parseBaseUrl(input.baseUrl),
    allowedPaths,
    enabled: input.enabled !== false,
    owner: input.owner || 'operator'
  };
}

export function connectorView(connector = {}) {
  return {
    id: connector.id,
    name: connector.name,
    description: connector.description || '',
    baseUrl: connector.baseUrl,
    allowedPaths: [...(connector.allowedPaths || [])],
    enabled: connector.enabled !== false,
    owner: connector.owner || 'operator',
    createdAt: connector.createdAt || null,
    updatedAt: connector.updatedAt || null
  };
}

export function resolveConnectorUrl(connector, path, allowHosts) {
  if (!connector || connector.enabled === false) throw connectorError('Connector is disabled or unavailable.', 404, 'OPENBOT_CONNECTOR_UNAVAILABLE');
  const requested = String(path || '').trim();
  if (!requested.startsWith('/') || requested.startsWith('//') || requested.includes('\\')) throw connectorError('Connector request path must be absolute and local to the connector.');
  if (!isConnectorPathAllowed(requested, connector.allowedPaths)) throw connectorError('Connector request path is not allowlisted.', 403, 'OPENBOT_CONNECTOR_PATH_DENIED');
  let target;
  try { target = new URL(requested, connector.baseUrl); }
  catch { throw connectorError('Connector request path is invalid.'); }
  const base = new URL(connector.baseUrl);
  if (target.origin !== base.origin) throw connectorError('Connector request cannot change host or protocol.', 403, 'OPENBOT_CONNECTOR_HOST_CHANGED');
  const classified = classifyBrowserUrl(target.toString(), { allowHosts });
  if (!classified.allowlisted) throw connectorError(classified.reason || 'Connector host is not allowlisted.', 403, 'OPENBOT_CONNECTOR_HOST_DENIED');
  return target;
}

function linkedTimeoutSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}

async function boundedBody(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw connectorError('Connector response is too large.', 413, 'OPENBOT_CONNECTOR_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export async function connectorFetch({ connector, path, allowHosts, signal, timeoutMs = CONNECTOR_LIMITS.timeoutMs } = {}) {
  const target = resolveConnectorUrl(connector, path, allowHosts);
  const linked = linkedTimeoutSignal(signal, timeoutMs);
  let response;
  try {
    response = await fetch(target, {
      redirect: 'error',
      signal: linked.signal,
      headers: { accept: 'application/json, text/plain;q=0.9' }
    });
    const body = await boundedBody(response, CONNECTOR_LIMITS.maxResponseBytes);
    if (!response.ok) throw connectorError(`Connector returned status ${response.status}.`, 502, 'OPENBOT_CONNECTOR_HTTP_ERROR');
    return {
      connectorId: connector.id,
      url: target.toString(),
      status: response.status,
      contentType: response.headers.get('content-type') || null,
      bytes: Buffer.byteLength(body, 'utf8'),
      body
    };
  } finally {
    linked.cleanup();
  }
}
