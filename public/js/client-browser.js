/**
 * Browser mode: a mini browser whose network stack is the PC.
 *
 * Every byte on screen was fetched by the connector and carried back through
 * Firebase. The rendered document lives in a sandboxed iframe *without*
 * `allow-scripts`, so nothing from the remote site ever executes here. That
 * costs us dynamic pages, and buys a viewer that cannot be attacked by what
 * it renders.
 *
 * Because the iframe is `srcdoc` + `allow-same-origin`, it inherits this
 * origin and the parent can reach into its document — which is how navigation
 * is driven without giving the page any script of its own.
 */
import { proxyRequest, ProxyError, responseText, responseDataUrl, responseKind } from './proxy-client.js';
import { formatBytes } from './ui.js';

/** Subresources are individually proxied; keep a lid on the round trips. */
const MAX_SUBRESOURCES = 40;
const SUBRESOURCE_CONCURRENCY = 6;

/**
 * `request` is injectable so the rewriting pipeline can be exercised without a
 * live PC on the other end; it defaults to the real Firebase round trip.
 */
export function createMiniBrowser({ db, getMachineId, elements, onStatus, request }) {
  const { frame, stage, overlay, overlayTitle, overlayMessage, urlInput, urlLock, loadBar,
          backBtn, forwardBtn } = elements;

  const fetchPage = request || ((machineId, spec, options) =>
    proxyRequest(db, machineId, spec, options));

  const history = [];
  let cursor = -1;
  let inFlight = null;
  let objectUrls = [];

  /* ── navigation ────────────────────────────────────────────── */

  async function go(rawUrl, { pushHistory = true } = {}) {
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

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    urlInput.value = url;
    setLock(url);
    startLoading();
    onStatus?.({ text: `Fetching ${hostOf(url)}…` });

    const started = performance.now();
    try {
      const response = await fetchPage(machineId, {
        url,
        method: 'GET',
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': navigator.language || 'en',
        },
      }, { signal: controller.signal });

      if (controller.signal.aborted) return;

      const ms = Math.round(performance.now() - started);
      const finalUrl = response.url || url;

      if (pushHistory) {
        history.splice(cursor + 1);
        history.push(finalUrl);
        cursor = history.length - 1;
      }
      urlInput.value = finalUrl;
      setLock(finalUrl);

      await render(response, finalUrl);

      onStatus?.({
        text: `${response.status} ${response.statusText || ''}`.trim(),
        bytes: response.bytes,
        ms,
        truncated: response.truncated,
      });
      finishLoading();
      updateNavButtons();
    } catch (err) {
      if (controller.signal.aborted) return;
      finishLoading();
      if (err instanceof ProxyError) {
        showOverlay(titleForProxyError(err), err.message);
      } else {
        showOverlay('Could not load that page', err.message);
      }
      onStatus?.({ text: 'Failed' });
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  /* ── rendering ─────────────────────────────────────────────── */

  async function render(response, finalUrl) {
    releaseObjectUrls();
    const kind = responseKind(response);

    if (kind === 'image') {
      await writeDocument(imageShell(responseDataUrl(response), finalUrl));
      stage.dataset.state = 'ready';
      return;
    }
    if (kind === 'text' || kind === 'binary' || kind === 'pdf') {
      await writeDocument(plainShell(kind === 'binary'
        ? `${response.contentType || 'binary'} · ${formatBytes(response.bytes)} — not renderable here.`
        : responseText(response)));
      stage.dataset.state = 'ready';
      return;
    }

    const html = responseText(response);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const subresources = prepareDocument(doc, finalUrl);

    const live = await writeDocument(`<!doctype html>${doc.documentElement.outerHTML}`);
    stage.dataset.state = 'ready';

    attachInterceptors(finalUrl, live);
    // Deliberately not awaited: the page is readable before its images land.
    hydrateSubresources(subresources, live).catch(() => {});
  }

  /**
   * Strips anything executable, absolutises every URL against the page's real
   * address, and tags the resources worth fetching through the proxy.
   */
  function prepareDocument(doc, baseUrl) {
    for (const node of doc.querySelectorAll('script, noscript, object, embed, applet')) {
      node.remove();
    }
    // A <base> would re-relativise everything we are about to rewrite.
    for (const node of doc.querySelectorAll('base')) node.remove();

    const pending = [];

    const absolutise = (node, attr) => {
      const raw = node.getAttribute(attr);
      if (!raw) return null;
      const resolved = resolve(raw, baseUrl);
      if (!resolved) { node.removeAttribute(attr); return null; }
      node.setAttribute(attr, resolved);
      return resolved;
    };

    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = absolutise(anchor, 'href');
      if (href) {
        anchor.dataset.proxyHref = href;
        anchor.setAttribute('href', href);
      }
      anchor.removeAttribute('target');
    }

    for (const form of doc.querySelectorAll('form')) {
      const action = form.getAttribute('action');
      form.setAttribute('action', resolve(action || '', baseUrl) || baseUrl);
    }

    for (const img of doc.querySelectorAll('img[src], img[data-src]')) {
      const src = absolutise(img, 'src') || absolutise(img, 'data-src');
      img.removeAttribute('srcset');
      img.removeAttribute('loading');
      if (src && pending.length < MAX_SUBRESOURCES) {
        img.dataset.proxySrc = src;
        img.removeAttribute('src');
        pending.push({ kind: 'image', url: src });
      } else {
        img.removeAttribute('src');
      }
    }

    for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
      const href = absolutise(link, 'href');
      if (href && pending.length < MAX_SUBRESOURCES) {
        link.dataset.proxyStyle = href;
        link.removeAttribute('href');
        pending.push({ kind: 'style', url: href });
      } else {
        link.remove();
      }
    }

    for (const node of doc.querySelectorAll('link[rel~="preload"], link[rel~="prefetch"], link[rel~="modulepreload"]')) {
      node.remove();
    }
    for (const frameNode of doc.querySelectorAll('iframe, frame')) frameNode.remove();

    // Inline styles can still reach out for fonts and images; neutralise the
    // remote references so the page does not leak this device's IP.
    for (const style of doc.querySelectorAll('style')) {
      style.textContent = neutraliseCss(style.textContent);
    }

    doc.head?.prepend(viewportMeta(doc));
    doc.head?.prepend(baseStyles(doc));
    return pending;
  }

  /** Pulls the tagged images and stylesheets through the proxy, in a pool. */
  async function hydrateSubresources(pending, doc) {
    const machineId = getMachineId();
    if (!machineId || !pending.length || !doc) return;

    let index = 0;
    const worker = async () => {
      while (index < pending.length) {
        const item = pending[index];
        index += 1;
        try {
          const response = await fetchPage(machineId, {
            url: item.url,
            method: 'GET',
            headers: { accept: item.kind === 'style' ? 'text/css,*/*;q=0.1' : 'image/*,*/*;q=0.8' },
          }, { timeoutMs: 25_000 });

          if (frame.contentDocument !== doc) return; // navigated away

          if (item.kind === 'image') {
            for (const img of doc.querySelectorAll(`img[data-proxy-src="${cssEscape(item.url)}"]`)) {
              img.src = responseDataUrl(response);
            }
          } else {
            for (const link of doc.querySelectorAll(`link[data-proxy-style="${cssEscape(item.url)}"]`)) {
              const style = doc.createElement('style');
              style.textContent = neutraliseCss(responseText(response));
              link.replaceWith(style);
            }
          }
        } catch {
          /* One dead subresource should never take the page down. */
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(SUBRESOURCE_CONCURRENCY, pending.length) }, worker),
    );
  }

  /* ── in-frame interception ─────────────────────────────────── */

  function attachInterceptors(baseUrl, doc) {
    if (!doc) return;

    doc.addEventListener('click', (event) => {
      const anchor = event.target?.closest?.('a[href]');
      if (!anchor) return;
      event.preventDefault();
      const href = anchor.dataset.proxyHref || anchor.getAttribute('href');
      if (!href) return;
      if (href.startsWith('#')) return;
      go(href);
    }, true);

    // `allow-forms` lets the browser fire submit; we cancel it and replay the
    // submission through the proxy instead.
    doc.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.target;
      if (!(form instanceof doc.defaultView.HTMLFormElement)) return;
      submitForm(form, baseUrl);
    }, true);

    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target?.form) {
        event.preventDefault();
        submitForm(event.target.form, baseUrl);
      }
    }, true);
  }

  async function submitForm(form, baseUrl) {
    const machineId = getMachineId();
    if (!machineId) return;

    const method = (form.getAttribute('method') || 'GET').toUpperCase();
    const action = resolve(form.getAttribute('action') || '', baseUrl) || baseUrl;
    const data = new FormData(form);

    if (method === 'GET') {
      const target = new URL(action);
      for (const [key, value] of data.entries()) {
        if (typeof value === 'string') target.searchParams.set(key, value);
      }
      go(target.toString());
      return;
    }

    const body = new URLSearchParams();
    for (const [key, value] of data.entries()) {
      if (typeof value === 'string') body.append(key, value);
    }

    startLoading();
    onStatus?.({ text: `Submitting to ${hostOf(action)}…` });
    try {
      const response = await fetchPage(machineId, {
        url: action,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const finalUrl = response.url || action;
      history.splice(cursor + 1);
      history.push(finalUrl);
      cursor = history.length - 1;
      urlInput.value = finalUrl;
      setLock(finalUrl);
      await render(response, finalUrl);
      onStatus?.({ text: `${response.status}`, bytes: response.bytes });
      updateNavButtons();
    } catch (err) {
      showOverlay('The form could not be submitted', err.message);
    } finally {
      finishLoading();
    }
  }

  /* ── frame plumbing ────────────────────────────────────────── */

  /**
   * Assigning `srcdoc` swaps the document asynchronously, so anything that
   * reaches into `contentDocument` has to wait for the load event or it will
   * be talking to the page we just navigated away from.
   */
  function writeDocument(html) {
    overlay.hidden = true;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        frame.removeEventListener('load', done);
        resolve(frame.contentDocument);
      };
      // A document that somehow never fires load must not hang navigation.
      const timer = setTimeout(done, 3000);
      frame.addEventListener('load', done, { once: true });
      frame.srcdoc = html;
    });
  }

  function showOverlay(title, message) {
    overlayTitle.textContent = title;
    overlayMessage.textContent = message;
    overlay.hidden = false;
    stage.dataset.state = 'empty';
  }

  function releaseObjectUrls() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
  }

  function startLoading() {
    stage.dataset.state = 'loading';
    loadBar.style.opacity = '1';
    loadBar.style.width = '18%';
    requestAnimationFrame(() => { loadBar.style.width = '72%'; });
  }

  function finishLoading() {
    loadBar.style.width = '100%';
    setTimeout(() => {
      loadBar.style.opacity = '0';
      loadBar.style.width = '0';
    }, 260);
  }

  function updateNavButtons() {
    backBtn.disabled = cursor <= 0;
    forwardBtn.disabled = cursor >= history.length - 1;
  }

  function setLock(url) {
    try {
      urlLock.classList.toggle('secure', new URL(url).protocol === 'https:');
    } catch {
      urlLock.classList.remove('secure');
    }
  }

  /* ── public surface ────────────────────────────────────────── */

  return {
    go,
    back() {
      if (cursor <= 0) return;
      cursor -= 1;
      go(history[cursor], { pushHistory: false });
    },
    forward() {
      if (cursor >= history.length - 1) return;
      cursor += 1;
      go(history[cursor], { pushHistory: false });
    },
    reload() {
      if (cursor >= 0) go(history[cursor], { pushHistory: false });
    },
    reset() {
      inFlight?.abort();
      releaseObjectUrls();
      history.length = 0;
      cursor = -1;
      frame.srcdoc = '';
      urlInput.value = '';
      updateNavButtons();
      showOverlay(
        'Browse through your PC',
        'Pages are fetched by the connector on your PC and handed back through ' +
        'Firebase. Nothing on this device talks to the site directly.',
      );
    },
    get current() { return history[cursor] || null; },
  };
}

/* ── helpers ─────────────────────────────────────────────────── */

/** Accepts a bare host, a full URL, or a search phrase. */
export function normaliseUrl(input) {
  const raw = (input || '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try { return new URL(raw).toString(); } catch { return null; }
  }
  // Anything with a dot and no spaces is treated as a hostname.
  if (/^[^\s/]+\.[^\s/]{2,}(\/|$|\?)/.test(raw)) {
    try { return new URL(`https://${raw}`).toString(); } catch { /* fall through */ }
  }
  if (/^localhost(:\d+)?(\/|$)/i.test(raw)) return `http://${raw}`;

  return `https://duckduckgo.com/html/?q=${encodeURIComponent(raw)}`;
}

function resolve(href, baseUrl) {
  if (!href) return null;
  const trimmed = href.trim();
  if (/^(javascript|data|blob|about|mailto|tel):/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Removes remote fetches from CSS so the page cannot phone home. Background
 * images and web fonts would each need their own proxy round trip, which is
 * not worth it — the declarations are kept valid but inert.
 */
function neutraliseCss(css) {
  if (!css) return '';
  return css
    .replace(/@import[^;]+;/gi, '')
    .replace(/url\(\s*['"]?(?!data:)[^)'"]+['"]?\s*\)/gi, 'url("")');
}

function viewportMeta(doc) {
  const meta = doc.createElement('meta');
  meta.setAttribute('name', 'viewport');
  meta.setAttribute('content', 'width=device-width, initial-scale=1');
  return meta;
}

function baseStyles(doc) {
  const style = doc.createElement('style');
  style.textContent = `
    html { -webkit-text-size-adjust: 100%; }
    img[data-proxy-src]:not([src]) {
      background: repeating-linear-gradient(45deg, #eee, #eee 6px, #f6f6f6 6px, #f6f6f6 12px);
      min-height: 12px;
    }
  `;
  return style;
}

function imageShell(dataUrl, title) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#16161a}
img{max-width:100%;max-height:100%;object-fit:contain}</style>
<img src="${escapeAttr(dataUrl)}" alt="${escapeAttr(title)}">`;
}

function plainShell(text) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:16px;background:#16161a;color:#f0f0f0;
font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}</style>
<body>${escapeHtml(text)}</body>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}
function escapeAttr(value) {
  return String(value).replace(/["&<>]/g, (ch) =>
    ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}
function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}
function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function titleForProxyError(err) {
  switch (err.code) {
    case 'ERR_TIMEOUT': return 'The PC did not answer';
    case 'ERR_URL_REJECTED': return 'That address was refused';
    case 'ERR_UNREACHABLE': return 'The site could not be reached';
    case 'ERR_NO_HOST': return 'The PC cannot fetch pages';
    case 'ERR_PERMISSION': return 'This PC is not yours to use';
    case 'ERR_STALE': return 'That request went stale';
    default: return 'Could not load that page';
  }
}
