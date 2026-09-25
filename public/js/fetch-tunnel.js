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

const FETCH_CHANNEL = 'fetch';
/** How long a channel gets to open before the database lane is all we use. */
const CONNECT_TIMEOUT_MS = 12_000;
const DEFAULT_TIMEOUT_MS = 45_000;
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
  /** id -> { resolve, reject, meta, parts, n } */
  const pending = new Map();

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

      pc = new RTCPeerConnection({ iceServers: iceServers() });
      detachIce = attachIce(db, target, sessionId, pc, 'viewer');
      pc.addEventListener('datachannel', (event) => {
        if (event.channel.label !== FETCH_CHANNEL || stale()) return;
        channel = event.channel;
        channel.addEventListener('message', onMessage);
        channel.addEventListener('close', () => { if (!stale()) fail(); });
        const opened = () => {
          if (stale()) return;
          clearTimeout(openTimer);
          status = 'open';
          retryDelay = RETRY_MIN_MS;
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
  }

  function teardown() {
    generation += 1;
    for (const request of pending.values()) request.reject(new TunnelDown());
    pending.clear();
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
    const request = pending.get(message?.id);
    if (!request) return;
    if (message.t === 'err') {
      settle(message.id, request.reject, new ProxyError(message.error || 'The request failed.', message.code));
    } else if (message.t === 'res') {
      request.meta = message.meta || {};
      request.n = Number(message.n) || 0;
      if (request.n === 0) settle(message.id, request.resolve, { ...request.meta, body: '' });
    }
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
    close: () => tunnel.close(),
  };
}
