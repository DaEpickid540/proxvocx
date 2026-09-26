/**
 * Browser mode's native engine: Scramjet, running in this browser.
 *
 * The other two engines either render a script-free rewrite of the page
 * (client-browser.js) or stream a video of a real tab on the PC
 * (client-scripted-browser.js). This one runs the real page, JavaScript and
 * all, right here — so text is real text, video is real video, and scrolling
 * runs at this screen's refresh rate — while every byte it loads still comes
 * from the PC.
 *
 * Scramjet itself lives in an iframe on a *separate origin* (the browse site,
 * public-browse/), never on this one: pages it proxies run their scripts on
 * whatever origin hosts it, and this origin holds the sign-in that controls
 * the PC. That shell has no network of its own. It is handed one MessagePort
 * at start-up, and everything Scramjet fetches or opens comes down that port
 * to here, where it is carried over the fast lane (fetch-tunnel.js) to the PC.
 *
 * So the one thing this module does, besides driving the URL bar and the tab
 * strip, is relay: port ↔ fast lane, for requests and for WebSockets.
 *
 * The tabs themselves live in the shell — each is a Scramjet frame there, so
 * a page that opens a window (a sign-in popup, a target="_blank" link) gets a
 * real sibling tab it can talk to. The shell reports the list; this module
 * draws it above the URL bar and sends back what gets clicked.
 */
import { normaliseUrl } from './client-browser.js';
import { el } from './ui.js';

const HANDSHAKE_READY = 'proxvocx-browse-ready';
const HANDSHAKE_INIT = 'proxvocx-browse-init';
const SHELL_TIMEOUT_MS = 20_000;

export function createNativeBrowserViewer({
  getMachineId, transport, browseOrigin, elements, onStatus, onUnavailable, onNotice,
}) {
  const { stage, overlay, overlayTitle, overlayMessage, urlInput, urlLock, loadBar,
          backBtn, forwardBtn, tabList } = elements;
  const blankOverlay = { title: overlayTitle.textContent, message: overlayMessage.textContent };

  let frame = null;
  let port = null;
  let shellReady = null;
  let onWindowMessage = null;
  /** Relayed sockets, by the shell's id. */
  const sockets = new Map();
  /** Relayed requests in flight, by the shell's id, so a reset can abort them. */
  const inFlight = new Map();
  /** The shell's last word on its tabs. Empty until it has one open. */
  let tabState = { tabs: [], active: null };
  /** The address last put in the URL bar, so a title change alone leaves what is being typed there. */
  let shownUrl = null;

  /* ── the shell ──────────────────────────────────────────────── */

  function ensureShell() {
    if (shellReady) return shellReady;
    shellReady = new Promise((resolve, reject) => {
      frame = document.createElement('iframe');
      frame.className = 'browser-frame browser-frame--native';
      frame.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write; encrypted-media; picture-in-picture');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = 'Web page';

      const timer = setTimeout(() => reject(new Error(
        `The browse site at ${browseOrigin} did not load. Has it been deployed? (See the README.)`,
      )), SHELL_TIMEOUT_MS);

      onWindowMessage = (event) => {
        // The shell announces itself; only that exact frame, from that exact
        // origin, is given the port.
        if (event.origin !== browseOrigin || event.source !== frame?.contentWindow) return;
        if (event.data?.type !== HANDSHAKE_READY) return;
        // One handshake per shell. Anything running in the shell's origin can
        // post as the shell (a proxied page that escaped Scramjet included);
        // a second "ready" must not be able to swap the port out.
        if (port) return;
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessage = (portEvent) => onShellMessage(portEvent.data || {}, { resolve, reject, timer });
        frame.contentWindow.postMessage({ type: HANDSHAKE_INIT }, browseOrigin, [channel.port2]);
      };
      window.addEventListener('message', onWindowMessage);

      // The shell announces itself while it loads, before the frame's load
      // event. A frame that finishes loading and has still said nothing is an
      // error page (site not deployed, or unreachable) — no need to sit out
      // the full timeout to know that.
      let announced = false;
      const markAnnounced = (event) => {
        if (event.source === frame?.contentWindow && event.data?.type === HANDSHAKE_READY) announced = true;
      };
      window.addEventListener('message', markAnnounced);
      frame.addEventListener('load', () => {
        setTimeout(() => {
          window.removeEventListener('message', markAnnounced);
          if (!announced) {
            clearTimeout(timer);
            reject(new Error(`The browse site at ${browseOrigin} did not respond. Has it been deployed? (See the README.)`));
          }
        }, 4000);
      }, { once: true });

      frame.src = `${browseOrigin}/`;
      stage.append(frame);
    });
    shellReady.catch(() => { shellReady = null; });
    return shellReady;
  }

  function onShellMessage(message, startup) {
    switch (message.t) {
      case 'ready':
        clearTimeout(startup.timer);
        startup.resolve();
        return;
      case 'error':
        clearTimeout(startup.timer);
        startup.reject(new Error(message.message || 'The native engine failed to start.'));
        showOverlay('The native engine hit a problem', message.message || '');
        finishLoading();
        return;
      case 'nav':
        // The active tab changed, or its address or title did. A tab with no
        // address is a new, empty one.
        if (!message.url) {
          showBlank();
          return;
        }
        if (message.url !== shownUrl) {
          shownUrl = message.url;
          urlInput.value = message.url;
          setLock(message.url);
        }
        overlay.hidden = true;
        stage.dataset.state = 'ready';
        onStatus?.({ text: message.title || hostOf(message.url) || 'Ready' });
        return;
      case 'loading':
        if (message.loading) startLoading(); else finishLoading();
        return;
      case 'tabs':
        tabState = { tabs: Array.isArray(message.tabs) ? message.tabs : [], active: message.active };
        if (!tabState.tabs.length) showBlank();
        renderTabs();
        return;
      case 'notice':
        if (message.message) onNotice?.(String(message.message));
        return;
      case 'fetch': relayFetch(message); return;
      case 'ws-open': relaySocketOpen(message); return;
      case 'ws-send': sockets.get(message.id)?.send(message.data); return;
      case 'ws-close': sockets.get(message.id)?.close(message.code, message.reason); return;
      default:
    }
  }

  /* ── relaying ───────────────────────────────────────────────── */

  async function relayFetch({ id, url, method, headers, body }) {
    const controller = new AbortController();
    inFlight.set(id, controller);
    try {
      const response = await transport.native.request(
        { url, method, headers, body },
        { signal: controller.signal },
      );
      port?.postMessage({
        t: 'fetched',
        id,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: response.body,
      }, [response.body]);
    } catch (err) {
      port?.postMessage({ t: 'fetch-error', id, message: err?.message || 'Failed to fetch' });
    } finally {
      inFlight.delete(id);
    }
  }

  function relaySocketOpen({ id, url, protocols, headers }) {
    const post = (payload) => port?.postMessage({ t: 'ws-event', id, ...payload },
      payload.data instanceof ArrayBuffer ? [payload.data] : []);
    const socket = transport.native.socket({ url, protocols, headers }, {
      onopen: (protocol) => post({ type: 'open', protocol }),
      onmessage: (data) => post({ type: 'message', data }),
      onerror: (message) => post({ type: 'error', message }),
      onclose: (code, reason) => {
        sockets.delete(id);
        post({ type: 'close', code, reason });
      },
    });
    sockets.set(id, socket);
  }

  /* ── navigation (the surface client.js drives) ──────────────── */

  async function go(rawUrl) {
    const machineId = getMachineId();
    if (!machineId) {
      showOverlay('No PC selected', 'Pick a PC to browse through first.');
      return;
    }
    const url = normaliseUrl(rawUrl);
    if (!url) {
      showOverlay('That is not a URL', 'Try something like example.com, or type a search.');
      return;
    }
    urlInput.value = url;
    shownUrl = url;
    setLock(url);
    startLoading();
    onStatus?.({ text: `Connecting to ${hostOf(url)}…` });

    const lane = await transport.native.ready(machineId);
    if (!lane.ok) {
      finishLoading();
      onUnavailable?.(lane.reason, url);
      return;
    }
    try {
      await ensureShell();
    } catch (err) {
      finishLoading();
      showOverlay('The native engine could not start', err.message);
      onUnavailable?.('shell', url);
      return;
    }
    port.postMessage({ t: 'go', url });
    updateNavButtons();
  }

  const command = (t) => () => port?.postMessage({ t });

  /**
   * A new, empty tab. Before the shell is up there is only the one tab this
   * page shows, and it is already empty or about to be used; after, the shell
   * opens it and reports back.
   */
  function newTab() {
    if (port) port.postMessage({ t: 'tab-new' });
    else showBlank();
    urlInput.focus();
  }

  function reset() {
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    for (const socket of sockets.values()) socket.close(1001, '');
    sockets.clear();
    if (onWindowMessage) window.removeEventListener('message', onWindowMessage);
    onWindowMessage = null;
    try { port?.close(); } catch { /* already closed */ }
    port = null;
    frame?.remove();
    frame = null;
    shellReady = null;
    stage.dataset.state = 'empty';
    tabState = { tabs: [], active: null };
    shownUrl = null;
    renderTabs();
  }

  /* ── tab strip ──────────────────────────────────────────────── */

  function renderTabs() {
    if (!tabList) return;
    const list = tabState.tabs.length
      ? tabState.tabs
      : [{ id: null, url: '', title: '', loading: false }];
    // Redrawn whole on every report (titles change under it), so keyboard
    // focus on a tab has to be carried across.
    const focused = tabList.contains(document.activeElement)
      ? { id: document.activeElement.closest('.tab')?.dataset.id, part: document.activeElement.className }
      : null;
    tabList.replaceChildren(...list.map((tab) => {
      const active = tab.id === tabState.active || tab.id == null;
      const label = tab.title || (tab.url && tab.url !== 'about:blank' ? hostOf(tab.url) : 'New tab');
      const select = () => { if (tab.id != null && !active) port?.postMessage({ t: 'tab-select', id: tab.id }); };
      const close = () => { if (tab.id != null) port?.postMessage({ t: 'tab-close', id: tab.id }); };
      return el('div', {
        class: `tab${active ? ' active' : ''}${tab.loading ? ' loading' : ''}`,
        dataset: { id: String(tab.id) },
        title: tab.url && tab.url !== label ? `${label}\n${tab.url}` : label,
        // Middle-click closes, as it does in a browser.
        onAuxclick: (event) => { if (event.button === 1) { event.preventDefault(); close(); } },
        onMousedown: (event) => { if (event.button === 1) event.preventDefault(); },
      },
        el('button', {
          class: 'tab-main', role: 'tab', 'aria-selected': String(active), onClick: select,
        },
          el('span', { class: 'tab-icon', 'aria-hidden': 'true' }, initialOf(tab)),
          el('span', { class: 'tab-title' }, label),
        ),
        tab.id == null ? null : el('button', {
          class: 'tab-close', title: 'Close tab', 'aria-label': `Close ${label}`, onClick: close,
        }, '×'),
      );
    }));
    if (focused) tabList.querySelector(`.tab[data-id="${focused.id}"] .${focused.part}`)?.focus();

    // Keep the active tab in view. Not scrollIntoView: that scrolls every
    // ancestor too, and the page has no business moving for this.
    const current = tabList.querySelector('.tab.active');
    if (current) {
      const { offsetLeft: left, offsetWidth: width } = current;
      if (left < tabList.scrollLeft) tabList.scrollLeft = left;
      else if (left + width > tabList.scrollLeft + tabList.clientWidth) tabList.scrollLeft = left + width - tabList.clientWidth;
    }
  }

  /* ── chrome ─────────────────────────────────────────────────── */

  /** The empty-tab page: the start screen, with the URL bar cleared for typing. */
  function showBlank() {
    overlayTitle.textContent = blankOverlay.title;
    overlayMessage.textContent = blankOverlay.message;
    overlay.hidden = false;
    stage.dataset.state = 'empty';
    shownUrl = '';
    urlInput.value = '';
    setLock('');
    onStatus?.({ text: 'New tab' });
  }

  function updateNavButtons() {
    // Scramjet keeps the page's real history inside the shell; there is no
    // cheap way to ask it how deep that is, so both stay available.
    backBtn.disabled = !port;
    forwardBtn.disabled = !port;
  }

  function showOverlay(title, message) {
    overlayTitle.textContent = title;
    overlayMessage.textContent = message;
    overlay.hidden = false;
    stage.dataset.state = 'empty';
  }

  function startLoading() {
    loadBar.style.opacity = '1';
    loadBar.style.width = '18%';
    requestAnimationFrame(() => { loadBar.style.width = '72%'; });
  }

  function finishLoading() {
    loadBar.style.width = '100%';
    setTimeout(() => { loadBar.style.opacity = '0'; loadBar.style.width = '0'; }, 260);
  }

  function setLock(url) {
    try { urlLock.classList.toggle('secure', new URL(url).protocol === 'https:'); }
    catch { urlLock.classList.remove('secure'); }
  }

  renderTabs();

  return {
    go,
    newTab,
    back: command('back'),
    forward: command('forward'),
    reload: command('reload'),
    reset,
    get current() { return urlInput.value || null; },
  };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url || ''; }
}

/** A tab's stand-in for a favicon: the first letter of its site. */
function initialOf(tab) {
  let host = '';
  try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch { /* blank tab */ }
  return (host || tab.title || '+').slice(0, 1).toUpperCase();
}

/**
 * Where the browse site lives, or null when there is none to use.
 *
 * In order: an override saved in this browser (for local development), the
 * one set in firebase-config.js, then the convention the README sets up — a
 * second Hosting site named after this one plus "-browse". Never this page's
 * own origin: the whole point of the browse site is that it is not this one.
 */
export function resolveBrowseOrigin(configured) {
  const candidates = [];
  try { candidates.push(localStorage.getItem('proxvocx.browseOrigin')); } catch { /* private mode */ }
  candidates.push(configured);
  const hosted = /^([a-z0-9-]+)\.(web\.app|firebaseapp\.com)$/i.exec(location.hostname);
  if (hosted) candidates.push(`https://${hosted[1]}-browse.web.app`);

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const origin = new URL(candidate).origin;
      if (origin !== location.origin && /^https?:$/.test(new URL(origin).protocol)) return origin;
    } catch { /* not a URL */ }
  }
  return null;
}
