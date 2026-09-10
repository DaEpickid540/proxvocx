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
import { INPUT_CHANNEL, isValidEvent, configState } from './input-protocol.js';
import {
  CODEC_ORDERS, STREAM_MODES, bitrateFor, tuneSender, preferCodecs, applyBitrateHints,
} from './video-tuning.js';

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

    const frameRate = settings.frameRate ?? 60;
    const streamMode = settings.streamMode ?? 'text';
    const stream = await bridge.captureScreen({
      sourceId: settings.screenSourceId || null,
      maxHeight: settings.maxHeight ?? 1080,
      frameRate,
    });

    // Silent multi-display capture (desktop app only) — lets the client swap
    // which monitor it's watching without walking over to this machine.
    const sources = bridge.capabilities.captureSilent
      ? await bridge.listScreenSources().catch(() => [])
      : [];

    const pc = new RTCPeerConnection({ iceServers: iceServers(settings.turn) });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    // Codec order has to be settled before the offer is built — it *is* the
    // order of the m-line the viewer answers against.
    const videoTransceiver = pc.getTransceivers().find((t) => t.sender?.track?.kind === 'video');
    preferCodecs(videoTransceiver, CODEC_ORDERS[settings.codec] || CODEC_ORDERS.auto);

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
      // Live capture settings for this session, so recapture() can change one
      // without losing the other.
      sourceId: settings.screenSourceId || sources[0]?.id || null,
      frameRate,
      maxHeight: settings.maxHeight ?? 1080,
      streamMode,
    };
    active.set(sessionId, entry);
    onSessionChange?.(summary());

    // If the user stops sharing from the browser's own bar, drop the session.
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => teardown(sessionId, 'screen sharing stopped'));
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await applyVideoTuning(entry);

    await set(ref(db, paths.sessionOffer(machineId, sessionId)), {
      type: offer.type,
      sdp: offer.sdp,
      screen: entry.screen,
      capabilities: {
        input: bridge.capabilities.input && settings.allowInput !== false,
      },
      sources: sources.map((s) => ({ id: s.id, name: s.name })),
      // So the viewer's controls open showing what is actually being captured
      // rather than their own guess. A dropdown that opens on the wrong entry
      // is worse than no dropdown: the setting you want is already selected,
      // so choosing it fires no change event and nothing happens.
      activeSourceId: entry.sourceId,
      streamMode,
      frameRate,
    });
    await update(ref(db, paths.session(machineId, sessionId)), { state: 'offered' });

    const stopAnswer = onValue(ref(db, paths.sessionAnswer(machineId, sessionId)), async (snap) => {
      const answer = snap.val();
      if (!answer?.sdp || pc.signalingState === 'stable') return;
      stopAnswer();
      // The encoder reads its bitrate hints out of the remote description, so
      // the answer is the only place they can be written. A rewrite that some
      // future browser dislikes must not cost the session the picture
      // entirely, hence the retry on the untouched SDP.
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

  /**
   * Sizes the bitrate ceiling to the picture actually being captured, then
   * pushes it — along with the content hint and the degradation preference —
   * onto the live sender.
   *
   * Called once the offer is in place, and again after every `recapture()`:
   * `replaceTrack()` carries the sender's parameters across, but the content
   * hint is a property of the track that was just swapped away, and the
   * ceiling itself depends on the resolution and frame rate that just changed.
   */
  async function applyVideoTuning(entry) {
    entry.maxBitrate = bitrateFor({ ...entry.screen, frameRate: entry.frameRate });
    const sender = entry.pc.getSenders().find((s) => s.track?.kind === 'video');
    try {
      await tuneSender(sender, {
        mode: entry.streamMode,
        frameRate: entry.frameRate,
        maxBitrate: entry.maxBitrate,
      });
    } catch (err) {
      // A stream at Chromium's defaults is worse, but it is still a stream.
      log?.(`could not apply the encoder settings: ${err.message}`, 'warn');
    }
  }

  /**
   * Tells the viewer what the capture settled on — after every change, and
   * whether or not it worked.
   *
   * Without this the viewer's dropdowns are write-only: they show what was
   * asked for rather than what happened, so a refusal is indistinguishable
   * from success and the only record is a log line on this machine.
   */
  function reportConfig(entry, error = null) {
    if (entry.channel?.readyState !== 'open') return;
    try {
      entry.channel.send(JSON.stringify(configState({
        sourceId: entry.sourceId,
        frameRate: entry.frameRate,
        streamMode: entry.streamMode,
        error,
      })));
    } catch {
      /* The channel went away mid-send; the session is ending anyway. */
    }
  }

  /* ── input replay ──────────────────────────────────────────── */

  async function onInputMessage(sessionId, raw) {
    const entry = active.get(sessionId);
    if (!entry) return;

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isValidEvent(event)) return;

    // These three reconfigure how the picture is captured and coded rather
    // than the OS input state, so they run regardless of the allowInput
    // setting — they are not input.
    if (event.t === 'fps') return recapture(sessionId, entry, { frameRate: event.v });
    if (event.t === 'disp') return recapture(sessionId, entry, { sourceId: event.id });
    if (event.t === 'sm') {
      if (!STREAM_MODES[event.v]) return reportConfig(entry, `unknown stream mode "${event.v}"`);
      entry.streamMode = event.v;
      try {
        await applyVideoTuning(entry);
        log?.(`stream mode set to ${event.v}`, 'good');
        return reportConfig(entry);
      } catch (err) {
        return reportConfig(entry, err.message);
      }
    }

    const settings = getSettings?.() || {};
    if (settings.allowInput === false || !bridge.capabilities.input) return;

    try {
      await bridge.injectInput({ ...event, screen: entry.screen });
    } catch (err) {
      log?.(`input rejected: ${err.message}`, 'warn');
    }
  }

  /**
   * Re-opens the capture with new settings and swaps the outgoing track, which
   * is how BOTH the frame-rate and the display change mid-session.
   *
   * Frame rate does not go through track.applyConstraints(): an Electron
   * desktopCapturer track is created through the legacy `mandatory` constraint
   * path, and re-applying constraints on one is silently ignored, so the
   * request looked accepted while nothing changed. Capturing afresh at the
   * requested rate and calling replaceTrack() actually takes effect, and costs
   * no renegotiation because the sender and its transceiver stay put.
   *
   * The chosen source and rate are remembered per session so that changing one
   * does not quietly reset the other back to the connector's defaults.
   */
  async function recapture(sessionId, entry, { sourceId, frameRate }) {
    // A browser tab can only capture via getDisplayMedia, which raises the
    // system picker every time — re-capturing there would put a dialog in
    // front of the user on every dropdown change, so leave it alone.
    if (!bridge.capabilities.captureSilent) {
      const why = 'the PC is running in a browser tab, which cannot change the capture without a picker';
      log?.(`changing the display or frame rate needs the desktop app`, 'warn');
      reportConfig(entry, why);
      return;
    }
    // Kept so a failure can put them back. Applying the request up front is
    // what lets the two settings be changed independently, but it also means
    // a throw leaves the entry claiming settings that were never achieved —
    // and `reportConfig` would then dutifully tell the viewer its broken
    // change had worked.
    const previousSourceId = entry.sourceId;
    const previousFrameRate = entry.frameRate;
    if (sourceId !== undefined) entry.sourceId = sourceId;
    if (frameRate !== undefined) entry.frameRate = frameRate;

    try {
      const newStream = await bridge.captureScreen({
        sourceId: entry.sourceId,
        maxHeight: entry.maxHeight,
        frameRate: entry.frameRate,
      });
      const sender = entry.pc.getSenders().find((s) => s.track?.kind === 'video');
      if (!sender) throw new Error('no video sender on this session');
      await sender.replaceTrack(newStream.getVideoTracks()[0]);

      const previous = entry.stream;
      entry.stream = newStream;
      entry.screen = trackGeometry(newStream);
      await applyVideoTuning(entry);
      for (const track of newStream.getTracks()) {
        track.addEventListener('ended', () => teardown(sessionId, 'screen sharing stopped'));
      }
      // Only after the swap has succeeded, or a failure mid-way would leave
      // the session with its old track already stopped and nothing sending.
      for (const track of previous.getTracks()) track.stop();

      log?.(sourceId !== undefined
        ? 'switched display'
        : `frame rate set to ${entry.frameRate} fps`, 'good');
      reportConfig(entry);
    } catch (err) {
      log?.(`could not reconfigure the capture: ${err.message}`, 'warn');
      // The old capture is still the live one, so the old settings are still
      // the true ones. Restore them before telling the viewer, or its dropdown
      // snaps back to the very value that just failed.
      entry.sourceId = previousSourceId;
      entry.frameRate = previousFrameRate;
      reportConfig(entry, err.message);
    }
  }

  /* ── teardown ──────────────────────────────────────────────── */

  function teardown(sessionId, why) {
    const entry = active.get(sessionId);
    if (!entry) return;
    active.delete(sessionId);

    // A session that drops while a key is held leaves that key held on the
    // real desktop, with nobody left to send the release — the viewer is
    // already gone. Everything typed at the PC afterwards then arrives as a
    // chord, which is a genuinely alarming thing to walk back to.
    bridge.injectInput({ t: 'ku' }).catch(() => { /* no native input backend */ });

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
