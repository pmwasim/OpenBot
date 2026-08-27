import { classifyBrowserUrl } from '../policy.mjs';
import { htmlToMarkdown } from '../html_to_markdown.mjs';
import { fileWrite } from './file.mjs';

function denied(message) {
  const error = new Error(message);
  error.code = 'OPENBOT_URL_DENIED';
  error.statusCode = 403;
  return error;
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
        throw new Error('Response is too large.');
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export async function browserFetch({ url, workspace, path = 'research.md', timeoutMs = 10000, signal, allowHosts } = {}) {
  const classified = classifyBrowserUrl(url, { allowHosts });
  if (!classified.allowlisted) {
    throw denied(classified.reason || `URL is not allowlisted: ${url}`);
  }
  const linked = linkedTimeoutSignal(signal, timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: linked.signal,
      headers: { accept: 'text/html, text/plain;q=0.9' }
    });
  } finally {
    linked.cleanup();
  }
  if (!response.ok) {
    throw new Error(`Fetch failed with status ${response.status}.`);
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(contentLength) && contentLength > 1_000_000) throw new Error('Response is too large.');
  const html = await boundedBody(response, 1_000_000);
  const markdown = htmlToMarkdown(html, classified.parsed.href);
  const written = await fileWrite(workspace, path, markdown);
  return {
    url: classified.parsed.href,
    path: written.path,
    bytes: written.bytes,
    markdown
  };
}
