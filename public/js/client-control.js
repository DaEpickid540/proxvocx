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
  INPUT_CHANNEL, FAST_INPUT_CHANNEL, pointer, pointerRel, wheel, text as textEvent,
  clipboard as clipboardEvent, buttonFromEvent, setFps, switchDisplay, keysUp,
  streamMode as streamModeEvent, setResolution as setResolutionEvent, modifierMask,
} from './input-protocol.js';
import { loadRemap, resolveKey } from './key-remap.js';

const HIDE_HINT_KEY = 'proxvocx.hideEscHint';
const SMOOTHING_KEY = 'proxvocx.smoothing';

/**
 * How long the viewer may hold a frame before showing it, in milliseconds.
 *
 * Zero is the lowest possible latency, and it is also why the picture can
 * look choppy on wifi even when every frame arrives: with no buffer at all,
 * each frame is shown the instant it lands, so the unevenness of the network
 * (one frame 5 ms late, the next 25 ms) becomes unevenness on screen. A small
 * buffer absorbs that and hands frames over at a steady pace, at the cost of
 * exactly that much extra delay between your hand and the cursor.
 *
 * Off is the default because the delay is the thing people notice. Measured
 * capture-to-screen in Chromium, Light over Off cost 14 ms on a clean link and
 * 11 ms with 0–40 ms of arrival jitter. That delay lands on every movement of
 * the cursor, while the steadier pacing it buys only shows on a jittery link.
 * Anyone on one can still turn it up.
 */
export const SMOOTHING = {
  off: { ms: 0, label: 'Off — lowest latency' },
  light: { ms: 40, label: 'Light — steadier picture, about 40 ms more delay' },
  heavy: { ms: 100, label: 'Heavy — for bad wifi, about 100 ms more delay' },
};

/** Minimum gap between pointer-move sends: a ~120 Hz ceiling. */
const MOVE_INTERVAL_MS = 8;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function createControlViewer({ db, uid, getMachineId, elements, onState, onNotice }) {
  const { stage, video, overlay, overlayTitle, overlayMessage, connectBtn, hint } = elements;

  let pc = null;
  let channel = null;
  let fastChannel = null;
  let videoReceiver = null;
  let smoothing = loadSmoothing();
  let keyMap = loadRemap();
  // Shared by every pointer event on both channels, so the host can tell a
  // move that was overtaken in flight from a current one.
  let pointerSeq = 0;
  // A move that arrived inside the send interval, waiting for the next slot.
  // It used to be dropped instead, which is harmless mid-motion but not at the
  // end of one: the last few pixels before the hand stopped were exactly the
  // ones thrown away, so the PC's cursor came to rest short of the viewer's.
  let pendingPoint = null;
  let moveTimer = null;
  // Why the picture is worse than asked for: the PC's own reason ('cpu',
  // 'bandwidth') or 'decode' when it is this device that cannot keep up.
  let hostLimit = 'none';
  let localLimit = 'none';
  let lastDropped = null;
  let resolution = 0;
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
  // Which display the PC is actually capturing, and how it is coding it. Both
  // come from the offer rather than being guessed here: the connector has its
  // own saved settings, so the viewer's controls have to open showing what is
  // really happening or the first change you make is a no-op against a value
  // the dropdown only *looked* like it was already on.
  let activeSourceId = null;
  let activeMode = 'text';
  let captureFps = 60;
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

  /**
   * Every key we have told the PC to press and not yet told it to release.
   *
   * Without this the viewer can only release keys it personally watched go
   * up, and there are several everyday ways it never does: ChromeOS eats the
   * Search/Launcher key to open its own launcher (the page sees `MetaLeft`
   * down and never the up), the browser keeps chords like Ctrl+W for itself,
   * alt-tabbing away steals the release of whatever was held, and pressing
   * Escape to drop capture used to swallow the release of every modifier
   * being held at that moment. Each one latches a modifier *on Windows*,
   * where it silently rewrites everything typed afterwards — a plain "w"
   * becomes Win+W and the widgets/weather panel opens on its own.
   */
  const heldKeys = new Map(); // physical code -> { code, key } actually sent

  /**
   * One place that knows the whole of what the UI needs, so a caller only has
   * to say what changed.
   *
   * `onState` treats what it is handed as the entire truth and re-renders the
   * toolbar from it, so every call site used to have to remember to re-send
   * the standing session facts alongside its own news. Forgetting one made
   * that control disappear or reset a couple of seconds later — the display
   * picker did exactly that, and the stream/display dropdowns were losing
   * their selection the same way.
   */
  function emitState(patch = {}) {
    onState?.({
      connected: !!pc && pc.connectionState === 'connected',
      status: pc ? pc.connectionState : 'idle',
      canInput: hostAllowsInput,
      screen,
      sources,
      activeSourceId,
      streamMode: activeMode,
      frameRate: captureFps,
      mouseLocked,
      resolution,
      smoothing,
      limit: localLimit !== 'none' ? localLimit : hostLimit,
      ...patch,
    });
  }

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
    emitState({ connected: false, status: 'connecting' });

    try {
      sessionId = await createSession(db, machineId, uid, 'control');

      const offer = await waitForDescription(db, paths.sessionOffer(machineId, sessionId), 30_000);
      screen = offer.screen || screen;
      hostAllowsInput = !!offer.capabilities?.input;
      sources = offer.sources || [];
      activeSourceId = offer.activeSourceId || sources[0]?.id || null;
      activeMode = offer.streamMode || activeMode;
      captureFps = offer.frameRate || captureFps;
      pointerSeq = 0;
      hostLimit = 'none';
      localLimit = 'none';
      lastDropped = null;
      resolution = 0;

      pc = new RTCPeerConnection({ iceServers: iceServers() });
      detachIce = attachIce(db, machineId, sessionId, pc, 'viewer');

      pc.addEventListener('track', (event) => {
        video.srcObject = event.streams[0];
        videoReceiver = event.receiver;
        applySmoothing();
        video.play().catch(() => {
          /* Autoplay is allowed because the element is muted; ignore races. */
        });
      });

      pc.addEventListener('datachannel', (event) => {
        if (event.channel.label === FAST_INPUT_CHANNEL) {
          fastChannel = event.channel;
          fastChannel.addEventListener('close', () => { fastChannel = null; });
          return;
        }
        if (event.channel.label !== INPUT_CHANNEL) return;
        channel = event.channel;
        channel.addEventListener('message', onHostMessage);
        channel.addEventListener('close', () => { channel = null; });
      });

      pc.addEventListener('connectionstatechange', () => {
        const st = pc?.connectionState;
        if (st === 'connected') {
          overlay.hidden = true;
          stage.dataset.state = 'live';
          emitState({ connected: true, status: 'connected' });
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
      emitState({ connected: false, status: 'failed' });
    }
  }

  /* ── disconnect ────────────────────────────────────────────── */

  async function disconnect(why = 'Session ended.') {
    const wasLive = !!pc;
    await teardown();
    if (wasLive) {
      showOverlay('Disconnected', why, true);
      emitState({ connected: false, status: 'idle' });
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
    try { fastChannel?.close(); } catch { /* already closed */ }
    fastChannel = null;
    videoReceiver = null;
    clearTimeout(moveTimer);
    moveTimer = null;
    pendingPoint = null;
    pendingDX = 0;
    pendingDY = 0;

    try { pc?.close(); } catch { /* already closed */ }
    pc = null;

    if (video.srcObject) {
      for (const track of video.srcObject.getTracks()) track.stop();
      video.srcObject = null;
    }

    const machineId = getMachineId();
    if (machineId && sessionId) await closeSession(db, machineId, sessionId);
    sessionId = null;
    // The display list belongs to the PC that offered it. Leaving it behind
    // meant the next session — often on a different machine — opened its
    // picker on the previous PC's monitors, and picking one sent that PC's
    // source id to a host that had never heard of it. The host falls back to
    // its first screen when it does not recognise an id, so the dropdown
    // appeared to do nothing at all.
    sources = [];
    activeSourceId = null;
    stage.dataset.state = 'idle';
  }

  /**
   * The connector reporting what the capture actually settled on.
   *
   * This channel used to be one-way. The viewer asked for a frame rate, a
   * display or a stream mode and then simply believed it had got one, so a
   * refusal on the PC — no silent capture available, an unrecognised display
   * id, a `getUserMedia` that failed on the new source — showed up here as a
   * dropdown that moved and changed nothing. Now the dropdowns are re-synced
   * from the PC's answer, which means a change that did not take snaps back
   * and says why.
   */
  function onHostMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message?.t === 'q') {
      hostLimit = typeof message.r === 'string' ? message.r : 'none';
      emitState();
      return;
    }
    if (message?.t !== 'cfg') return;

    if (typeof message.id === 'string') activeSourceId = message.id;
    if (Number.isFinite(message.res)) resolution = message.res;
    if (Number.isFinite(message.fps)) captureFps = message.fps;
    if (typeof message.sm === 'string') activeMode = message.sm;
    emitState();
    if (message.err) onNotice?.(message.err);
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

  /** An absolute cursor move, over the fast channel when there is one. */
  function sendMove(point) {
    if (!hostAllowsInput) return;
    const message = pointer('move', point.x, point.y, 'left', false, ++pointerSeq);
    if (fastChannel?.readyState === 'open') {
      try {
        fastChannel.send(JSON.stringify(message));
        return;
      } catch {
        /* Fall through to the reliable channel. */
      }
    }
    send(message);
  }

  /** Sends whatever motion is waiting — absolute, relative, or both. */
  function flushPointer() {
    clearTimeout(moveTimer);
    moveTimer = null;
    lastMoveSent = performance.now();
    if (pendingDX || pendingDY) {
      send(pointerRel(pendingDX, pendingDY));
      pendingDX = 0;
      pendingDY = 0;
    }
    if (pendingPoint) {
      sendMove(pendingPoint);
      pendingPoint = null;
    }
  }

  /**
   * Sends now if the interval allows, otherwise makes sure the waiting motion
   * goes out as soon as it does — never later, and never not at all.
   */
  function schedulePointerFlush() {
    const wait = MOVE_INTERVAL_MS - (performance.now() - lastMoveSent);
    if (wait <= 0) flushPointer();
    else if (!moveTimer) moveTimer = setTimeout(flushPointer, wait);
  }

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
    // Chromium holds `pointermove` back to the next animation frame and merges
    // whatever arrived meanwhile into it. So a movement that starts from rest
    // can wait up to a whole frame (16 ms at 60 Hz) before it leaves this
    // device, and the PC gets fewer positions per second than the mouse
    // reported. `pointerrawupdate` fires as soon as the OS reports the motion.
    // It is Chromium-only and secure-context-only, so everywhere else this is
    // still `pointermove`, exactly as before. Never both: each move would be
    // counted twice, which for relative motion doubles the distance.
    const moveEvent = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove';
    video.addEventListener(moveEvent, (event) => {
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
        schedulePointerFlush();
        return;
      }

      const point = toScreenPoint(event);
      if (!point.inside) return;
      pendingPoint = point;
      schedulePointerFlush();
    });

    video.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      captureKeyboard();
      // Motion still waiting for its slot happened *before* this press, so it
      // has to reach the PC before it too — or a quick move-and-click lands
      // the click short of where it was aimed.
      flushPointer();
      if (mouseLocked) {
        send(pointer('down', 0, 0, buttonFromEvent(event), true, ++pointerSeq));
        return;
      }
      const point = toScreenPoint(event);
      if (!point.inside) return;
      send(pointer('down', point.x, point.y, buttonFromEvent(event), false, ++pointerSeq));
    });

    video.addEventListener('pointerup', (event) => {
      event.preventDefault();
      flushPointer();
      if (mouseLocked) {
        send(pointer('up', 0, 0, buttonFromEvent(event), true, ++pointerSeq));
        return;
      }
      const point = toScreenPoint(event);
      if (!point.inside) return;
      send(pointer('up', point.x, point.y, buttonFromEvent(event), false, ++pointerSeq));
    });

    // No `dblclick` forwarding: the two press/release pairs that produce it
    // have already been sent, and Windows decides for itself that two clicks
    // that close together are a double click. Sending the dblclick as well
    // replayed a *third* and *fourth* click on top, which is why a double
    // click in a text field sometimes selected the whole line instead of the
    // word, and why some double clicks opened two of whatever was clicked.
    video.addEventListener('dblclick', (event) => event.preventDefault());

    // The remote desktop has its own context menu; never show the browser's.
    video.addEventListener('contextmenu', (event) => event.preventDefault());

    video.addEventListener('wheel', (event) => {
      const point = toScreenPoint(event);
      if (!point.inside) return;
      event.preventDefault();
      flushPointer();
      // The host works in pixels, but `deltaX/Y` are only pixels when
      // `deltaMode` says so — a wheel reporting in lines or pages sends 3 or
      // 1, which arrived as three pixels of scroll and looked like the wheel
      // had stopped working.
      const scale = event.deltaMode === 1 ? 33 // DOM_DELTA_LINE, ~one line
        : event.deltaMode === 2 ? 400          // DOM_DELTA_PAGE
          : 1;                                 // DOM_DELTA_PIXEL
      send(wheel(point.x, point.y, event.deltaX * scale, event.deltaY * scale));
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
      // Escape releases both at once, and while the mouse is captured that is
      // the only way back — worth saying, since the pointer cannot reach the
      // toolbar to click the button that turned it on.
      if (hint) {
        hint.textContent = nowLocked
          ? 'Press Esc to release the mouse and keyboard'
          : 'Press Esc to release the keyboard';
      }
      emitState();
    });

    // The same garbage-first-delta quirk shows up again after alt-tabbing
    // back into a window whose lock never actually released — no
    // pointerlockchange fires for that, since the lock state did not change.
    window.addEventListener('focus', () => {
      if (mouseLocked) skipNextMove = true;
    });

    // Losing the window mid-chord is the single most common way a modifier
    // gets stranded on the PC: the keydown went out, and the keyup is
    // delivered to whatever took focus instead of to us. ChromeOS does this
    // every time the Search/Launcher key opens its launcher — the page sees
    // `MetaLeft` go down and nothing else, and from then on every letter the
    // PC receives is a Win-chord. Tab-switching hits the same path.
    window.addEventListener('blur', releaseHeldKeys);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) releaseHeldKeys();
    });

    // Keyboard Lock is what lets keys the OS normally keeps for itself reach
    // the page, and browsers only honour it in fullscreen. Entering
    // fullscreen with the keyboard already captured has to take the lock
    // then; leaving drops it on its own.
    document.addEventListener('fullscreenchange', () => {
      if (captured) lockSystemKeys();
    });
  }

  /**
   * Asks the browser to hand the page keys the OS would otherwise take —
   * Search/Launcher on a Chromebook, Alt+Tab, the Windows key. Only works in
   * fullscreen; outside it this is a no-op and the OS keeps those keys, which
   * is why a Search → Shift remap still opens the ChromeOS launcher in a
   * window.
   *
   * Chrome keeps a long press of Escape as the way out of a lock, so a plain
   * Escape still arrives here and still releases the keyboard as always.
   */
  function lockSystemKeys() {
    if (!document.fullscreenElement || !navigator.keyboard?.lock) return;
    navigator.keyboard.lock().catch(() => { /* refused or unsupported */ });
  }

  function unlockSystemKeys() {
    try { navigator.keyboard?.unlock?.(); } catch { /* unsupported */ }
  }

  function onKeyDown(event) {
    if (!captured) return;
    if (event.key === 'Escape') {
      releaseKeyboard();
      event.preventDefault();
      return;
    }
    event.preventDefault();
    // The remap is resolved on the *down* and remembered, so the release
    // always matches what was pressed — even if the rules change, or the key
    // is let go after capture has moved on.
    const target = heldKeys.get(event.code) || resolveKey(keyMap, event.code, event.key);
    if (!target) return; // remapped to nothing
    if (event.code) heldKeys.set(event.code, target);
    send({ t: 'k', a: 'down', key: target.key, code: target.code, m: modifierMask(event) });
  }

  function onKeyUp(event) {
    if (!captured) return;
    event.preventDefault();
    const target = heldKeys.get(event.code) || resolveKey(keyMap, event.code, event.key);
    heldKeys.delete(event.code);
    if (!target) return;
    send({ t: 'k', a: 'up', key: target.key, code: target.code, m: modifierMask(event) });
  }

  /**
   * Releases everything still held, then tells the host to drop its own idea
   * of what is held too. Both halves matter: the per-key ups keep the two
   * sides' bookkeeping in step, and `keysUp()` covers the keys the PC thinks
   * are down that this viewer never knew about — a chord sent by a previous
   * session, or one whose keydown we sent just before the channel dropped.
   */
  function releaseHeldKeys() {
    for (const sent of heldKeys.values()) {
      send({ t: 'k', a: 'up', key: sent.key, code: sent.code, m: 0 });
    }
    heldKeys.clear();
    send(keysUp());
  }

  function hintDismissed() {
    try { return localStorage.getItem(HIDE_HINT_KEY) === '1'; } catch { return false; }
  }

  function captureKeyboard() {
    if (captured || !hostAllowsInput) return;
    captured = true;
    stage.classList.add('captured');
    if (hint) hint.hidden = hintDismissed();
    // `preventScroll` because the default is to scroll the element into view,
    // and a scroll here moves the video's box out from under a pointer that
    // has not moved — the next pointermove then maps to a different part of
    // the remote screen and the PC's cursor jumps vertically for no reason.
    video.focus({ preventScroll: true });
    lockSystemKeys();
  }

  function releaseKeyboard() {
    if (document.pointerLockElement === video) document.exitPointerLock();
    if (!captured) return;
    captured = false;
    unlockSystemKeys();
    // Before `captured` stops us forwarding anything, hand back whatever is
    // still down — otherwise dropping capture mid-chord latches it on the PC.
    releaseHeldKeys();
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
        let dropped = null;
        report.forEach((entry) => {
          if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.currentRoundTripTime != null) {
            rtt = Math.round(entry.currentRoundTripTime * 1000);
          }
          if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
            fps = Math.round(entry.framesPerSecond || 0);
            dropped = entry.framesDropped ?? null;
          }
        });
        // Frames that arrived whole and were thrown away on this side are
        // this device failing to decode or draw in time — a weak Chromebook
        // on 1080p60 VP9, typically. Neither the PC nor the link can fix
        // that; a lower resolution or frame rate can.
        if (dropped != null && lastDropped != null) {
          const perSecond = (dropped - lastDropped) / 2;
          localLimit = perSecond > Math.max(2, (fps || 0) * 0.1) ? 'decode' : 'none';
        }
        lastDropped = dropped;
        emitState({ connected: true, status: 'connected', rtt, fps });
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

  function loadSmoothing() {
    try {
      const saved = localStorage.getItem(SMOOTHING_KEY);
      return SMOOTHING[saved] ? saved : 'off';
    } catch {
      return 'off';
    }
  }

  function applySmoothing() {
    if (!videoReceiver) return;
    const { ms } = SMOOTHING[smoothing] || SMOOTHING.off;
    // `jitterBufferTarget` is the standard knob (milliseconds);
    // `playoutDelayHint` is Chromium's older one (seconds). Setting both
    // covers browsers that only have one.
    try { videoReceiver.jitterBufferTarget = ms; } catch { /* pre-M115 */ }
    try { videoReceiver.playoutDelayHint = ms / 1000; } catch { /* not supported */ }
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

    /**
     * Taps a key this keyboard does not have — a Chromebook's missing
     * function row, or a chord the browser keeps for itself.
     *
     * The modifiers are pressed and released as real keys rather than being
     * described in the event's modifier mask. The host replays one key per
     * event and has no use for the mask (for ordinary typing the modifier's
     * own keydown has already been sent, which is why it never needed one),
     * so a mask was the one part of this that went nowhere: `Alt+Tab` arrived
     * at the PC as a bare Tab.
     *
     * Released in reverse, and always — including if a send fails partway —
     * because the whole point of the pad is to reach keys without holding
     * anything down on this side.
     */
    sendKeyTap(code, keyName, mods = {}) {
      if (!hostAllowsInput) return;
      const modKeys = [
        mods.ctrl && ['ControlLeft', 'Control'],
        mods.alt && ['AltLeft', 'Alt'],
        mods.shift && ['ShiftLeft', 'Shift'],
        mods.meta && ['MetaLeft', 'Meta'],
      ].filter(Boolean);

      for (const [modCode, modName] of modKeys) {
        send({ t: 'k', a: 'down', key: modName, code: modCode, m: 0 });
      }
      send({ t: 'k', a: 'down', key: keyName, code, m: 0 });
      send({ t: 'k', a: 'up', key: keyName, code, m: 0 });
      for (const [modCode, modName] of [...modKeys].reverse()) {
        send({ t: 'k', a: 'up', key: modName, code: modCode, m: 0 });
      }
    },

    /** Changes the live capture frame rate without dropping the session. */
    setFrameRate(fps) {
      captureFps = fps;
      sendConfig(setFps(fps));
    },

    /** Caps the height the PC sends at, 0 for everything it captures. */
    setResolution(height) {
      resolution = height;
      sendConfig(setResolutionEvent(height));
    },

    /** Trades a little latency for evenly paced frames; see SMOOTHING. */
    setSmoothing(value) {
      if (!SMOOTHING[value]) return;
      smoothing = value;
      try { localStorage.setItem(SMOOTHING_KEY, value); } catch { /* private mode */ }
      applySmoothing();
      emitState();
    },

    /** Picks up remap rules saved since this viewer was created. */
    reloadKeyRemap() {
      keyMap = loadRemap();
    },

    /** Switches which display the host is capturing without reconnecting. */
    switchDisplay(id) {
      activeSourceId = id;
      sendConfig(switchDisplay(id));
    },

    /**
     * Re-tunes the encoder for the kind of thing on screen. Worth having on
     * this side and not only in the connector's own settings: which trade-off
     * is right changes with what you are doing — and with the link you happen
     * to be on — far more often than anyone will walk over to the PC to say so.
     */
    setStreamMode(mode) {
      activeMode = mode;
      sendConfig(streamModeEvent(mode));
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
