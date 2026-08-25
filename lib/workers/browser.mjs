import { classifyBrowserUrl } from '../policy.mjs';
import { htmlToMarkdown } from '../html_to_markdown.mjs';
import { fileWrite } from './file.mjs';

function denied(message) {
  const error = new Error(message);
  error.code = 'OPENBOT_URL_DENIED';
  error.statusCode = 403;
  return error;
}

export async function browserFetch({ url, workspace, path = 'research.md', timeoutMs = 10000 } = {}) {
  const classified = classifyBrowserUrl(url);
  if (!classified.allowlisted) {
    throw denied(classified.reason || `URL is not allowlisted: ${url}`);
  }
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'text/html, text/plain;q=0.9' }
  });
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
