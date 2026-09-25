/**
 * Browser mode's fast lane, client side — see pc-fetch.js for the why.
 *
 * `createBrowserTransport()` is what the mini browser calls instead of
 * `proxyRequest()` directly. It sends each request down a direct WebRTC data
 * channel to the PC when one is open, and through the database queue when it
 * is not — while the channel is still connecting, or when it cannot connect
 * at all. A request that was on the channel when it dropped is retried on the
 * database lane rather than failed, so the switch is never visible as an
 * error, only as a page that loads faster.
 */
import { paths } from './paths.js';
import { ref, set, update, onValue } from './firebase.js';
import { iceServers, attachIce, createSession, closeSession, waitForDescription } from './signaling.js';
import { proxyRequest, ProxyError } from './proxy-client.js';
import { FRAME, encodeFrame, decodeFrame, splitBytes, joinParts, toBytes } from './lane-frames.js';

const FETCH_CHANNEL = 'fetch';
/** How long a channel gets to open before the database lane is all we use. */
const CONNECT_TIMEOUT_MS = 12_000;
const DEFAULT_TIMEOUT_MS = 45_000;
/** Native-engine requests carry whole downloads; give them longer. */
const RAW_TIMEOUT_MS = 120_000;
const BUFFER_HIGH = 4 * 1024 * 1024;
const BUFFER_LOW = 1 * 1024 * 1024;
/** Backoff between attempts on a PC whose channel will not open — an older
 *  connector, rules not yet deployed, or a network that needs TURN. */
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 10 * 60_000;

class TunnelDown extends Error {}

function createFetchTunnel({ db, uid }) {
  let machineId = null;
  let status = 'idle'; // idle | connecting | open | failed
  let generation = 0;
  let sessionId = null;
  let pc = null;
  let channel = null;
  let detachIce = null;
  let stopWatch = null;
  let retryAt = 0;
  let retryDelay = RETRY_MIN_MS;
  let nextId = 1;
  let features = {};
  let sendChain = Promise.resolve();
  /** id -> { resolve, reject, meta, parts, n } */
  const pending = new Map();
  /** id -> { onopen, onmessage, onclose, onerror } for relayed WebSockets */
  const sockets = new Map();
  /** Callbacks waiting for the lane to open (or to give up). */
  let openWaiters = [];

  function notifyWaiters(result) {
    const waiters = openWaiters;
    openWaiters = [];
    for (const resolve of waiters) resolve(result);
  }

  function ensure(target) {
    if (!target) return;
    if (target === machineId && (status === 'open' || status === 'connecting')) return;
    if (target === machineId && status === 'failed' && Date.now() < retryAt) return;
    if (target !== machineId) retryDelay = RETRY_MIN_MS;
    connect(target);
  }

  async function connect(target) {
    teardown();
    machineId = target;
    status = 'connecting';
    const mine = ++generation;
    const stale = () => mine !== generation;
    const openTimer = setTimeout(() => { if (!stale() && status !== 'open') fail(); }, CONNECT_TIMEOUT_MS);

    try {
      const created = await createSession(db, target, uid, 'fetch', {}, { warnOnLeave: false });
      // Superseded while the row was being written: nothing else knows about
      // this row, so it has to be released here or it outlives the attempt.
      if (stale()) {
        closeSession(db, target, created);
        return;
      }
      sessionId = created;

      // A PC that refuses (browser traffic switched off) says so on the
      // session row — no point waiting out the timeout for an offer.
      stopWatch = onValue(ref(db, paths.session(target, sessionId)), (snap) => {
        const value = snap.val();
        if (!stale() && status === 'connecting' && (!value || value.state === 'refused')) fail();
      }, () => { if (!stale()) fail(); });

      const offer = await waitForDescription(db, paths.sessionOffer(target, sessionId), CONNECT_TIMEOUT_MS);
      if (stale()) return;
      // Absent on a connector that predates the native engine.
      features = offer.features && typeof offer.features === 'object' ? offer.features : {};

      pc = new RTCPeerConnection({ iceServers: iceServers() });
      detachIce = attachIce(db, target, sessionId, pc, 'viewer');
      pc.addEventListener('datachannel', (event) => {
        if (event.channel.label !== FETCH_CHANNEL || stale()) return;
        channel = event.channel;
        channel.binaryType = 'arraybuffer';
        channel.bufferedAmountLowThreshold = BUFFER_LOW;
        channel.addEventListener('message', onMessage);
        channel.addEventListener('close', () => { if (!stale()) fail(); });
        const opened = () => {
          if (stale()) return;
          clearTimeout(openTimer);
          status = 'open';
          retryDelay = RETRY_MIN_MS;
          notifyWaiters(true);
        };
        if (channel.readyState === 'open') opened();
        else channel.addEventListener('open', opened, { once: true });
      });
      pc.addEventListener('connectionstatechange', () => {
        if (!stale() && ['failed', 'closed', 'disconnected'].includes(pc?.connectionState)) fail();
      });

      await pc.setRemoteDescription(new RTCSessionDescription({ type: offer.type, sdp: offer.sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await set(ref(db, paths.sessionAnswer(target, sessionId)), { type: answer.type, sdp: answer.sdp });
      await update(ref(db, paths.session(target, sessionId)), { state: 'answered' });
    } catch {
      // Permission denied (rules predating 'fetch' sessions), no offer in
      // time (a connector predating them), or anything else: the database
      // lane still works, so this is a fallback, not an error.
      if (!stale()) fail();
    }
  }

  function fail() {
    const target = machineId;
    teardown();
    machineId = target;
    status = 'failed';
    retryAt = Date.now() + retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    notifyWaiters(false);
  }

  function teardown() {
    generation += 1;
    for (const request of pending.values()) {
      request.cleanup?.();
      request.reject(new TunnelDown());
    }
    pending.clear();
    for (const handlers of sockets.values()) {
      handlers.onerror?.('The connection to the PC dropped.');
      handlers.onclose?.(1006, '');
    }
    sockets.clear();
    features = {};
    sendChain = Promise.resolve();
    stopWatch?.();
    stopWatch = null;
    detachIce?.();
    detachIce = null;
    try { channel?.close(); } catch { /* already closed */ }
    channel = null;
    try { pc?.close(); } catch { /* already closed */ }
    pc = null;
    if (machineId && sessionId) closeSession(db, machineId, sessionId);
    sessionId = null;
    status = 'idle';
  }

  function onMessage(event) {
    const data = event.data;
    if (data instanceof ArrayBuffer) {
      onFrame(decodeFrame(data));
      return;
    }
    if (typeof data !== 'string') return;

    // Body chunks are "id\n<text>"; everything else is JSON and starts with {.
    if (data[0] !== '{') {
      const cut = data.indexOf('\n');
      const request = pending.get(Number(data.slice(0, cut)));
      if (!request?.meta) return;
      request.parts.push(data.slice(cut + 1));
      if (request.parts.length === request.n) settle(request.id, request.resolve, { ...request.meta, body: request.parts.join('') });
      return;
    }

    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message?.t?.startsWith('ws')) {
      onSocketMessage(message);
      return;
    }
    const request = pending.get(message?.id);
    if (!request) return;
    if (message.t === 'rres') {
      request.meta = {
        status: Number(message.status) || 0,
        statusText: String(message.statusText || ''),
        headers: message.headers && typeof message.headers === 'object' ? message.headers : {},
        truncated: !!message.truncated,
      };
      request.n = Number(message.parts) || 0;
      if (request.n === 0) settle(message.id, request.resolve, { ...request.meta, body: new ArrayBuffer(0) });
      return;
    }
    if (message.t === 'err') {
      settle(message.id, request.reject, new ProxyError(message.error || 'The request failed.', message.code));
    } else if (message.t === 'res') {
      request.meta = message.meta || {};
      request.n = Number(message.n) || 0;
      if (request.n === 0) settle(message.id, request.resolve, { ...request.meta, body: '' });
    }
  }

  function onFrame(frame) {
    if (frame.kind === FRAME.RESPONSE_BODY) {
      const request = pending.get(frame.id);
      if (!request?.meta) return;
      request.parts.push(frame.bytes.slice());
      if (request.parts.length === request.n) {
        settle(frame.id, request.resolve, { ...request.meta, body: joinParts(request.parts) });
      }
    } else if (frame.kind === FRAME.WS_BINARY) {
      sockets.get(frame.id)?.onmessage?.(frame.bytes.slice().buffer);
    }
  }

  function onSocketMessage(message) {
    const handlers = sockets.get(message.id);
    if (!handlers) return;
    switch (message.t) {
      case 'wsopen': handlers.onopen?.(String(message.protocol || '')); break;
      case 'wsm': handlers.onmessage?.(String(message.d ?? '')); break;
      case 'wserr': handlers.onerror?.(String(message.error || 'WebSocket error')); break;
      case 'wsclose':
        sockets.delete(message.id);
        handlers.onclose?.(Number(message.code) || 1005, String(message.reason || ''));
        break;
      default:
    }
  }

  /** In-order sending with backpressure, so a large upload cannot overflow the channel. */
  function send(data) {
    sendChain = sendChain.then(async () => {
      if (channel?.readyState !== 'open') throw new TunnelDown();
      if (channel.bufferedAmount > BUFFER_HIGH) {
        await new Promise((resolve) => {
          const done = () => {
            channel?.removeEventListener('bufferedamountlow', done);
            channel?.removeEventListener('close', done);
            resolve();
          };
          channel.addEventListener('bufferedamountlow', done);
          channel.addEventListener('close', done);
        });
        if (channel?.readyState !== 'open') throw new TunnelDown();
      }
      channel.send(data);
    });
    const result = sendChain;
    // A failure is reported to this caller, never to the next one in line.
    sendChain = sendChain.catch(() => {});
    return result;
  }

  /**
   * A request exactly as a browser would send it, for the native engine:
   * headers (cookies included) passed through, redirects not followed, and
   * the body as bytes. Resolves with `{ status, statusText, headers, body }`,
   * `body` an ArrayBuffer.
   */
  async function rawRequest({ url, method = 'GET', headers = {}, body = null }, { signal, timeoutMs = RAW_TIMEOUT_MS } = {}) {
    if (status !== 'open' || channel?.readyState !== 'open') throw new TunnelDown();
    const id = nextId++;
    const bytes = await toBytes(body);
    const parts = splitBytes(bytes);
    const result = new Promise((resolve, reject) => {
      const cancel = () => { send(JSON.stringify({ t: 'cancel', id })).catch(() => {}); };
      const timer = setTimeout(() => {
        cancel();
        settle(id, reject, new ProxyError('The PC did not answer in time.', 'ERR_TIMEOUT'));
      }, timeoutMs);
      const onAbort = () => {
        cancel();
        settle(id, reject, new DOMException('The request was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort);
      pending.set(id, {
        id, resolve, reject, meta: null, parts: [], n: 0,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      });
    });
    try {
      await send(JSON.stringify({ t: 'rreq', id, url, method, headers, parts: parts.length }));
      for (const part of parts) await send(encodeFrame(id, FRAME.REQUEST_BODY, part));
    } catch {
      settle(id, pending.get(id)?.reject || (() => {}), new TunnelDown());
    }
    return result;
  }

  /**
   * A WebSocket opened by the PC. `handlers` get onopen(protocol),
   * onmessage(string | ArrayBuffer), onclose(code, reason), onerror(message).
   * Returns `{ send(data), close(code, reason) }`.
   */
  function openSocket({ url, protocols = [], headers = {} }, handlers) {
    const id = nextId++;
    if (status !== 'open' || !features.ws) {
      queueMicrotask(() => {
        handlers.onerror?.('WebSockets are not available through this PC.');
        handlers.onclose?.(1006, '');
      });
      return { send() {}, close() {} };
    }
    sockets.set(id, handlers);
    send(JSON.stringify({ t: 'wso', id, url, protocols, headers })).catch(() => {});
    return {
      send(data) {
        if (!sockets.has(id)) return;
        if (typeof data === 'string') {
          send(JSON.stringify({ t: 'wss', id, d: data })).catch(() => {});
        } else {
          toBytes(data).then((bytes) => send(encodeFrame(id, FRAME.WS_BINARY, bytes))).catch(() => {});
        }
      },
      close(code = 1000, reason = '') {
        if (sockets.has(id)) send(JSON.stringify({ t: 'wsc', id, code, reason })).catch(() => {});
      },
    };
  }

  /**
   * Resolves true once the lane to `target` is open, false if it cannot be
   * opened within `ms`. Retries straight away rather than honouring the
   * backoff: this is someone waiting on it now.
   */
  function waitOpen(target, ms = CONNECT_TIMEOUT_MS + 3000) {
    if (status === 'open' && machineId === target) return Promise.resolve(true);
    if (!(machineId === target && status === 'connecting')) connect(target);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(status === 'open' && machineId === target), ms);
      openWaiters.push((ok) => {
        clearTimeout(timer);
        resolve(ok && machineId === target);
      });
    });
  }

  function settle(id, fn, value) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    request.cleanup();
    fn(value);
  }

  function request(spec, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (status !== 'open' || channel?.readyState !== 'open') return Promise.reject(new TunnelDown());
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        try { channel?.send(JSON.stringify({ t: 'cancel', id })); } catch { /* closing */ }
      };
      const timer = setTimeout(() => {
        cancel();
        settle(id, reject, new ProxyError('The PC did not answer in time. Is the connector still running?', 'ERR_TIMEOUT'));
      }, timeoutMs);
      const onAbort = () => {
        cancel();
        settle(id, reject, new ProxyError('Cancelled.', 'ERR_ABORTED'));
      };
      signal?.addEventListener('abort', onAbort);
      pending.set(id, {
        id, resolve, reject, meta: null, parts: [], n: 0,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      });
      try {
        channel.send(JSON.stringify({
          t: 'req',
          id,
          url: spec.url,
          method: spec.method || 'GET',
          ...(spec.headers ? { headers: spec.headers } : {}),
          ...(spec.body ? { body: spec.body } : {}),
        }));
      } catch {
        settle(id, reject, new TunnelDown());
      }
    });
  }

  return {
    ensure,
    request,
    rawRequest,
    openSocket,
    waitOpen,
    features: (target) => (machineId === target ? features : {}),
    isOpen: (target) => status === 'open' && machineId === target,
    close() {
      teardown();
      machineId = null;
    },
  };
}

/**
 * The mini browser's network: the fast lane when it is up, the database lane
 * otherwise. `request(machineId, spec, options)` has the same shape and the
 * same response object as `proxyRequest()`.
 */
export function createBrowserTransport({ db, uid }) {
  const tunnel = createFetchTunnel({ db, uid });

  return {
    async request(machineId, spec, options = {}) {
      if (tunnel.isOpen(machineId)) {
        try {
          return await tunnel.request(spec, options);
        } catch (err) {
          if (!(err instanceof TunnelDown)) throw err;
          if (options.signal?.aborted) throw new ProxyError('Cancelled.', 'ERR_ABORTED');
          // Fell over mid-request: carry on via the database lane below.
        }
      }
      tunnel.ensure(machineId);
      return proxyRequest(db, machineId, spec, options);
    },
    /** True while the fast lane is up — the mini browser fetches more per page then. */
    isFast: (machineId) => tunnel.isOpen(machineId),
    /** Starts connecting ahead of the first page, so that page is fast too. */
    warm: (machineId) => tunnel.ensure(machineId),
    /**
     * The native engine's network. It has no database fallback — it needs
     * bytes, cookies and sockets the queue cannot carry — so it waits for the
     * lane instead, and reports whether this PC supports it at all.
     */
    native: {
      async ready(machineId) {
        if (!(await tunnel.waitOpen(machineId))) return { ok: false, reason: 'unreachable' };
        if (!tunnel.features(machineId).raw) return { ok: false, reason: 'outdated' };
        return { ok: true, websockets: !!tunnel.features(machineId).ws };
      },
      request: (spec, options) => tunnel.rawRequest(spec, options),
      socket: (spec, handlers) => tunnel.openSocket(spec, handlers),
    },
    close: () => tunnel.close(),
  };
}
