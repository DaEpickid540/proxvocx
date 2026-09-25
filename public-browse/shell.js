/**
 * The browse-origin shell: hosts Scramjet for the proxvocx client.
 *
 * This page lives on its own origin on purpose. Pages proxied by Scramjet run
 * their JavaScript on the origin that hosts it, and proxy rewriting is not a
 * security boundary. The proxvocx client's origin holds the Firebase sign-in
 * that can take control of your PC; this one holds nothing at all — no
 * sign-in, no Firebase, no credentials — so a hostile page that escapes the
 * rewriter here finds nothing worth having.
 *
 * It has no network of its own either. The parent (the proxvocx client, on
 * the other origin) hands it a MessagePort at start-up; every request and
 * WebSocket Scramjet makes is sent down that port, and the parent carries it
 * over its direct WebRTC lane to the PC, which makes the real request.
 *
 * Port protocol (this page ↔ parent):
 *   parent → shell  {t:'go', url} {t:'back'} {t:'forward'} {t:'reload'}
 *                   {t:'fetched', id, status, statusText, headers, body}
 *                   {t:'fetch-error', id, message}
 *                   {t:'ws-event', id, type, …}
 *   shell → parent  {t:'ready'} {t:'error', message} {t:'nav', url, title}
 *                   {t:'loading', loading}
 *                   {t:'fetch', id, url, method, headers, body}
 *                   {t:'ws-open', id, url, protocols, headers}
 *                   {t:'ws-send', id, data} {t:'ws-close', id, code, reason}
 */
import { BareMuxConnection } from '/baremux/index.mjs';

const HANDSHAKE_READY = 'proxvocx-browse-ready';
const HANDSHAKE_INIT = 'proxvocx-browse-init';

let port = null;
let nextId = 1;
const pendingFetches = new Map(); // id -> { resolve, reject }
const sockets = new Map();        // id -> { onopen, onmessage, onclose, onerror }

/* ── handshake: wait for the parent's port ─────────────────────── */

const portReady = new Promise((resolve) => {
  window.addEventListener('message', function onInit(event) {
    // Only the frame that embeds us may hand over the port. Anything else
    // posting here (a proxied page included) is ignored.
    if (event.source !== window.parent || event.data?.type !== HANDSHAKE_INIT || !event.ports?.[0]) return;
    window.removeEventListener('message', onInit);
    port = event.ports[0];
    port.onmessage = onParentMessage;
    resolve(port);
  });
});

if (window.parent === window) {
  document.body.innerHTML = '<p class="notice">This page is part of proxvocx and only works inside it. Open the proxvocx client and choose Browser mode.</p>';
} else {
  window.parent.postMessage({ type: HANDSHAKE_READY, v: 1 }, '*');
}

/* ── the transport bare-mux calls for every request and socket ──── */

/**
 * Scramjet consults the Public Suffix List (a ~335 KB file) for its cookie
 * rules, and with many requests in flight each one fetched it again rather
 * than waiting for the first — well over a hundred copies on one GitHub page,
 * tens of megabytes of the PC's upload spent on the same file. It changes a
 * few times a month; one copy per shell is plenty.
 */
const PSL_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
let pslResponse = null;

class ParentTransport {
  ready = false;

  async init() {
    await portReady;
    this.ready = true;
  }

  meta() { return {}; }

  async request(remote, method, body, headers) {
    await portReady;
    if (method === 'GET' && remote.toString() === PSL_URL) {
      pslResponse ??= this.relay(remote, method, null, headers).catch((err) => {
        pslResponse = null;
        throw err;
      });
      const cached = await pslResponse;
      // A copy each time: bare-mux transfers the body it is given.
      return { ...cached, body: cached.body.slice(0) };
    }
    return this.relay(remote, method, body, headers);
  }

  async relay(remote, method, body, headers) {
    // Bodies arrive as a ReadableStream or ArrayBuffer (or nothing).
    const bytes = body == null ? null : await new Response(body).arrayBuffer();
    const id = nextId++;
    const response = await new Promise((resolve, reject) => {
      pendingFetches.set(id, { resolve, reject });
      port.postMessage(
        { t: 'fetch', id, url: remote.toString(), method, headers, body: bytes },
        bytes ? [bytes] : [],
      );
    });
    return {
      body: response.body,
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    };
  }

  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    const id = nextId++;
    sockets.set(id, { onopen, onmessage, onclose, onerror });
    portReady.then(() => port.postMessage({
      t: 'ws-open', id, url: url.toString(), protocols, headers: requestHeaders,
    }));
    const send = (data) => {
      const transfer = data instanceof ArrayBuffer ? [data] : [];
      port?.postMessage({ t: 'ws-send', id, data }, transfer);
    };
    const close = (code, reason) => port?.postMessage({ t: 'ws-close', id, code, reason });
    return [send, close];
  }
}

function onParentMessage(event) {
  const message = event.data || {};
  switch (message.t) {
    case 'fetched': {
      const pending = pendingFetches.get(message.id);
      if (!pending) return;
      pendingFetches.delete(message.id);
      pending.resolve(message);
      return;
    }
    case 'fetch-error': {
      const pending = pendingFetches.get(message.id);
      if (!pending) return;
      pendingFetches.delete(message.id);
      pending.reject(new TypeError(message.message || 'Failed to fetch'));
      return;
    }
    case 'ws-event': {
      const socket = sockets.get(message.id);
      if (!socket) return;
      if (message.type === 'open') socket.onopen(message.protocol || '');
      else if (message.type === 'message') socket.onmessage(message.data);
      else if (message.type === 'error') socket.onerror(message.message || 'WebSocket error');
      else if (message.type === 'close') {
        sockets.delete(message.id);
        socket.onclose(message.code || 1005, message.reason || '');
      }
      return;
    }
    case 'go': return navigate((frame) => frame.go(message.url));
    case 'back': return navigate((frame) => frame.back());
    case 'forward': return navigate((frame) => frame.forward());
    case 'reload': return navigate((frame) => frame.reload());
    default:
  }
}

/* ── Scramjet ──────────────────────────────────────────────────── */

let frame = null;
let started = null;

function start() {
  started ??= (async () => {
    if (!('serviceWorker' in navigator)) throw new Error('This browser cannot run service workers here.');
    if (typeof SharedWorker === 'undefined') throw new Error('This browser has no SharedWorker support, which the native engine needs.');

    const { ScramjetController } = $scramjetLoadController();
    const scramjet = new ScramjetController({
      prefix: '/scramjet/',
      // Scramjet's default codec is plain encode/decodeURIComponent, which
      // re-encodes a URL that is *already* a proxied one. Some sites (GitHub,
      // anything using Turbo) hand history.replaceState a location Scramjet
      // failed to unproxy, and every such call then nested the address one
      // level deeper — the URL bar filled with /scramjet/http%3A…%253A… and a
      // reload fetched the wrong page. Unwrapping first makes encoding
      // idempotent. These functions are serialised into the worker and every
      // proxied page, so they must stay self-contained.
      codec: {
        encode: (url) => {
          if (!url) return url;
          const prefix = `${location.origin}/scramjet/`;
          let real = String(url);
          while (real.startsWith(prefix)) real = decodeURIComponent(real.slice(prefix.length));
          return encodeURIComponent(real);
        },
        decode: (url) => {
          if (!url) return url;
          const prefix = `${location.origin}/scramjet/`;
          let real = decodeURIComponent(url);
          while (real.startsWith(prefix)) real = decodeURIComponent(real.slice(prefix.length));
          return real;
        },
      },
      files: {
        wasm: '/scram/scramjet.wasm.wasm',
        all: '/scram/scramjet.all.js',
        sync: '/scram/scramjet.sync.js',
      },
    });
    await scramjet.init();

    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;

    const connection = new BareMuxConnection('/baremux/worker.js');
    await connection.setRemoteTransport(new ParentTransport(), 'proxvocx');

    frame = scramjet.createFrame();
    frame.frame.className = 'page';
    frame.frame.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write; encrypted-media; picture-in-picture');
    document.body.append(frame.frame);

    frame.addEventListener('urlchange', (event) => reportNav(event.url));
    frame.frame.addEventListener('load', () => {
      port?.postMessage({ t: 'loading', loading: false });
      let url = '';
      try { url = frame.url.toString(); } catch { /* not a proxied URL yet */ }
      if (url) reportNav(url);
    });
  })();
  return started;
}

async function navigate(action) {
  try {
    await start();
    port?.postMessage({ t: 'loading', loading: true });
    action(frame);
  } catch (err) {
    port?.postMessage({ t: 'error', message: err.message });
  }
}

function reportNav(url) {
  let title = '';
  try { title = frame.frame.contentDocument?.title || ''; } catch { /* mid-navigation */ }
  port?.postMessage({ t: 'nav', url: String(url || ''), title });
}

portReady
  .then(() => start())
  .then(() => port.postMessage({ t: 'ready' }))
  .catch((err) => port?.postMessage({ t: 'error', message: err.message }));
