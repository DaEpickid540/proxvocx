/**
 * WebSockets for the native Browser-mode engine, opened by the PC.
 *
 * A page running under the native engine in the viewer's browser opens its
 * sockets through here: the viewer relays the request over the fast lane,
 * and this opens the real connection from the PC — with the page's own
 * Origin, cookies and subprotocols, which a browser-side WebSocket in the
 * connector page could not set — and relays traffic both ways.
 *
 * `ws` is loaded lazily, so a build without it still starts; sites simply
 * find their sockets refused.
 */
import { assertPublicHost, parseTargetUrl, UrlRejectedError } from './safe-url.js';

const MAX_SOCKETS_PER_OWNER = 64;
const PASS_HEADERS = new Set(['origin', 'cookie', 'user-agent', 'accept-language', 'authorization', 'pragma', 'cache-control']);

let WebSocketImpl = null;
async function loadWs() {
  if (WebSocketImpl) return WebSocketImpl;
  try {
    WebSocketImpl = (await import('ws')).WebSocket;
  } catch (err) {
    throw new Error(`WebSockets are unavailable on this PC: ${err.message}`);
  }
  return WebSocketImpl;
}

/** owner (a webContents id) -> Map(socketId -> ws) */
const owners = new Map();

function socketsOf(owner) {
  if (!owners.has(owner)) owners.set(owner, new Map());
  return owners.get(owner);
}

/**
 * Opens a socket and reports everything that happens to it through `emit`,
 * as `{ id, type: 'open'|'message'|'close'|'error', ... }`.
 */
export async function openSocket(owner, { id, url, protocols = [], headers = {} }, config, emit) {
  const sockets = socketsOf(owner);
  if (sockets.size >= MAX_SOCKETS_PER_OWNER) throw new Error('too many open WebSockets');
  if (sockets.has(id)) throw new Error('socket id already in use');

  let target;
  try {
    target = new URL(url);
  } catch {
    throw new UrlRejectedError('websocket url is not parseable');
  }
  if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
    throw new UrlRejectedError(`unsupported websocket protocol ${target.protocol}`);
  }
  // Same guard as every HTTP request: validated as its http(s) twin.
  const asHttp = parseTargetUrl(url.replace(/^ws/i, 'http'));
  await assertPublicHost(asHttp, { allowPrivateNetwork: config.allowPrivateNetwork });

  const passed = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (PASS_HEADERS.has(lower)) passed[lower] = [].concat(value).join(lower === 'cookie' ? '; ' : ', ');
  }
  if (!passed['user-agent']) passed['user-agent'] = config.userAgent;

  const WS = await loadWs();
  const socket = new WS(target, [].concat(protocols).filter(Boolean), {
    headers: passed,
    handshakeTimeout: config.requestTimeoutMs,
    maxPayload: 32 * 1024 * 1024,
  });
  sockets.set(id, socket);

  socket.on('open', () => emit({ id, type: 'open', protocol: socket.protocol || '' }));
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.concat([].concat(data));
      emit({ id, type: 'message', binary: true, data: new Uint8Array(buffer) });
    } else {
      emit({ id, type: 'message', binary: false, data: data.toString() });
    }
  });
  socket.on('close', (code, reason) => {
    sockets.delete(id);
    emit({ id, type: 'close', code, reason: reason?.toString() || '' });
  });
  socket.on('error', (err) => emit({ id, type: 'error', message: err.message }));
}

export function sendSocket(owner, id, data) {
  const socket = owners.get(owner)?.get(id);
  if (!socket || socket.readyState !== 1) return;
  socket.send(typeof data === 'string' ? data : Buffer.from(data));
}

export function closeSocket(owner, id, code, reason) {
  const socket = owners.get(owner)?.get(id);
  if (!socket) return;
  try {
    // ws only accepts 1000 or 3000–4999 from a client; anything else closes plainly.
    if (code === 1000 || (code >= 3000 && code <= 4999)) socket.close(code, String(reason || '').slice(0, 123));
    else socket.close();
  } catch {
    socket.terminate();
  }
}

/** The page that owned these went away; nobody is left to read them. */
export function closeAllFor(owner) {
  const sockets = owners.get(owner);
  if (!sockets) return;
  for (const socket of sockets.values()) {
    try { socket.terminate(); } catch { /* already gone */ }
  }
  owners.delete(owner);
}
