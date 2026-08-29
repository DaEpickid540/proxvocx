/**
 * PC Control mode: the viewer.
 *
 * Creates a session under the machine, answers the connector's WebRTC offer,
 * and paints the incoming screen into a <video>. Once the pointer is inside
 * the picture, mouse and keyboard are translated into the compact wire format
 * in `input-protocol.js` and pushed down the data channel.
 *
 * Keyboard capture is explicit — you click into the video to take it and press
 * Escape to give it back — because otherwise the browser's own shortcuts and
 * the PC's would fight over every keystroke.
 */
import { ref, set, update } from './firebase.js';
import { paths } from './paths.js';
import { iceServers, attachIce, createSession, closeSession, waitForDescription } from './signaling.js';
import {
  INPUT_CHANNEL, pointer, pointerRel, wheel, key, text as textEvent, clipboard as clipboardEvent,
  buttonFromEvent, setFps, switchDisplay,
} from './input-protocol.js';

const HIDE_HINT_KEY = 'proxvocx.hideEscHint';

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function createControlViewer({ db, uid, getMachineId, elements, onState }) {
  const { stage, video, overlay, overlayTitle, overlayMessage, connectBtn, hint } = elements;

  let pc = null;
  let channel = null;
  let sessionId = null;
  let detachIce = null;
  let statsTimer = null;
  let captured = false;
  let mouseLocked = false;
  // Chromium reports one garbage movementX/Y — sometimes a huge one — on the
  // very first pointermove after a lock is acquired, and again after
  // alt-tabbing back into an already-locked window. Left alone that single
  // event reads as a violent flick and can spin a game's camera all the way
  // around on its own; the fix is just to throw that one event away.
  let skipNextMove = false;
  let hostAllowsInput = false;
  let screen = { width: 1920, height: 1080 };
  let sources = [];
  let lastMoveSent = 0;
  // Deltas arriving faster than the ~120Hz send ceiling used to be dropped
  // outright rather than folded into the next send. That is harmless for an
  // absolute position — the final position after a burst is still correct —
  // but for a relative delta a dropped event is motion that never happened,
  // and dropping them under a fast flick (exactly when aim precision in a
  // game matters most) is what made the cursor feel like it was fighting
  // back. Accumulated here and flushed as one event instead.
  let pendingDX = 0;
  let pendingDY = 0;
  const MAX_REL_DELTA = 350; // px/event — clamps any other single-event outlier

  /* ── connect ───────────────────────────────────────────────── */

  async function connect() {
    const machineId = getMachineId();
    if (!machineId) {
      showOverlay('No PC selected', 'Pick a PC to control first.', true);
      return;
    }
    if (pc) return;

    showOverlay('Connecting…', 'Waiting for the PC to offer its screen.', false);
    stage.dataset.state = 'connecting';
    onState?.({ connected: false, status: 'connecting' });

    try {
      sessionId = await createSession(db, machineId, uid, 'control');

      const offer = await waitForDescription(db, paths.sessionOffer(machineId, sessionId), 30_000);
      screen = offer.screen || screen;
      hostAllowsInput = !!offer.capabilities?.input;
      sources = offer.sources || [];

      pc = new RTCPeerConnection({ iceServers: iceServers() });
      detachIce = attachIce(db, machineId, sessionId, pc, 'viewer');

      pc.addEventListener('track', (event) => {
        video.srcObject = event.streams[0];
        video.play().catch(() => {
          /* Autoplay is allowed because the element is muted; ignore races. */
        });
      });

      pc.addEventListener('datachannel', (event) => {
        if (event.channel.label !== INPUT_CHANNEL) return;
        channel = event.channel;
        channel.addEventListener('close', () => { channel = null; });
      });

      pc.addEventListener('connectionstatechange', () => {
        const st = pc?.connectionState;
        if (st === 'connected') {
          overlay.hidden = true;
          stage.dataset.state = 'live';
          onState?.({
            connected: true,
            status: 'connected',
            canInput: hostAllowsInput,
            screen,
            sources,
          });
          startStats();
        } else if (['failed', 'closed', 'disconnected'].includes(st)) {
          disconnect(st === 'failed'
            ? 'The peer connection failed. The PC may be behind a network that needs a TURN relay.'
            : 'The PC ended the session.');
        }
      });

      await pc.setRemoteDescription(new RTCSessionDescription({ type: offer.type, sdp: offer.sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await set(ref(db, paths.sessionAnswer(machineId, sessionId)), {
        type: answer.type,
        sdp: answer.sdp,
      });
      await update(ref(db, paths.session(machineId, sessionId)), { state: 'answered' });
    } catch (err) {
      await teardown();
      showOverlay('Could not connect', err.message, true);
      onState?.({ connected: false, status: 'failed' });
    }
  }

  /* ── disconnect ────────────────────────────────────────────── */

  async function disconnect(why = 'Session ended.') {
    const wasLive = !!pc;
    await teardown();
    if (wasLive) {
      showOverlay('Disconnected', why, true);
      onState?.({ connected: false, status: 'idle' });
    }
  }

  async function teardown() {
    releaseKeyboard();
    clearInterval(statsTimer);
    statsTimer = null;
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
    sources = [];
    stage.dataset.state = 'idle';
  }

  /* ── sending input ─────────────────────────────────────────── */

  /** Raw send, gated only on the channel — used for view-only-safe messages
   *  like a frame-rate or display change, which are not OS input. */
  const sendConfig = (event) => {
    if (!channel || channel.readyState !== 'open') return;
    try {
      channel.send(JSON.stringify(event));
    } catch {
      /* Buffer full — dropping a move frame is better than blocking. */
    }
  };

  const send = (event) => {
    if (!hostAllowsInput) return;
    sendConfig(event);
  };

  /**
   * Maps a pointer position inside the letterboxed <video> onto 0..1 of the
   * remote screen. `object-fit` means the picture rarely fills the element,
   * so the empty bars have to be subtracted or the cursor drifts.
   */
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
      if (mouseLocked) {
        if (skipNextMove) {
          skipNextMove = false;
          return;
        }
        const dx = clamp(event.movementX, -MAX_REL_DELTA, MAX_REL_DELTA);
        const dy = clamp(event.movementY, -MAX_REL_DELTA, MAX_REL_DELTA);
        pendingDX += dx;
        pendingDY += dy;

        // ~120Hz ceiling: a trackpad can fire far faster than the PC can
        // replay. Only the SEND is throttled — the deltas above still
        // accumulate every frame, so nothing throttled away is lost, just
        // batched into the next one.
        const now = performance.now();
        if (now - lastMoveSent < 8) return;
        lastMoveSent = now;
        if (!pendingDX && !pendingDY) return;
        send(pointerRel(pendingDX, pendingDY));
        pendingDX = 0;
        pendingDY = 0;
        return;
      }

      const now = performance.now();
      if (now - lastMoveSent < 8) return;
      const point = toScreenPoint(event);
      if (!point.inside) return;
      lastMoveSent = now;
      send(pointer('move', point.x, point.y));
    });

    video.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      captureKeyboard();
      if (mouseLocked) {
        send(pointer('down', 0, 0, buttonFromEvent(event), true));
        return;
      }
      const point = toScreenPoint(event);
      if (!point.inside) return;
      send(pointer('down', point.x, point.y, buttonFromEvent(event)));
    });

    video.addEventListener('pointerup', (event) => {
      event.preventDefault();
      if (mouseLocked) {
        send(pointer('up', 0, 0, buttonFromEvent(event), true));
        return;
      }
      const point = toScreenPoint(event);
      if (!point.inside) return;
      send(pointer('up', point.x, point.y, buttonFromEvent(event)));
    });

    video.addEventListener('dblclick', (event) => {
      const point = toScreenPoint(event);
      if (point.inside) send(pointer('dblclick', point.x, point.y, buttonFromEvent(event)));
    });

    // The remote desktop has its own context menu; never show the browser's.
    video.addEventListener('contextmenu', (event) => event.preventDefault());

    video.addEventListener('wheel', (event) => {
      const point = toScreenPoint(event);
      if (!point.inside) return;
      event.preventDefault();
      send(wheel(point.x, point.y, event.deltaX, event.deltaY));
    }, { passive: false });

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    video.addEventListener('blur', releaseKeyboard);

    video.addEventListener('paste', (event) => {
      const value = event.clipboardData?.getData('text');
      if (value) send(textEvent(value));
    });

    // The browser can drop pointer lock on its own (Escape, alt-tab, an
    // extension) — mirror that back into our own state either way.
    document.addEventListener('pointerlockchange', () => {
      const nowLocked = document.pointerLockElement === video;
      if (nowLocked && !mouseLocked) {
        skipNextMove = true;
        pendingDX = 0;
        pendingDY = 0;
      }
      mouseLocked = nowLocked;
      stage.classList.toggle('mouse-locked', mouseLocked);
      onState?.({ connected: !!pc, status: pc ? 'connected' : 'idle', canInput: hostAllowsInput, screen, sources, mouseLocked });
    });

    // The same garbage-first-delta quirk shows up again after alt-tabbing
    // back into a window whose lock never actually released — no
    // pointerlockchange fires for that, since the lock state did not change.
    window.addEventListener('focus', () => {
      if (mouseLocked) skipNextMove = true;
    });
  }

  function onKeyDown(event) {
    if (!captured) return;
    if (event.key === 'Escape') {
      releaseKeyboard();
      event.preventDefault();
      return;
    }
    event.preventDefault();
    send(key('down', event));
  }

  function onKeyUp(event) {
    if (!captured) return;
    event.preventDefault();
    send(key('up', event));
  }

  function hintDismissed() {
    try { return localStorage.getItem(HIDE_HINT_KEY) === '1'; } catch { return false; }
  }

  function captureKeyboard() {
    if (captured || !hostAllowsInput) return;
    captured = true;
    stage.classList.add('captured');
    if (hint) hint.hidden = hintDismissed();
    video.focus();
  }

  function releaseKeyboard() {
    if (document.pointerLockElement === video) document.exitPointerLock();
    if (!captured) return;
    captured = false;
    stage.classList.remove('captured');
    if (hint) hint.hidden = true;
  }

  /* ── stats ─────────────────────────────────────────────────── */

  function startStats() {
    clearInterval(statsTimer);
    statsTimer = setInterval(async () => {
      if (!pc) return;
      try {
        const report = await pc.getStats();
        let rtt = null;
        let fps = null;
        report.forEach((entry) => {
          if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.currentRoundTripTime != null) {
            rtt = Math.round(entry.currentRoundTripTime * 1000);
          }
          if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
            fps = Math.round(entry.framesPerSecond || 0);
          }
        });
        // `sources` and `mouseLocked` have to ride along on every update: this
        // fires every couple of seconds, and onState treats what it is handed
        // as the whole truth — omitting them made the display picker vanish two
        // seconds after connecting.
        onState?.({
          connected: true, status: 'connected', rtt, fps,
          canInput: hostAllowsInput, screen, sources, mouseLocked,
        });
      } catch {
        /* getStats can throw during teardown */
      }
    }, 2000);
  }

  /* ── overlay ───────────────────────────────────────────────── */

  function showOverlay(title, message, showButton) {
    overlayTitle.textContent = title;
    overlayMessage.textContent = message;
    connectBtn.hidden = !showButton;
    overlay.hidden = false;
  }

  bindInput();

  return {
    connect,
    disconnect,
    get connected() { return pc?.connectionState === 'connected'; },
    get canInput() { return hostAllowsInput; },

    /** Ctrl+Alt+Del cannot be typed into a browser — send it as three keys. */
    sendCtrlAltDel() {
      if (!hostAllowsInput) return;
      const chord = [
        { code: 'ControlLeft', k: 'Control' },
        { code: 'AltLeft', k: 'Alt' },
        { code: 'Delete', k: 'Delete' },
      ];
      for (const item of chord) send({ t: 'k', a: 'down', key: item.k, code: item.code, m: 0 });
      for (const item of [...chord].reverse()) send({ t: 'k', a: 'up', key: item.k, code: item.code, m: 0 });
    },

    get sources() { return sources; },
    get mouseLocked() { return mouseLocked; },

    /** Games that use the Pointer Lock API need relative motion, not a cursor
     *  position — this hands the browser's real mouse device to the video. */
    lockMouse() {
      if (!hostAllowsInput) return;
      captureKeyboard();
      video.requestPointerLock?.();
    },
    unlockMouse() {
      if (document.pointerLockElement === video) document.exitPointerLock();
    },

    /** Taps a key not present on the local keyboard — e.g. a Chromebook's
     *  missing function row. `mods` may set ctrl/alt/shift/meta. */
    sendKeyTap(code, keyName, mods = {}) {
      if (!hostAllowsInput) return;
      const synthetic = {
        key: keyName, code,
        ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta,
      };
      send(key('down', synthetic));
      send(key('up', synthetic));
    },

    /** Changes the live capture frame rate without dropping the session. */
    setFrameRate(fps) {
      sendConfig(setFps(fps));
    },

    /** Switches which display the host is capturing without reconnecting. */
    switchDisplay(id) {
      sendConfig(switchDisplay(id));
    },

    dismissHint() {
      try { localStorage.setItem(HIDE_HINT_KEY, '1'); } catch { /* private mode */ }
      if (hint) hint.hidden = true;
    },

    async sendClipboard() {
      if (!hostAllowsInput) return false;
      try {
        const value = await navigator.clipboard.readText();
        if (!value) return false;
        send(clipboardEvent(value));
        return true;
      } catch {
        return false;
      }
    },

    reset() { return disconnect('Switched PC.'); },
  };
}
