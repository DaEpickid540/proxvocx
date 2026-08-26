/**
 * Client half of the proxy: drops a request under the machine's `requests`
 * node and waits for the connector to answer under `responses`.
 *
 * Responses are deleted the moment they are read — they carry whole page
 * bodies, and leaving them behind would both leak content and burn quota.
 */
import { ref, push, set, remove, onValue, serverTimestamp } from './firebase.js';
import { paths } from './paths.js';

export class ProxyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 45_000;

export async function proxyRequest(db, machineId, request, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const node = push(ref(db, paths.requests(machineId)));
  const id = node.key;

  const payload = {
    url: request.url,
    method: request.method || 'GET',
    createdAt: serverTimestamp(),
    client: 'web',
  };
  if (request.headers && Object.keys(request.headers).length) payload.headers = request.headers;
  if (request.body) payload.body = request.body;

  await set(node, payload);

  const responseRef = ref(db, paths.response(machineId, id));

  return new Promise((resolve, reject) => {
    let settled = false;
    let stop = () => {};

    const cleanup = () => {
      stop();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      remove(responseRef).catch(() => {});
      remove(ref(db, paths.request(machineId, id))).catch(() => {});
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new ProxyError(
        'The PC did not answer in time. Is the connector still running?',
        'ERR_TIMEOUT',
      ));
    }, timeoutMs);

    const onAbort = () => finish(reject, new ProxyError('Cancelled.', 'ERR_ABORTED'));
    signal?.addEventListener('abort', onAbort);

    stop = onValue(responseRef, (snapshot) => {
      const value = snapshot.val();
      if (!value) return;
      if (value.ok === false) {
        finish(reject, new ProxyError(value.error || 'The request failed.', value.errorCode));
        return;
      }
      finish(resolve, value);
    }, (err) => {
      finish(reject, new ProxyError(err.message, 'ERR_PERMISSION'));
    });
  });
}

/** Turns a proxied response body back into bytes. */
export function responseBytes(response) {
  if (response.bodyEncoding === 'base64') {
    const binary = atob(response.body || '');
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(response.body || '');
}

/** A `data:` URL for the response, suitable for an <img> or <style>. */
export function responseDataUrl(response) {
  const type = (response.contentType || 'application/octet-stream').split(';')[0].trim();
  if (response.bodyEncoding === 'base64') return `data:${type};base64,${response.body}`;
  return `data:${type};base64,${btoa(unescape(encodeURIComponent(response.body || '')))}`;
}

export function responseText(response) {
  if (response.bodyEncoding !== 'base64') return response.body || '';
  return new TextDecoder().decode(responseBytes(response));
}

/** Broad classification, enough to pick a renderer. */
export function responseKind(response) {
  const type = (response.contentType || '').toLowerCase();
  if (type.includes('html')) return 'html';
  if (type.startsWith('image/')) return 'image';
  if (type.includes('json') || type.includes('xml') || type.startsWith('text/')) return 'text';
  if (type.includes('pdf')) return 'pdf';
  return 'binary';
}
