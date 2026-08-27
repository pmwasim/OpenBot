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
  const html = await response.text();
  if (html.length > 1_000_000) throw new Error('Response is too large.');
  const markdown = htmlToMarkdown(html, classified.parsed.href);
  const written = await fileWrite(workspace, path, markdown);
  return {
    url: classified.parsed.href,
    path: written.path,
    bytes: written.bytes,
    markdown
  };
}
