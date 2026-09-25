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
 * Wire format on the channel (label FETCH_CHANNEL):
 *   client → PC   {"t":"req","id":N,"url",...}         one JSON message
 *                 {"t":"cancel","id":N}                 drop it if not started
 *   PC → client   {"t":"res","id":N,"n":K,"meta":{…}}   everything but the body
 *                 "N\n<chunk>" × K                      the body, in order
 *                 {"t":"err","id":N,"error","code"}
 */
import { ref, set, update, remove, onValue, onChildAdded, onChildRemoved, get } from './firebase.js';
import { paths } from './paths.js';
import { iceServers, attachIce, SESSION_MAX_AGE_MS } from './signaling.js';

export const FETCH_CHANNEL = 'fetch';

/** Well under Chromium's 256 KiB message ceiling even if every char is 3 bytes. */
export const FETCH_CHUNK_CHARS = 60_000;

/** The cap asked for on this lane. The database lane keeps its own, smaller one. */
export const FETCH_MAX_BYTES = 8 * 1024 * 1024;

const MAX_CONCURRENT = 8;
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
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    const detachIce = attachIce(db, machineId, sessionId, pc, 'host');

    const entry = { pc, channel, detachIce, queue: [], inFlight: 0, cancelled: new Set() };
    active.set(sessionId, entry);

    channel.addEventListener('message', (event) => onMessage(entry, event.data));
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) teardown(sessionId);
      else if (pc.connectionState === 'connected') log?.('browser fast lane connected', 'good');
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await set(ref(db, paths.sessionOffer(machineId, sessionId)), { type: offer.type, sdp: offer.sdp });
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
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!Number.isInteger(message?.id)) return;
    if (message.t === 'cancel') {
      entry.cancelled.add(message.id);
      return;
    }
    if (message.t !== 'req' || typeof message.url !== 'string') return;
    entry.queue.push(message);
    pump(entry);
  }

  function pump(entry) {
    while (entry.inFlight < MAX_CONCURRENT && entry.queue.length) {
      const job = entry.queue.shift();
      if (entry.cancelled.delete(job.id)) continue;
      entry.inFlight += 1;
      handle(entry, job).finally(() => {
        entry.inFlight -= 1;
        pump(entry);
      });
    }
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

  /** Sends, waiting for the channel to drain first if it is backed up. */
  async function sendRaw(entry, data) {
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

function short(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 28 ? `${parsed.pathname.slice(0, 27)}…` : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return String(url).slice(0, 48);
  }
}
