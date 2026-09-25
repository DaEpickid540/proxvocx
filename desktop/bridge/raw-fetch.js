/**
 * The network half of the native Browser-mode engine.
 *
 * The script-free engine asks the PC for a page and gets back something ready
 * to render: redirects already followed, only a handful of headers kept, no
 * cookies either way. The native engine (Scramjet, running in the viewer's
 * own browser) needs the opposite — the PC has to behave like a browser's
 * network stack and nothing more, so that the engine can do the rest itself:
 *
 *   - redirects come back as the 3xx they are, and the engine follows them
 *     (every hop is a new request, so every hop still meets the SSRF guard);
 *   - request headers pass through, cookies included — the engine keeps its
 *     own cookie jar and sends what a browser would, which is what makes a
 *     login work at all;
 *   - response headers come back whole, `set-cookie` as a list;
 *   - bodies are bytes both ways, not base64 strings with a 64 KB cap.
 *
 * What is *not* passed through is anything that describes this hop rather
 * than the request: hop-by-hop headers, `host`, `content-length` (recomputed),
 * and `accept-encoding` (the PC decompresses, so the body that goes back is
 * already plain and must not claim otherwise).
 */
import { assertPublicHost, parseTargetUrl, UrlRejectedError } from './safe-url.js';
import { FetchFailedError, readCappedBody } from './fetcher.js';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

const DROP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'proxy-authorization', 'proxy-connection', 'accept-encoding',
]);
const DROP_RESPONSE = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'set-cookie', // re-added below as a list, which a Headers iterator cannot give
]);
const NO_BODY_STATUS = new Set([101, 204, 205, 304]);

/** Uploads bigger than this are refused rather than buffered. */
export const RAW_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/**
 * @param {{url: string, method?: string, headers?: Record<string, string|string[]>, body?: Uint8Array|null}} request
 * @param {{requestTimeoutMs: number, maxResponseBytes: number, allowPrivateNetwork: boolean, userAgent: string}} config
 */
export async function rawFetch(request, config) {
  const url = parseTargetUrl(request?.url);
  await assertPublicHost(url, { allowPrivateNetwork: config.allowPrivateNetwork });

  const method = String(request.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new UrlRejectedError(`method ${method} is not allowed`);

  const headers = new Headers();
  for (const [rawKey, rawValue] of Object.entries(request.headers || {}).slice(0, 96)) {
    const key = String(rawKey).toLowerCase().trim();
    if (!key || DROP_REQUEST.has(key) || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) continue;
    for (const value of [].concat(rawValue)) {
      headers.append(key, String(value).replace(/[\r\n]/g, ' ').slice(0, 8192));
    }
  }
  if (!headers.has('user-agent')) headers.set('user-agent', config.userAgent);
  headers.set('accept-encoding', 'gzip, deflate, br');

  let body;
  if (request.body && request.body.byteLength) {
    if (method === 'GET' || method === 'HEAD') {
      throw new UrlRejectedError(`${method} requests cannot carry a body`);
    }
    if (request.body.byteLength > RAW_MAX_REQUEST_BYTES) {
      throw new UrlRejectedError('request body is larger than 32 MB');
    }
    body = request.body;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  let response;
  try {
    response = await fetch(url, { method, headers, body, redirect: 'manual', signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new FetchFailedError(`request timed out after ${config.requestTimeoutMs}ms`, 'ERR_TIMEOUT');
    }
    const cause = err.cause?.code || err.cause?.message || err.message;
    throw new FetchFailedError(`could not reach ${url.host}: ${cause}`, 'ERR_UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }

  const out = {};
  for (const [key, value] of response.headers) {
    if (DROP_RESPONSE.has(key)) continue;
    out[key] = value;
  }
  const cookies = response.headers.getSetCookie?.() || [];
  if (cookies.length) out['set-cookie'] = cookies;

  let bytes = new Uint8Array(0);
  let truncated = false;
  if (NO_BODY_STATUS.has(response.status) || method === 'HEAD') {
    await response.body?.cancel().catch(() => {});
  } else {
    const read = await readCappedBody(response, config.maxResponseBytes);
    // A copy of exactly the body: a view over the Buffer could share a pooled
    // allocation, and IPC serialises the whole backing store.
    bytes = new Uint8Array(read.buffer);
    truncated = read.truncated;
  }

  return {
    status: response.status,
    statusText: response.statusText || '',
    headers: out,
    body: bytes,
    truncated,
  };
}
