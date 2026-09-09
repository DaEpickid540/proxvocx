/**
 * The 'scripted' half of the connector: Browser mode with JavaScript turned
 * on. Structurally this mirrors pc-control.js almost exactly — same session
 * acceptance, same WebRTC offer/answer dance — but the video source is a real
 * Electron browser tab (see host-bridge.js `openScriptedBrowser`, backed by
 * desktop/bridge/scripted-browser.js) instead of the whole desktop, and the
 * data channel additionally carries navigation commands both ways: the
 * client sends go/back/forward/reload, the host pushes back the real
 * browser's URL, title, and history state after every navigation.
 */
import { ref, set, update, remove, onValue, onChildAdded, onChildRemoved, get } from './firebase.js';
import { paths } from './paths.js';
import { iceServers, attachIce, SESSION_MAX_AGE_MS } from './signaling.js';
import { INPUT_CHANNEL, isValidEvent, navState as buildNavState } from './input-protocol.js';
import {
  CODEC_ORDERS, bitrateFor, tuneSender, preferCodecs, applyBitrateHints,
} from './video-tuning.js';

export function startScriptedBrowserHost({ db, machineId, bridge, log, onStat, getSettings, onSessionChange }) {
  const active = new Map();
  let stopped = false;

  sweepStaleSessions(db, machineId).catch(() => {});

  const sessionsRef = ref(db, paths.sessions(machineId));

  const stopAdded = onChildAdded(sessionsRef, async (snapshot) => {
    if (stopped) return;
    const sessionId = snapshot.key;
    const session = snapshot.val();
    if (!session || session.mode !== 'scripted' || active.has(sessionId)) return;
    if (session.state && session.state !== 'requesting') return;

    try {
      await accept(sessionId, session);
    } catch (err) {
      log?.(`scripted session ${sessionId.slice(0, 6)} failed: ${err.message}`, 'error');
      onStat?.('errors', 1);
      await remove(ref(db, paths.session(machineId, sessionId))).catch(() => {});
    }
  }, (err) => log?.(`scripted session listener failed: ${err.message}`, 'error'));

  const stopRemoved = onChildRemoved(sessionsRef, (snapshot) => {
    teardown(snapshot.key, 'the client disconnected');
  });

  async function accept(sessionId, session) {
    const settings = getSettings?.() || {};

    const ownerSnap = await get(ref(db, paths.owner(machineId, session.clientUid)));
    if (ownerSnap.val() !== true) {
      log?.('refused a scripted session from an account this PC is not paired to', 'warn');
      await remove(ref(db, paths.session(machineId, sessionId)));
      return;
    }
    if (!settings.allowScripts) {
      await update(ref(db, paths.session(machineId, sessionId)), {
        state: 'refused',
        error: 'JavaScript is switched off for Browser mode on this PC.',
      });
      log?.('refused a scripted session — scripts are switched off', 'warn');
      return;
    }
    if (!session.url) {
      await remove(ref(db, paths.session(machineId, sessionId)));
      return;
    }

    log?.(`incoming scripted session ${sessionId.slice(0, 6)} · ${short(session.url)}`, 'good');

    // Declared before openScriptedBrowser so the onNavState closure below
    // closes over a real binding rather than a not-yet-declared const —
    // nav state cannot arrive before the browser has loaded something, but
    // there is no reason to depend on that timing being true.
    let entry;

    const page = {
      width: settings.scriptedWidth ?? 1600,
      height: settings.scriptedHeight ?? 1000,
      frameRate: settings.scriptedFrameRate ?? 20,
      quality: settings.scriptedQuality ?? 92,
    };

    const scripted = await bridge.openScriptedBrowser(sessionId, session.url, {
      ...page,
      onNavState: (state) => {
        if (entry?.channel?.readyState === 'open') {
          entry.channel.send(JSON.stringify(buildNavState(state)));
        }
      },
    });

    const pc = new RTCPeerConnection({ iceServers: iceServers(settings.turn) });
    for (const track of scripted.stream.getTracks()) pc.addTrack(track, scripted.stream);

    // Same treatment pc-control.js gives the desktop stream. A browser tab is
    // if anything the stronger case for it: it is text almost end to end, and
    // it has already been through one lossy pass as a JPEG before WebRTC sees
    // it, so there is nothing here for a codec left on its camera-video
    // defaults to be forgiving about.
    const videoTransceiver = pc.getTransceivers().find((t) => t.sender?.track?.kind === 'video');
    preferCodecs(videoTransceiver, CODEC_ORDERS[settings.codec] || CODEC_ORDERS.auto);

    const channel = pc.createDataChannel(INPUT_CHANNEL, { ordered: true });
    channel.addEventListener('message', (event) => onChannelMessage(sessionId, event.data));

    const detachIce = attachIce(db, machineId, sessionId, pc, 'host');

    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        teardown(sessionId, `connection ${pc.connectionState}`);
      } else if (pc.connectionState === 'connected') {
        log?.('scripted session connected', 'good');
        onStat?.('sessions', 1);
        onSessionChange?.(summary());
      }
    });

    entry = { pc, scripted, channel, page, clientUid: session.clientUid, startedAt: Date.now() };
    active.set(sessionId, entry);
    onSessionChange?.(summary());

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    entry.maxBitrate = bitrateFor(page);
    try {
      await tuneSender(pc.getSenders().find((s) => s.track?.kind === 'video'), {
        // Always 'text': this is a web page, never a game.
        mode: 'text',
        frameRate: page.frameRate,
        maxBitrate: entry.maxBitrate,
      });
    } catch (err) {
      log?.(`could not apply the encoder settings: ${err.message}`, 'warn');
    }

    await set(ref(db, paths.sessionOffer(machineId, sessionId)), {
      type: offer.type,
      sdp: offer.sdp,
      screen: { width: page.width, height: page.height },
    });
    await update(ref(db, paths.session(machineId, sessionId)), { state: 'offered' });

    const stopAnswer = onValue(ref(db, paths.sessionAnswer(machineId, sessionId)), async (snap) => {
      const answer = snap.val();
      if (!answer?.sdp || pc.signalingState === 'stable') return;
      stopAnswer();
      const hinted = applyBitrateHints(answer.sdp, { maxBitrate: entry.maxBitrate });
      try {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: answer.type, sdp: hinted }));
      } catch (err) {
        log?.(`bitrate hints rejected (${err.message}) — connecting without them`, 'warn');
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (plainErr) {
          log?.(`could not accept the answer: ${plainErr.message}`, 'error');
          teardown(sessionId, 'bad answer');
        }
      }
    });
    entry.stopAnswer = stopAnswer;
  }

  /* ── data channel: input + navigation ─────────────────────────── */

  async function onChannelMessage(sessionId, raw) {
    const entry = active.get(sessionId);
    if (!entry) return;

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isValidEvent(event)) return;

    if (event.t === 'n') {
      entry.scripted.navigate(event.a, event.url);
      return;
    }
    // A shape request is not OS input and does not go near sendInput().
    if (event.t === 'ar') {
      const size = sizeForAspect(entry.page, event.v);
      entry.scripted.resize(size.width, size.height);
      return;
    }
    try {
      await entry.scripted.sendInput(event);
    } catch (err) {
      log?.(`scripted input rejected: ${err.message}`, 'warn');
    }
  }

  /* ── teardown ──────────────────────────────────────────────────── */

  function teardown(sessionId, why) {
    const entry = active.get(sessionId);
    if (!entry) return;
    active.delete(sessionId);

    entry.stopAnswer?.();
    entry.detachIce?.();
    try { entry.channel?.close(); } catch { /* already closed */ }
    try { entry.pc.close(); } catch { /* already closed */ }
    try { entry.scripted.close(); } catch { /* already closed */ }

    log?.(`scripted session ended — ${why}`);
    remove(ref(db, paths.session(machineId, sessionId))).catch(() => {});
    onSessionChange?.(summary());
  }

  function summary() {
    return Array.from(active.entries()).map(([id, entry]) => ({
      id,
      clientUid: entry.clientUid,
      startedAt: entry.startedAt,
      state: entry.pc.connectionState,
    }));
  }

  return {
    get sessions() { return summary(); },
    endAll(why = 'ended on the PC') {
      for (const id of Array.from(active.keys())) teardown(id, why);
    },
    stop() {
      stopped = true;
      stopAdded();
      stopRemoved();
      this.endAll('the connector stopped');
    },
  };
}

/**
 * The configured page size, reshaped to the viewer's aspect ratio.
 *
 * The pixel count is held roughly constant, so the PC renders and encodes
 * about as much as the chosen "Page size" asked for however wide or tall the
 * viewer's stage happens to be — what changes is only the shape, which is what
 * decides whether the picture fills the stage or arrives inside black bars.
 * The bounds stop a very long or very narrow window turning a modest budget
 * into an absurd viewport for the site being rendered. The tall end is
 * generous enough to cover a phone held upright in fullscreen, which is
 * otherwise the one common shape that would still show bars.
 */
function sizeForAspect({ width, height }, aspect) {
  const pixels = width * height;
  const even = (n) => Math.round(n / 2) * 2;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  return {
    width: clamp(even(Math.sqrt(pixels * aspect)), 640, 2560),
    height: clamp(even(Math.sqrt(pixels / aspect)), 400, 2000),
  };
}

function short(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.slice(0, 48);
  } catch {
    return String(url).slice(0, 48);
  }
}

/** Sessions whose client vanished mid-handshake would otherwise pile up. */
async function sweepStaleSessions(db, machineId) {
  const snapshot = await get(ref(db, paths.sessions(machineId)));
  const now = Date.now();
  const dead = [];
  snapshot.forEach((child) => {
    if (child.val()?.mode !== 'scripted') return;
    const createdAt = Number(child.val()?.createdAt) || 0;
    if (now - createdAt > SESSION_MAX_AGE_MS) dead.push(child.key);
  });
  await Promise.all(dead.map((id) => remove(ref(db, paths.session(machineId, id)))));
}
