/**
 * The PC Control half of the connector.
 *
 * Waits for a client to drop a session under `machines/{id}/sessions`, checks
 * it really is the paired owner, then offers its screen over WebRTC. Input
 * arrives back on a data channel and is replayed on the real desktop through
 * the native host.
 */
import { ref, set, update, remove, onValue, onChildAdded, onChildRemoved, get } from './firebase.js';
import { paths } from './paths.js';
import { iceServers, attachIce, SESSION_MAX_AGE_MS } from './signaling.js';
import { INPUT_CHANNEL, isValidEvent } from './input-protocol.js';

export function startControlHost({ db, machineId, bridge, log, onStat, getSettings, onSessionChange }) {
  const active = new Map();
  let stopped = false;

  sweepStaleSessions(db, machineId).catch(() => {});

  const sessionsRef = ref(db, paths.sessions(machineId));

  const stopAdded = onChildAdded(sessionsRef, async (snapshot) => {
    if (stopped) return;
    const sessionId = snapshot.key;
    const session = snapshot.val();
    if (!session || active.has(sessionId)) return;
    // A 'scripted' session belongs to pc-scripted-browser.js, not here.
    if (session.mode && session.mode !== 'control') return;
    if (session.state && session.state !== 'requesting') return;

    try {
      await accept(sessionId, session);
    } catch (err) {
      log?.(`session ${sessionId.slice(0, 6)} failed: ${err.message}`, 'error');
      onStat?.('errors', 1);
      await remove(ref(db, paths.session(machineId, sessionId))).catch(() => {});
    }
  }, (err) => log?.(`session listener failed: ${err.message}`, 'error'));

  const stopRemoved = onChildRemoved(sessionsRef, (snapshot) => {
    teardown(snapshot.key, 'the client disconnected');
  });

  async function accept(sessionId, session) {
    const settings = getSettings?.() || {};

    const ownerSnap = await get(ref(db, paths.owner(machineId, session.clientUid)));
    if (ownerSnap.val() !== true) {
      log?.('refused a session from an account this PC is not paired to', 'warn');
      await remove(ref(db, paths.session(machineId, sessionId)));
      return;
    }
    if (settings.allowControl === false) {
      await update(ref(db, paths.session(machineId, sessionId)), {
        state: 'refused',
        error: 'Remote control is switched off on the PC.',
      });
      log?.('refused a session — remote control is switched off', 'warn');
      return;
    }

    log?.(`incoming control session ${sessionId.slice(0, 6)}`, 'good');

    const stream = await bridge.captureScreen({
      sourceId: settings.screenSourceId || null,
      maxHeight: settings.maxHeight ?? 1080,
      frameRate: settings.frameRate ?? 30,
    });

    const pc = new RTCPeerConnection({ iceServers: iceServers(settings.turn) });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    // The host opens the channel: it makes the offer, so this saves a
    // renegotiation round trip.
    const channel = pc.createDataChannel(INPUT_CHANNEL, { ordered: true });
    channel.addEventListener('message', (event) => onInputMessage(sessionId, event.data));

    const detachIce = attachIce(db, machineId, sessionId, pc, 'host');

    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        teardown(sessionId, `connection ${pc.connectionState}`);
      } else if (pc.connectionState === 'connected') {
        log?.('control session connected', 'good');
        onStat?.('sessions', 1);
        onSessionChange?.(summary());
      }
    });

    const entry = {
      pc, stream, channel, detachIce,
      clientUid: session.clientUid,
      startedAt: Date.now(),
      screen: trackGeometry(stream),
    };
    active.set(sessionId, entry);
    onSessionChange?.(summary());

    // If the user stops sharing from the browser's own bar, drop the session.
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => teardown(sessionId, 'screen sharing stopped'));
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await set(ref(db, paths.sessionOffer(machineId, sessionId)), {
      type: offer.type,
      sdp: offer.sdp,
      screen: entry.screen,
      capabilities: {
        input: bridge.capabilities.input && settings.allowInput !== false,
      },
    });
    await update(ref(db, paths.session(machineId, sessionId)), { state: 'offered' });

    const stopAnswer = onValue(ref(db, paths.sessionAnswer(machineId, sessionId)), async (snap) => {
      const answer = snap.val();
      if (!answer?.sdp || pc.signalingState === 'stable') return;
      stopAnswer();
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        log?.(`could not accept the answer: ${err.message}`, 'error');
        teardown(sessionId, 'bad answer');
      }
    });
    entry.stopAnswer = stopAnswer;
  }

  /* ── input replay ──────────────────────────────────────────── */

  async function onInputMessage(sessionId, raw) {
    const entry = active.get(sessionId);
    if (!entry) return;

    const settings = getSettings?.() || {};
    if (settings.allowInput === false || !bridge.capabilities.input) return;

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isValidEvent(event)) return;

    try {
      await bridge.injectInput({ ...event, screen: entry.screen });
    } catch (err) {
      log?.(`input rejected: ${err.message}`, 'warn');
    }
  }

  /* ── teardown ──────────────────────────────────────────────── */

  function teardown(sessionId, why) {
    const entry = active.get(sessionId);
    if (!entry) return;
    active.delete(sessionId);

    entry.stopAnswer?.();
    entry.detachIce?.();
    try { entry.channel?.close(); } catch { /* already closed */ }
    try { entry.pc.close(); } catch { /* already closed */ }
    for (const track of entry.stream?.getTracks() || []) track.stop();

    log?.(`control session ended — ${why}`);
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

function trackGeometry(stream) {
  const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
  return {
    width: settings.width || 1920,
    height: settings.height || 1080,
  };
}

/** Sessions whose client vanished mid-handshake would otherwise pile up. */
async function sweepStaleSessions(db, machineId) {
  const snapshot = await get(ref(db, paths.sessions(machineId)));
  const now = Date.now();
  const dead = [];
  snapshot.forEach((child) => {
    if (child.val()?.mode && child.val().mode !== 'control') return;
    const createdAt = Number(child.val()?.createdAt) || 0;
    if (now - createdAt > SESSION_MAX_AGE_MS) dead.push(child.key);
  });
  await Promise.all(dead.map((id) => remove(ref(db, paths.session(machineId, id)))));
}
