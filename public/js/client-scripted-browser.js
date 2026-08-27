/**
 * Browser mode, scripted: a real, JS-enabled browser tab running on the PC,
 * streamed here the same way PC Control streams a desktop. Structurally this
 * mirrors client-control.js closely — same session/offer/answer/ICE dance —
 * but is driven by a URL bar and back/forward buttons instead of a single
 * "connect" button, and the data channel carries navigation commands
 * alongside input: this viewer sends go/back/forward/reload, the host pushes
 * back the real browser's URL, title, and history state after every
 * navigation, since a real page can navigate on its own from a click inside
 * the video, not only from the URL bar.
 *
 * Keyboard capture follows plain DOM focus (`document.activeElement`) rather
 * than a custom click-to-capture flag: Browser mode's URL bar shares the
 * screen with the video, and focus already moves there naturally the moment
 * someone clicks it, so there is no separate state to keep in sync.
 */
import { ref, set, update } from './firebase.js';
import { paths } from './paths.js';
import { iceServers, attachIce, createSession, closeSession, waitForDescription } from './signaling.js';
import {
  INPUT_CHANNEL, pointer, wheel, key, buttonFromEvent,
  navGo, navBack, navForward, navReload,
} from './input-protocol.js';
import { normaliseUrl } from './client-browser.js';

export function createScriptedBrowserViewer({ db, uid, getMachineId, elements, onStatus }) {
  const { video, stage, overlay, overlayTitle, overlayMessage, urlInput, urlLock, loadBar,
          backBtn, forwardBtn } = elements;

  let pc = null;
  let channel = null;
  let sessionId = null;
  let detachIce = null;
  let screen = { width: 1280, height: 800 };
  let lastMoveSent = 0;
  let navStateKnown = false;

  /* ── navigation (the public surface client.js drives) ─────────── */

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

    if (channel?.readyState === 'open') {
      urlInput.value = url;
      startLoading();
      send(navGo(url));
      return;
    }
    await connect(url);
  }

  function back() { if (channel?.readyState === 'open') send(navBack()); }
  function forward() { if (channel?.readyState === 'open') send(navForward()); }
  function reload() { if (channel?.readyState === 'open') send(navReload()); }

  /* ── connect ───────────────────────────────────────────────────── */

  async function connect(url) {
    const machineId = getMachineId();
    showOverlay('Opening a scripted browser tab…', 'The PC is starting a real browser tab for this page.');
    stage.dataset.state = 'connecting';
    startLoading();

    try {
      sessionId = await createSession(db, machineId, uid, 'scripted', { url });

      const offer = await waitForDescription(db, paths.sessionOffer(machineId, sessionId), 30_000);
      screen = offer.screen || screen;

      pc = new RTCPeerConnection({ iceServers: iceServers() });
      detachIce = attachIce(db, machineId, sessionId, pc, 'viewer');

      pc.addEventListener('track', (event) => {
        video.srcObject = event.streams[0];
        video.play().catch(() => {});
      });

      pc.addEventListener('datachannel', (event) => {
        if (event.channel.label !== INPUT_CHANNEL) return;
        channel = event.channel;
        channel.addEventListener('message', onChannelMessage);
        channel.addEventListener('close', () => { channel = null; });
      });

      pc.addEventListener('connectionstatechange', () => {
        const st = pc?.connectionState;
        if (st === 'connected') {
          overlay.hidden = true;
          stage.dataset.state = 'ready';
          finishLoading();
        } else if (['failed', 'closed', 'disconnected'].includes(st)) {
          teardownAndExplain(st === 'failed'
            ? 'The peer connection failed. The PC may be behind a network that needs a TURN relay.'
            : 'The PC ended the session.');
        }
      });

      await pc.setRemoteDescription(new RTCSessionDescription({ type: offer.type, sdp: offer.sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await set(ref(db, paths.sessionAnswer(machineId, sessionId)), { type: answer.type, sdp: answer.sdp });
      await update(ref(db, paths.session(machineId, sessionId)), { state: 'answered' });
    } catch (err) {
      await teardown();
      showOverlay('Could not open a scripted browser tab', err.message);
      finishLoading();
    }
  }

  function onChannelMessage(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.t !== 'ns') return; // only navState travels host → client here

    navStateKnown = true;
    if (data.url) { urlInput.value = data.url; setLock(data.url); }
    backBtn.disabled = !data.canGoBack;
    forwardBtn.disabled = !data.canGoForward;
    if (data.loading) startLoading(); else finishLoading();
    onStatus?.({ text: data.loading ? `Loading ${hostOf(data.url)}…` : (data.title || data.url || 'Ready') });
  }

  /* ── disconnect ────────────────────────────────────────────────── */

  async function teardownAndExplain(why) {
    const was = !!pc;
    await teardown();
    if (was) showOverlay('Disconnected', why);
  }

  async function teardown() {
    detachIce?.();
    detachIce = null;
    try { channel?.close(); } catch { /* already closed */ }
    channel = null;
    try { pc?.close(); } catch { /* already closed */ }
    pc = null;
    if (video.srcObject) {
      for (const track of video.srcObject.getTracks()) track.stop();
      video.srcObject = null;
    }
    const machineId = getMachineId();
    if (machineId && sessionId) await closeSession(db, machineId, sessionId);
    sessionId = null;
    navStateKnown = false;
    stage.dataset.state = 'empty';
  }

  /* ── sending input ─────────────────────────────────────────────── */

  const send = (event) => {
    if (!channel || channel.readyState !== 'open') return;
    try { channel.send(JSON.stringify(event)); } catch { /* buffer full — drop it */ }
  };

  function toScreenPoint(event) {
    const rect = video.getBoundingClientRect();
    const videoRatio = (video.videoWidth || screen.width) / (video.videoHeight || screen.height);
    const boxRatio = rect.width / rect.height;
    let drawWidth = rect.width;
    let drawHeight = rect.height;
    if (boxRatio > videoRatio) drawWidth = rect.height * videoRatio;
    else drawHeight = rect.width / videoRatio;
    const offsetX = (rect.width - drawWidth) / 2;
    const offsetY = (rect.height - drawHeight) / 2;
    const x = (event.clientX - rect.left - offsetX) / drawWidth;
    const y = (event.clientY - rect.top - offsetY) / drawHeight;
    return { x, y, inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
  }

  function bindInput() {
    video.addEventListener('pointermove', (event) => {
      const point = toScreenPoint(event);
      if (!point.inside) return;
      const now = performance.now();
      if (now - lastMoveSent < 8) return;
      lastMoveSent = now;
      send(pointer('move', point.x, point.y));
    });
    video.addEventListener('pointerdown', (event) => {
      const point = toScreenPoint(event);
      if (!point.inside) return;
      event.preventDefault();
      video.focus();
      send(pointer('down', point.x, point.y, buttonFromEvent(event)));
    });
    video.addEventListener('pointerup', (event) => {
      const point = toScreenPoint(event);
      if (!point.inside) return;
      event.preventDefault();
      send(pointer('up', point.x, point.y, buttonFromEvent(event)));
    });
    video.addEventListener('dblclick', (event) => {
      const point = toScreenPoint(event);
      if (point.inside) send(pointer('dblclick', point.x, point.y, buttonFromEvent(event)));
    });
    video.addEventListener('contextmenu', (event) => event.preventDefault());
    video.addEventListener('wheel', (event) => {
      const point = toScreenPoint(event);
      if (!point.inside) return;
      event.preventDefault();
      send(wheel(point.x, point.y, event.deltaX, event.deltaY));
    }, { passive: false });

    // Only forward keystrokes while the video itself has focus — clicking the
    // URL bar moves focus there naturally, which is all that is needed to
    // stop hijacking what someone types into it.
    window.addEventListener('keydown', (event) => {
      if (document.activeElement !== video) return;
      event.preventDefault();
      send(key('down', event));
    }, true);
    window.addEventListener('keyup', (event) => {
      if (document.activeElement !== video) return;
      event.preventDefault();
      send(key('up', event));
    }, true);
  }

  /* ── overlay / loading chrome ─────────────────────────────────── */

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

  function hostOf(url) {
    try { return new URL(url).host; } catch { return url || ''; }
  }

  bindInput();

  return {
    go, back, forward, reload,
    reset: () => teardown(),
    get connected() { return pc?.connectionState === 'connected'; },
    get current() { return urlInput.value || null; },
  };
}
