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
 * It keeps the tabs, too. Every tab is its own Scramjet frame in this one
 * page, so they all share the one port, service worker and bare-mux
 * connection. That is also what makes pages that open new windows work: a
 * real popup from here would open as a top-level tab on the browse origin,
 * which the browser keeps in a different storage partition from this
 * embedded one — no service worker, no port, no way to reach the PC. So
 * window.open, target="_blank" links and forms, and modifier-clicks all open
 * a sibling tab in this page instead, with window.opener, postMessage,
 * window.close() and popup.closed wired up the way a sign-in popup (OAuth)
 * expects them to be.
 *
 * Port protocol (this page ↔ parent):
 *   parent → shell  {t:'go', url} {t:'back'} {t:'forward'} {t:'reload'}
 *                   {t:'tab-new', url?} {t:'tab-select', id} {t:'tab-close', id}
 *                   {t:'fetched', id, status, statusText, headers, body}
 *                   {t:'fetch-error', id, message}
 *                   {t:'ws-event', id, type, …}
 *   shell → parent  {t:'ready'} {t:'error', message} {t:'notice', message}
 *                   {t:'tabs', active, tabs: [{id, url, title, loading}]}
 *                   {t:'nav', url, title} {t:'loading', loading}  (active tab)
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
    case 'go': return goActive(message.url);
    case 'back': return navigate((frame) => frame.back());
    case 'forward': return navigate((frame) => frame.forward());
    case 'reload': return navigate((frame) => frame.reload());
    case 'tab-new': return openUserTab(message.url);
    case 'tab-select': return selectTab(message.id);
    case 'tab-close': return closeTab(message.id);
    default:
  }
}

/* ── Scramjet ──────────────────────────────────────────────────── */

const PREFIX = '/scramjet/';
const FRAME_ALLOW = 'fullscreen; autoplay; clipboard-read; clipboard-write; encrypted-media; picture-in-picture';

let scramjet = null;
let started = null;

function start() {
  started ??= (async () => {
    if (!('serviceWorker' in navigator)) throw new Error('This browser cannot run service workers here.');
    if (typeof SharedWorker === 'undefined') throw new Error('This browser has no SharedWorker support, which the native engine needs.');

    const { ScramjetController } = $scramjetLoadController();
    scramjet = new ScramjetController({
      prefix: PREFIX,
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

    setInterval(pollTitles, TITLE_POLL_MS);
  })();
  return started;
}

/** Open a URL in the active tab, or in a new one when every tab has been closed. */
async function goActive(url) {
  try {
    await start();
    const tab = tabs.get(activeId) || createTab({ activate: true });
    if (!tab) return;
    tab.url = url;
    setLoading(tab, true);
    tab.frame.go(url);
  } catch (err) {
    port?.postMessage({ t: 'error', message: err.message });
  }
}

/** Back, forward or reload, on the active tab. */
async function navigate(action) {
  try {
    await start();
    const tab = tabs.get(activeId);
    if (!tab) return;
    setLoading(tab, true);
    action(tab.frame);
  } catch (err) {
    port?.postMessage({ t: 'error', message: err.message });
  }
}

/* ── tabs ──────────────────────────────────────────────────────── */

/** Enough for real use; a page stuck opening windows in a loop stops here. */
const MAX_TABS = 24;
/** Titles change after load (single-page apps, unread counts) with no event to hear it by. */
const TITLE_POLL_MS = 1500;
/** One script-opened window per click, the way a browser's popup blocker counts. */
const POPUP_GAP_MS = 800;

/**
 * Tab = { id, frame (ScramjetFrame), el (its iframe), url, title, loading,
 *         opener (WindowProxy | null), closable, returnTo (tab id | null) }
 *
 * `closable` is whether the page may close the tab itself with
 * window.close() — true for anything the page opened, as in a real browser,
 * and false for tabs the person opened. `returnTo` is the tab that opened it,
 * which gets the focus back when it closes: a sign-in popup finishing drops
 * you back on the site that asked for it.
 */
const tabs = new Map();
const order = [];
let activeId = null;
let nextTabId = 1;
let lastPopupAt = 0;

/** Marks a Window (not its WindowProxy, which outlives navigations) as hooked. */
const HOOKED = Symbol('proxvocx tab hooks');
/** Marks a Document as having its link and form listeners. */
const LISTENING = Symbol('proxvocx tab listeners');
/** Scramjet 1.1.0's own marker for a hooked window (Symbol.for, so shared across realms). */
const CLIENT = Symbol.for('scramjet client global');

function createTab({
  url = '', blank = false, activate = true, after = null, name = '', opener = null,
  closable = false, returnTo = null,
} = {}) {
  if (tabs.size >= MAX_TABS) {
    port?.postMessage({ t: 'notice', message: `That would be more than ${MAX_TABS} tabs. Close a few first.` });
    return null;
  }
  const frame = scramjet.createFrame();
  const el = frame.frame;
  // createFrame names the frame at random; Scramjet needs *a* name to find
  // the tab's top, and a page that opened a named window needs *that* name.
  if (name) el.name = name;
  el.className = 'page';
  el.hidden = true;
  el.setAttribute('allow', FRAME_ALLOW);

  const tab = {
    id: nextTabId++, frame, el, url: blank ? 'about:blank' : '', title: '', loading: false,
    opener, closable, returnTo,
  };
  tabs.set(tab.id, tab);
  order.splice(insertIndex(after), 0, tab.id);

  frame.addEventListener('contextInit', (event) => hookWindow(tab, event.window));
  frame.addEventListener('urlchange', (event) => {
    tab.url = String(event.url || '');
    readTitle(tab);
    changed();
  });
  el.addEventListener('load', () => {
    tab.loading = false;
    try { tab.url = frame.url.toString(); } catch { /* not a proxied page (yet) */ }
    readTitle(tab);
    // A document that reused its window (a popup's first page) never fires
    // contextInit; the hooks are still in place, but its links need listeners.
    hookWindow(tab, el.contentWindow);
    changed();
  });

  document.body.append(el);
  if (url) {
    tab.url = url;
    setLoading(tab, true);
    frame.go(url);
  }
  if (activate || activeId == null) selectTab(tab.id);
  changed();
  return tab;
}

/** New tabs from a page go right after their opener (and its other children), as in a browser. */
function insertIndex(after) {
  let index = order.indexOf(after);
  if (index < 0) return order.length;
  index += 1;
  while (index < order.length && tabs.get(order[index])?.returnTo === after) index += 1;
  return index;
}

async function openUserTab(url) {
  try {
    await start();
    createTab({ url: url || '', activate: true });
  } catch (err) {
    port?.postMessage({ t: 'error', message: err.message });
  }
}

function selectTab(id) {
  if (!tabs.has(id)) return;
  activeId = id;
  for (const tab of tabs.values()) tab.el.hidden = tab.id !== id;
  changed();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const index = order.indexOf(id);
  tabs.delete(id);
  order.splice(index, 1);
  // Removing the frame discards its window, so an opener polling
  // `popup.closed` sees true from here on.
  tab.el.remove();
  if (activeId === id) {
    activeId = null;
    const next = tabs.has(tab.returnTo) ? tab.returnTo : order[Math.min(index, order.length - 1)];
    if (next != null) selectTab(next);
  }
  changed();
}

function setLoading(tab, loading) {
  tab.loading = loading;
  changed();
}

function readTitle(tab) {
  try { tab.title = tab.el.contentDocument?.title || ''; } catch { /* mid-navigation */ }
}

function pollTitles() {
  let dirty = false;
  for (const tab of tabs.values()) {
    const before = tab.title;
    readTitle(tab);
    if (tab.title !== before) dirty = true;
  }
  if (dirty) changed();
}

/* Reporting: the whole strip on any change, batched per task. The active
   tab's `nav` and `loading` also go out on their own, which is all a client
   from before tabs knows how to read. */

let reportQueued = false;
let lastNav = null;
let lastLoading = null;

function changed() {
  if (reportQueued) return;
  reportQueued = true;
  queueMicrotask(report);
}

function report() {
  reportQueued = false;
  if (!port) return;
  port.postMessage({
    t: 'tabs',
    active: activeId,
    tabs: order.map((id) => {
      const { url, title, loading } = tabs.get(id);
      return { id, url, title, loading };
    }),
  });
  const active = tabs.get(activeId);
  const nav = active ? `${active.id}\n${active.url}\n${active.title}` : '';
  if (active && nav !== lastNav) port.postMessage({ t: 'nav', url: active.url, title: active.title });
  lastNav = nav;
  const loading = !!active?.loading;
  if (loading !== lastLoading) port.postMessage({ t: 'loading', loading });
  lastLoading = loading;
}

/* ── new windows, from inside the pages ────────────────────────── */

/**
 * Hook one window in a tab: the tab's own top window or any frame inside it.
 * Runs from Scramjet's contextInit — after Scramjet has hooked the window
 * and before any of the page's own scripts — so even an inline script that
 * talks to window.opener straight away finds it.
 */
function hookWindow(tab, win) {
  let client;
  try { client = win?.[CLIENT]; } catch { return; }
  if (!client) return;

  try {
    if (!win[HOOKED]) {
      Object.defineProperty(win, HOOKED, { value: true });
      const top = win === tab.el.contentWindow;
      if (top) defineOpener(tab, win);
      interceptOpen(tab, win, client);
      if (top) interceptClose(tab, win, client);
    }
    const doc = win.document;
    if (doc && !doc[LISTENING]) {
      Object.defineProperty(doc, LISTENING, { value: true });
      // Bubble phase on the document: the page's own handlers have run by
      // then, so a link the page already handled (defaultPrevented) is left
      // alone, and the default action has not happened yet.
      doc.addEventListener('click', (event) => onLinkClick(tab, win, event));
      doc.addEventListener('auxclick', (event) => onLinkClick(tab, win, event));
      doc.addEventListener('submit', (event) => onFormSubmit(tab, win, event));
    }
  } catch (err) {
    console.warn('proxvocx: could not hook a tab window', err);
  }
}

/** A popup's opener, kept per tab so it survives every page the popup goes through. */
function defineOpener(tab, win) {
  if (!tab.opener) return;
  Object.defineProperty(win, 'opener', {
    configurable: true,
    enumerable: true,
    get: () => (tab.opener && !tab.opener.closed ? tab.opener : null),
    set: (value) => { if (value == null) tab.opener = null; },
  });
}

/**
 * window.open, layered over Scramjet's own hook (which rewrites the URL and
 * then opens a real, useless, top-level window). Targets Scramjet already
 * handles — _self, _parent, _top, a frame inside the page — pass through to
 * it untouched; everything else becomes a tab here.
 */
function interceptOpen(tab, win, client) {
  client.RawProxy(win, 'open', {
    apply(ctx) {
      const [rawUrl, rawTarget, features] = ctx.args;
      const target = rawTarget == null || rawTarget === '' ? '_blank' : String(rawTarget);
      const lower = target.toLowerCase();
      if (isSelfTarget(lower)) return;
      const named = lower === '_blank' ? null : findTabByName(target);
      if (!named && lower !== '_blank' && hasNamedFrame(tab.el.contentWindow, target)) return;

      const url = resolveUrl(rawUrl, client);
      if (url === null) { ctx.return(null); return; }
      const noopener = /(^|[\s,])(noopener|noreferrer)(?=$|[\s,=])/i.test(String(features ?? ''));

      if (named) {
        if (url !== 'about:blank') {
          named.url = url;
          setLoading(named, true);
          named.frame.go(url);
        }
        selectTab(named.id);
        ctx.return(noopener ? null : named.el.contentWindow);
        return;
      }

      if (!allowPopup(win)) {
        port?.postMessage({ t: 'notice', message: `Blocked a pop-up from ${hostOf(tab.url)}. Click the link or button again to open it.` });
        ctx.return(null);
        return;
      }
      const popup = createTab({
        url: url === 'about:blank' ? '' : url,
        blank: url === 'about:blank',
        activate: true,
        after: tab.id,
        name: lower === '_blank' ? '' : target,
        opener: noopener ? null : win,
        closable: true,
        returnTo: tab.id,
      });
      if (!popup) { ctx.return(null); return; }
      ctx.return(noopener ? null : adopt(popup, client));
    },
  });
}

/**
 * Hand a new tab's window to the page that opened it the way Scramjet hands
 * back a real popup: hooked already, so that `popup.location = …` or
 * `popup.document.write(…)` straight after window.open stays proxied instead
 * of reaching the real site from this device. The window is still the tab's
 * initial about:blank; its first real page is same-origin, so the browser
 * keeps the same window object for it, hooks and opener included.
 */
function adopt(tab, openerClient) {
  const win = tab.el.contentWindow;
  if (!(CLIENT in win)) {
    defineOpener(tab, win);
    new openerClient.constructor(win).hook();
  }
  hookWindow(tab, win);
  return win[CLIENT].global;
}

/** window.close() closes a tab the page opened (and quietly does nothing to one it did not). */
function interceptClose(tab, win, client) {
  client.RawProxy(win, 'close', {
    apply(ctx) {
      if (tab.closable) setTimeout(() => closeTab(tab.id), 0);
      ctx.return(undefined);
    },
  });
}

/**
 * Links that would open a new window: target="_blank" (or a name no frame
 * has), and ctrl/cmd/shift/middle clicks on any link. Left alone, each would
 * open a real browser tab on the browse origin that cannot reach the PC.
 */
function onLinkClick(tab, win, event) {
  if (event.defaultPrevented) return;
  const middle = event.type === 'auxclick' && event.button === 1;
  if (!middle && !(event.type === 'click' && event.button === 0)) return;
  const link = event.composedPath().find((node) =>
    (node.localName === 'a' || node.localName === 'area') && node.hasAttribute?.('href'));
  if (!link || link.hasAttribute('download')) return;

  const modifier = middle || event.ctrlKey || event.metaKey || event.shiftKey;
  const target = effectiveTarget(link, 'target');
  const lower = target.toLowerCase();
  let named = null;
  if (!modifier) {
    if (!target || isSelfTarget(lower)) return;
    if (lower !== '_blank') {
      named = findTabByName(target);
      if (!named && hasNamedFrame(tab.el.contentWindow, target)) return;
    }
  }
  const url = realUrl(link.href, tab.url);
  if (!url) return; // javascript:, mailto: and the like are not ours to open

  event.preventDefault();
  if (named) {
    named.url = url;
    setLoading(named, true);
    named.frame.go(url);
    selectTab(named.id);
    return;
  }
  // A script "clicking" a link for itself needs a real click behind it, like window.open.
  if (!event.isTrusted && !allowPopup(win)) return;

  const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
  // target="_blank" implies noopener unless rel="opener" says otherwise.
  const keepOpener = !modifier && !rel.includes('noopener') && !rel.includes('noreferrer')
    && (lower !== '_blank' || rel.includes('opener'));
  const background = middle || ((event.ctrlKey || event.metaKey) && !event.shiftKey);
  createTab({
    url,
    activate: !background,
    after: tab.id,
    name: !modifier && lower !== '_blank' ? target : '',
    opener: keepOpener ? link.ownerDocument.defaultView : null,
    closable: true,
    returnTo: tab.id,
  });
}

/**
 * A form posting to a new window. Its body cannot be replayed from here, so
 * rather than open the tab ourselves the form is pointed at a fresh tab by
 * name: the browser reads a form's target only after this event, and a name
 * lookup reaches sibling tabs because they share this page.
 */
function onFormSubmit(tab, win, event) {
  if (event.defaultPrevented) return;
  const form = event.target;
  if (form?.localName !== 'form') return;
  const submitter = event.submitter;
  const holder = submitter?.hasAttribute?.('formtarget') ? submitter : form;
  const attr = holder === form ? 'target' : 'formtarget';
  const target = holder === form ? effectiveTarget(form, 'target') : (holder.getAttribute(attr) || '').trim();
  const lower = target.toLowerCase();
  if (!target || isSelfTarget(lower)) return;
  let into = lower === '_blank' ? null : findTabByName(target);
  if (!into && lower !== '_blank' && hasNamedFrame(tab.el.contentWindow, target)) return;

  if (into) {
    selectTab(into.id);
  } else {
    into = createTab({
      blank: true,
      activate: true,
      after: tab.id,
      name: lower === '_blank' ? '' : target,
      opener: lower === '_blank' ? null : win,
      closable: true,
      returnTo: tab.id,
    });
    if (!into) { event.preventDefault(); return; }
  }
  setLoading(into, true);
  const before = holder.getAttribute(attr);
  holder.setAttribute(attr, into.el.name);
  setTimeout(() => {
    if (before == null) holder.removeAttribute(attr);
    else holder.setAttribute(attr, before);
  }, 0);
}

/* ── helpers ───────────────────────────────────────────────────── */

function isSelfTarget(lower) {
  return lower === '_self' || lower === '_parent' || lower === '_top' || lower === '_unfencedtop';
}

/** An element's target, falling back to the document's <base target>. */
function effectiveTarget(element, attr) {
  const own = element.getAttribute(attr);
  if (own != null && own.trim()) return own.trim();
  return (element.ownerDocument.querySelector('base[target]')?.getAttribute('target') || '').trim();
}

function findTabByName(name) {
  for (const tab of tabs.values()) if (tab.el.name === name) return tab;
  return null;
}

/** Whether a frame inside the tab already answers to `name` (then it is the page's business). */
function hasNamedFrame(win, name, depth = 0) {
  if (!win || depth > 8) return false;
  try {
    for (let i = 0; i < win.frames.length; i++) {
      const child = win.frames[i];
      if (child.name === name || hasNamedFrame(child, name, depth + 1)) return true;
    }
  } catch { /* a frame we cannot see into */ }
  return false;
}

/** A browser would only open this window during a click; so does this. */
function allowPopup(win) {
  let active = true;
  try {
    const activation = win.navigator.userActivation;
    if (activation) active = activation.isActive;
  } catch { /* no activation API: trust the gap below */ }
  const now = Date.now();
  if (!active || now - lastPopupAt < POPUP_GAP_MS) return false;
  lastPopupAt = now;
  return true;
}

/** window.open's URL argument, resolved against the calling page's real address. */
function resolveUrl(raw, client) {
  if (raw == null || String(raw) === '') return 'about:blank';
  if (String(raw).trim().toLowerCase() === 'about:blank') return 'about:blank';
  let base;
  try { base = client.meta?.base || client.url; } catch { /* about:blank caller */ }
  return realUrl(String(raw), base);
}

/** A real http(s) URL, unwrapping one that is already a proxied /scramjet/ address. */
function realUrl(href, base) {
  let url;
  try { url = new URL(href, base || undefined); } catch { return null; }
  if (url.origin === location.origin && url.pathname.startsWith(PREFIX)) {
    try { url = new URL(scramjet.decodeUrl(url.href)); } catch { return null; }
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'this page'; }
}

portReady
  .then(() => start())
  .then(() => port.postMessage({ t: 'ready' }))
  .catch((err) => port?.postMessage({ t: 'error', message: err.message }));
