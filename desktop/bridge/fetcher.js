import { assertPublicHost, parseTargetUrl, UrlRejectedError } from './safe-url.js';

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// Headers a client is never allowed to set on the proxied request.
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'cookie',
]);

// Response headers worth keeping. Everything else is dropped so the payload
// written to Firebase stays small and free of hop-by-hop noise.
const KEPT_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-language', 'content-encoding',
  'etag', 'last-modified', 'cache-control', 'date', 'location', 'server',
];

const TEXTUAL_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|xhtml\+xml|.*\+json|.*\+xml))/i;

export class FetchFailedError extends Error {
  constructor(message, code = 'ERR_FETCH_FAILED') {
    super(message);
    this.name = 'FetchFailedError';
    this.code = code;
  }
}

function normalizeMethod(method) {
  if (method === undefined || method === null || method === '') return 'GET';
  if (typeof method !== 'string') throw new UrlRejectedError('method must be a string');
  const upper = method.toUpperCase();
  if (!ALLOWED_METHODS.has(upper)) throw new UrlRejectedError(`method ${upper} is not allowed`);
  return upper;
}

function normalizeHeaders(headers, userAgent) {
  const out = { accept: '*/*', 'accept-encoding': 'gzip, deflate, br', 'user-agent': userAgent };
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const entries = Object.entries(headers).slice(0, 32);
    for (const [rawKey, rawValue] of entries) {
      const key = String(rawKey).toLowerCase().trim();
      if (!key || FORBIDDEN_REQUEST_HEADERS.has(key)) continue;
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) continue;
      const value = String(rawValue).replace(/[\r\n]/g, ' ').slice(0, 1024);
      out[key] = value;
    }
  }
  return out;
}

/** Read at most `limit` bytes from the body; report whether it was cut short. */
export async function readCappedBody(response, limit) {
  if (!response.body) return { buffer: Buffer.alloc(0), truncated: false, bytes: 0 };
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = limit - bytes;
      if (value.length >= remaining) {
        chunks.push(Buffer.from(value.buffer, value.byteOffset, remaining));
        bytes += remaining;
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.length));
      bytes += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { buffer: Buffer.concat(chunks, bytes), truncated, bytes };
}

function pickHeaders(headers) {
  const out = {};
  for (const name of KEPT_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value.slice(0, 1024);
  }
  return out;
}

function encodeBody(buffer, contentType) {
  if (buffer.length === 0) return { body: '', encoding: 'utf8' };
  if (TEXTUAL_TYPE.test(contentType || '')) {
    return { body: buffer.toString('utf8'), encoding: 'utf8' };
  }
  // Unknown or binary payload: base64 so it survives a JSON round trip.
  return { body: buffer.toString('base64'), encoding: 'base64' };
}

/**
 * Fetch a proxy request. Redirects are followed manually so every hop is
 * re-validated against the SSRF guard.
 *
 * @returns {Promise<object>} the record to write under /responses/{uid}/{id}
 */
export async function fetchThroughProxy(request, config, log) {
  const startedAt = Date.now();
  const method = normalizeMethod(request.method);
  const headers = normalizeHeaders(request.headers, config.userAgent);

  let body;
  if (request.body !== undefined && request.body !== null && request.body !== '') {
    if (method === 'GET' || method === 'HEAD') {
      throw new UrlRejectedError(`${method} requests cannot carry a body`);
    }
    if (typeof request.body !== 'string') {
      throw new UrlRejectedError('body must be a string');
    }
    if (Buffer.byteLength(request.body) > 64 * 1024) {
      throw new UrlRejectedError('request body is larger than 64KB');
    }
    body = request.body;
    if (!headers['content-type']) headers['content-type'] = 'text/plain;charset=UTF-8';
  }

  let url = parseTargetUrl(request.url);
  const chain = [];
  let response;

  for (let hop = 0; ; hop += 1) {
    await assertPublicHost(url, { allowPrivateNetwork: config.allowPrivateNetwork });
    chain.push(url.href);
    log.debug('fetching', { url: url.href, method, hop });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new FetchFailedError(
          `request timed out after ${config.requestTimeoutMs}ms`,
          'ERR_TIMEOUT',
        );
      }
      const cause = err.cause?.code || err.cause?.message || err.message;
      throw new FetchFailedError(`could not reach ${url.host}: ${cause}`, 'ERR_UNREACHABLE');
    } finally {
      clearTimeout(timer);
    }

    const location = response.status >= 300 && response.status < 400
      ? response.headers.get('location')
      : null;
    if (!location) break;

    if (hop >= config.maxRedirects) {
      await response.body?.cancel().catch(() => {});
      throw new FetchFailedError(
        `too many redirects (>${config.maxRedirects}) starting at ${chain[0]}`,
        'ERR_TOO_MANY_REDIRECTS',
      );
    }

    let next;
    try {
      next = new URL(location, url);
    } catch {
      await response.body?.cancel().catch(() => {});
      throw new FetchFailedError(`redirect to invalid location ${location}`, 'ERR_BAD_REDIRECT');
    }
    await response.body?.cancel().catch(() => {});
    url = parseTargetUrl(next.href);
    // 303, and 301/302 in practice, downgrade the method to GET and drop the body.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      body = undefined;
      delete headers['content-type'];
    }
  }

  const { buffer, truncated, bytes } = await readCappedBody(response, config.maxResponseBytes);
  const responseHeaders = pickHeaders(response.headers);
  const { body: encodedBody, encoding } = encodeBody(buffer, responseHeaders['content-type']);

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText || '',
    url: response.url || chain[chain.length - 1],
    finalUrl: chain[chain.length - 1],
    redirects: chain.length - 1,
    headers: responseHeaders,
    contentType: responseHeaders['content-type'] || null,
    body: encodedBody,
    bodyEncoding: encoding,
    bytes,
    truncated,
    durationMs: Date.now() - startedAt,
  };
}
