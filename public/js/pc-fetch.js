/**
 * Browser mode's fast lane, PC side.
 *
 * The script-free mini browser used to reach the PC only through the database:
 * every request — the page, and then each image and stylesheet on it — was a
 * write under `requests`, a wait for this connector to notice it, a write of
 * the whole body (base64 for anything binary) under `responses`, and a wait
 * for the client to notice *that*. Four database hops per resource, four at a
 * time, capped at half a megabyte. A page with sixty images was sixty of those.
 *
 * A 'fetch' session is a WebRTC peer connection with no media at all, just one
 * data channel, and requests and responses go straight down it: one hop each
 * way, directly between the two machines, as many in flight as the PC is
 * willing to run, and no size cap worth the name. The database is still only
 * the handshake, exactly as it is for PC Control.
 *
 * The request queue in pc-proxy.js stays: it is what the client uses while
 * this channel is still connecting, or when it cannot connect at all (a
 * network that needs a TURN relay, an older connector, rules not yet deployed).
 *
 * The same channel also carries the native engine's traffic (Scramjet, in
 * the viewer's browser): requests exactly as a browser would send them, with
 * binary bodies both ways, and WebSockets opened from the PC.
 *
 * Wire format on the channel (label FETCH_CHANNEL). JSON unless noted; binary
 * frames are described in lane-frames.js.
 *
 *   script-free engine
 *     client → PC   {"t":"req","id","url",...}             one JSON message
 *     PC → client   {"t":"res","id","n":K,"meta":{…}}       everything but the body
 *                   "id\n<chunk>" × K                        the body, as text
 *   native engine
 *     client → PC   {"t":"rreq","id","url","method","headers","parts":K}
 *                   REQUEST_BODY frame × K
 *     PC → client   {"t":"rres","id","status","statusText","headers","parts":K}
 *                   RESPONSE_BODY frame × K
 *     client → PC   {"t":"wso","id","url","protocols","headers"}   open a socket
 *                   {"t":"wss","id","d"} or WS_BINARY frame          send
 *                   {"t":"wsc","id","code","reason"}                 close
 *     PC → client   {"t":"wsopen","id","protocol"}  {"t":"wsm","id","d"}
 *                   WS_BINARY frame  {"t":"wsclose","id","code","reason"}
 *                   {"t":"wserr","id","error"}
 *   both
 *     client → PC   {"t":"cancel","id"}                     drop it if not started
 *     PC → client   {"t":"err","id","error","code"}
 *
 * What this PC supports is announced in the offer (`features`), so a newer
 * viewer knows not to try the native engine against an older connector.
 */
import { ref, set, update, remove, onValue, onChildAdded, onChildRemoved, get } from './firebase.js';
import { paths } from './paths.js';
import { iceServers, attachIce, SESSION_MAX_AGE_MS } from './signaling.js';
import { FRAME, encodeFrame, decodeFrame, splitBytes, joinParts } from './lane-frames.js';

export const FETCH_CHANNEL = 'fetch';

/** Well under Chromium's 256 KiB message ceiling even if every char is 3 bytes. */
export const FETCH_CHUNK_CHARS = 60_000;

/** The cap asked for on this lane. The database lane keeps its own, smaller one. */
export const FETCH_MAX_BYTES = 8 * 1024 * 1024;

const MAX_CONCURRENT = 8;
/** A native-engine page is dozens of requests at once; the PC's side is cheap. */
const MAX_CONCURRENT_RAW = 16;
/** Sockets one viewer may hold open through this PC at once. */
const MAX_SOCKETS = 48;
/** Pause sending above this much queued in the channel, resume below LOW. */
const BUFFER_HIGH = 4 * 1024 * 1024;
const BUFFER_LOW = 1 * 1024 * 1024;

export function startFetchHost({ db, machineId, bridge, log, onStat, getSettings }) {
  const active = new Map();
  let stopped = false;

  sweepStaleSessions(db, machineId).catch(() => {});

  const sessionsRef = ref(db, paths.sessions(machineId));

  const stopAdded = onChildAdded(sessionsRef, async (snapshot) => {
    if (stopped) return;
    const sessionId = snapshot.key;
    const session = snapshot.val();
    if (!session || session.mode !== 'fetch' || active.has(sessionId)) return;
    if (session.state && session.state !== 'requesting') return;

    try {
      await accept(sessionId, session);
    } catch (err) {
      log?.(`fetch channel ${sessionId.slice(0, 6)} failed: ${err.message}`, 'error');
      await remove(ref(db, paths.session(machineId, sessionId))).catch(() => {});
    }
  }, (err) => log?.(`fetch session listener failed: ${err.message}`, 'error'));

  const stopRemoved = onChildRemoved(sessionsRef, (snapshot) => teardown(snapshot.key));

  // Socket events for every session arrive on one listener; the id carries
  // the session they belong to ("sessionId:socketId").
  const stopWsEvents = bridge.onWsEvent?.((event) => {
    const cut = String(event.id).lastIndexOf(':');
    const entry = active.get(String(event.id).slice(0, cut));
    const id = Number(String(event.id).slice(cut + 1));
    if (!entry || !entry.sockets.has(id)) return;
    if (event.type === 'open') reply(entry, { t: 'wsopen', id, protocol: event.protocol || '' });
    else if (event.type === 'message' && event.binary) sendRaw(entry, encodeFrame(id, FRAME.WS_BINARY, event.data));
    else if (event.type === 'message') reply(entry, { t: 'wsm', id, d: event.data });
    else if (event.type === 'error') reply(entry, { t: 'wserr', id, error: event.message || 'socket error' });
    else if (event.type === 'close') {
      entry.sockets.delete(id);
      reply(entry, { t: 'wsclose', id, code: event.code || 1005, reason: event.reason || '' });
    }
  }) || (() => {});

  async function accept(sessionId, session) {
    const settings = getSettings?.() || {};

    const ownerSnap = await get(ref(db, paths.owner(machineId, session.clientUid)));
    if (ownerSnap.val() !== true) {
      await remove(ref(db, paths.session(machineId, sessionId)));
      return;
    }
    // Refused rather than ignored, so the client falls back to the database
    // lane straight away — which will then give the real reason.
    if (settings.allowProxy === false || !bridge.capabilities.proxy) {
      await update(ref(db, paths.session(machineId, sessionId)), {
        state: 'refused',
        error: 'This PC is not serving browser traffic.',
      });
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: iceServers(settings.turn) });
    const channel = pc.createDataChannel(FETCH_CHANNEL, { ordered: true });
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    const detachIce = attachIce(db, machineId, sessionId, pc, 'host');

    const entry = {
      sessionId, pc, channel, detachIce,
      queue: [], inFlight: 0, cancelled: new Set(),
      /** Native-engine requests still waiting for their body frames. */
      uploads: new Map(),
      sockets: new Set(),
    };
    active.set(sessionId, entry);

    channel.addEventListener('message', (event) => onMessage(entry, event.data));
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) teardown(sessionId);
      else if (pc.connectionState === 'connected') log?.('browser fast lane connected', 'good');
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await set(ref(db, paths.sessionOffer(machineId, sessionId)), {
      type: offer.type,
      sdp: offer.sdp,
      features: {
        raw: !!bridge.capabilities.rawFetch,
        ws: !!bridge.capabilities.websockets,
      },
    });
    await update(ref(db, paths.session(machineId, sessionId)), { state: 'offered' });

    entry.stopAnswer = onValue(ref(db, paths.sessionAnswer(machineId, sessionId)), async (snap) => {
      const answer = snap.val();
      if (!answer?.sdp || pc.signalingState === 'stable') return;
      entry.stopAnswer?.();
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        log?.(`fetch channel: could not accept the answer: ${err.message}`, 'error');
        teardown(sessionId);
      }
    });
  }

  function onMessage(entry, raw) {
    if (raw instanceof ArrayBuffer) {
      onFrame(entry, decodeFrame(raw));
      return;
    }
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!Number.isInteger(message?.id)) return;
    switch (message.t) {
      case 'cancel':
        entry.cancelled.add(message.id);
        entry.uploads.delete(message.id);
        return;
      case 'req':
        if (typeof message.url !== 'string') return;
        entry.queue.push(message);
        pump(entry);
        return;
      case 'rreq': {
        if (typeof message.url !== 'string') return;
        const parts = Math.max(0, Number(message.parts) || 0);
        if (parts === 0) {
          entry.queue.push({ ...message, raw: true, body: null });
          pump(entry);
        } else {
          entry.uploads.set(message.id, { job: { ...message, raw: true }, expected: parts, parts: [] });
        }
        return;
      }
      case 'wso': return openSocket(entry, message);
      case 'wss': return sendSocket(entry, message.id, typeof message.d === 'string' ? message.d : '');
      case 'wsc': return closeSocket(entry, message.id, message.code, message.reason);
      default:
    }
  }

  function onFrame(entry, frame) {
    if (frame.kind === FRAME.REQUEST_BODY) {
      const upload = entry.uploads.get(frame.id);
      if (!upload) return;
      upload.parts.push(frame.bytes.slice());
      if (upload.parts.length < upload.expected) return;
      entry.uploads.delete(frame.id);
      entry.queue.push({ ...upload.job, body: new Uint8Array(joinParts(upload.parts)) });
      pump(entry);
    } else if (frame.kind === FRAME.WS_BINARY) {
      sendSocket(entry, frame.id, frame.bytes.slice());
    }
  }

  function pump(entry) {
    const limit = entry.queue.some((job) => job.raw) ? MAX_CONCURRENT_RAW : MAX_CONCURRENT;
    while (entry.inFlight < limit && entry.queue.length) {
      const job = entry.queue.shift();
      if (entry.cancelled.delete(job.id)) continue;
      entry.inFlight += 1;
      (job.raw ? handleRaw(entry, job) : handle(entry, job)).finally(() => {
        entry.inFlight -= 1;
        pump(entry);
      });
    }
  }

  /** A native-engine request: browser-exact, bytes in and bytes out. */
  async function handleRaw(entry, job) {
    if (getSettings?.().allowProxy === false || !bridge.capabilities.rawFetch) {
      return reply(entry, { t: 'err', id: job.id, error: 'The PC is not serving browser traffic.', code: 'ERR_REFUSED' });
    }
    try {
      const result = await bridge.rawFetch({
        url: job.url,
        method: job.method || 'GET',
        headers: job.headers && typeof job.headers === 'object' ? job.headers : {},
        body: job.body || null,
      });
      onStat?.('requests', 1);
      onStat?.('bytes', result.body?.byteLength || 0);
      const parts = splitBytes(result.body || new Uint8Array(0));
      await reply(entry, {
        t: 'rres',
        id: job.id,
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        truncated: !!result.truncated,
        parts: parts.length,
      });
      for (const part of parts) await sendRaw(entry, encodeFrame(job.id, FRAME.RESPONSE_BODY, part));
    } catch (err) {
      onStat?.('errors', 1);
      await reply(entry, { t: 'err', id: job.id, error: cleanIpcError(err), code: err.code || 'ERR_UNREACHABLE' });
    }
  }

  async function openSocket(entry, message) {
    const { id } = message;
    const refuse = (error) => reply(entry, { t: 'wserr', id, error }).then(() =>
      reply(entry, { t: 'wsclose', id, code: 1006, reason: '' }));
    if (getSettings?.().allowProxy === false || !bridge.capabilities.websockets) {
      return refuse('This PC does not relay WebSockets.');
    }
    if (entry.sockets.size >= MAX_SOCKETS || entry.sockets.has(id) || typeof message.url !== 'string') {
      return refuse('WebSocket refused.');
    }
    entry.sockets.add(id);
    try {
      await bridge.wsOpen({
        id: `${entry.sessionId}:${id}`,
        url: message.url,
        protocols: Array.isArray(message.protocols) ? message.protocols.map(String) : [],
        headers: message.headers && typeof message.headers === 'object' ? message.headers : {},
      });
    } catch (err) {
      entry.sockets.delete(id);
      return refuse(cleanIpcError(err));
    }
    return undefined;
  }

  function sendSocket(entry, id, data) {
    if (entry.sockets.has(id)) bridge.wsSend(`${entry.sessionId}:${id}`, data);
  }

  function closeSocket(entry, id, code, reason) {
    if (entry.sockets.has(id)) bridge.wsClose(`${entry.sessionId}:${id}`, Number(code) || 1000, String(reason || ''));
  }

  async function handle(entry, job) {
    // Checked per request, not per session: switching browser traffic off on
    // the PC has to stop a channel that is already open, too.
    if (getSettings?.().allowProxy === false) {
      return reply(entry, { t: 'err', id: job.id, error: 'The PC is not serving browser traffic.', code: 'ERR_REFUSED' });
    }
    const started = performance.now();
    try {
      const result = await bridge.fetch({
        url: job.url,
        method: job.method || 'GET',
        headers: job.headers && typeof job.headers === 'object' ? job.headers : {},
        body: typeof job.body === 'string' ? job.body : null,
        maxBytes: FETCH_MAX_BYTES,
      });
      onStat?.('requests', 1);
      onStat?.('bytes', Number(result.bytes) || 0);
      const ms = Math.round(performance.now() - started);
      log?.(`${result.status} ${short(job.url)} · ${ms}ms (fast lane)`, result.ok ? 'good' : 'warn');
      await sendResponse(entry, job.id, { ...result, durationMs: ms });
    } catch (err) {
      onStat?.('errors', 1);
      log?.(`failed ${short(job.url)}: ${err.message}`, 'error');
      await reply(entry, { t: 'err', id: job.id, error: err.message, code: err.code || 'ERR_UNREACHABLE' });
    }
  }

  async function sendResponse(entry, id, result) {
    const { body = '', ...meta } = result;
    const text = String(body);
    const n = Math.ceil(text.length / FETCH_CHUNK_CHARS);
    await reply(entry, { t: 'res', id, n, meta });
    for (let i = 0; i < n; i += 1) {
      await sendRaw(entry, `${id}\n${text.slice(i * FETCH_CHUNK_CHARS, (i + 1) * FETCH_CHUNK_CHARS)}`);
    }
  }

  const reply = (entry, message) => sendRaw(entry, JSON.stringify(message));

  /**
   * Sends, waiting for the channel to drain first if it is backed up.
   *
   * Every send for a session goes through one chain, so nothing overtakes
   * anything sent before it. Waiting per call was not enough: a message sent
   * while an earlier one waited for the buffer to drop below the high mark
   * could find it already below, go straight out, and land first — which,
   * for body frames or a socket's messages, is corruption.
   */
  function sendRaw(entry, data) {
    entry.sendChain = (entry.sendChain || Promise.resolve()).then(() => sendNow(entry, data));
    return entry.sendChain;
  }

  async function sendNow(entry, data) {
    const { channel } = entry;
    if (channel.readyState !== 'open') return;
    if (channel.bufferedAmount > BUFFER_HIGH) {
      await new Promise((resolve) => {
        const done = () => {
          channel.removeEventListener('bufferedamountlow', done);
          channel.removeEventListener('close', done);
          resolve();
        };
        channel.addEventListener('bufferedamountlow', done);
        channel.addEventListener('close', done);
      });
      if (channel.readyState !== 'open') return;
    }
    try {
      channel.send(data);
    } catch {
      /* The channel closed under us; the session is ending anyway. */
    }
  }

  function teardown(sessionId) {
    const entry = active.get(sessionId);
    if (!entry) return;
    active.delete(sessionId);
    entry.queue.length = 0;
    entry.uploads.clear();
    for (const id of entry.sockets) bridge.wsClose(`${sessionId}:${id}`, 1001, '');
    entry.sockets.clear();
    entry.stopAnswer?.();
    entry.detachIce?.();
    try { entry.channel.close(); } catch { /* already closed */ }
    try { entry.pc.close(); } catch { /* already closed */ }
    remove(ref(db, paths.session(machineId, sessionId))).catch(() => {});
  }

  return {
    stop() {
      stopped = true;
      stopAdded();
      stopRemoved();
      stopWsEvents();
      for (const id of Array.from(active.keys())) teardown(id);
    },
  };
}

async function sweepStaleSessions(db, machineId) {
  const snapshot = await get(ref(db, paths.sessions(machineId)));
  const now = Date.now();
  const dead = [];
  snapshot.forEach((child) => {
    if (child.val()?.mode !== 'fetch') return;
    if (now - (Number(child.val()?.createdAt) || 0) > SESSION_MAX_AGE_MS) dead.push(child.key);
  });
  await Promise.all(dead.map((id) => remove(ref(db, paths.session(machineId, id)))));
}

/** Electron wraps errors from main as "Error invoking remote method 'x': Error: …". */
function cleanIpcError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}

function short(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 28 ? `${parsed.pathname.slice(0, 27)}…` : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return String(url).slice(0, 48);
  }
}
