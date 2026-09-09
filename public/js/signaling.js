/**
 * WebRTC signalling carried over the Realtime Database.
 *
 * Only the handshake (offer, answer, ICE candidates) crosses Firebase — a few
 * kilobytes per session. The screen video and the input events then travel
 * peer-to-peer, so PC Control does not burn database bandwidth per frame and
 * does not need Cloud Functions to broker anything.
 *
 * The PC is the *host*: it owns the media, so it makes the offer and opens the
 * input data channel. The client is the *viewer*: it creates the session node
 * and answers.
 */
import { ref, push, set, remove, onValue, onChildAdded, onDisconnect } from './firebase.js';
import { paths } from './paths.js';

export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/**
 * Both peers need a TURN relay when neither can be reached directly (mobile
 * carrier NAT, most corporate networks). STUN alone covers the common home
 * case; drop credentials in here to cover the rest.
 */
export function iceServers(turn) {
  return turn?.urls ? [...ICE_SERVERS, turn] : ICE_SERVERS;
}

function candidatePayload(candidate) {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
  };
}

/**
 * Wires a peer connection's ICE machinery to the database. Returns a function
 * that detaches both listeners.
 */
export function attachIce(db, machineId, sessionId, pc, role) {
  const mine = role;
  const theirs = role === 'host' ? 'viewer' : 'host';
  const outbox = ref(db, paths.sessionIce(machineId, sessionId, mine));
  const inbox = ref(db, paths.sessionIce(machineId, sessionId, theirs));

  pc.addEventListener('icecandidate', (event) => {
    if (event.candidate) push(outbox, candidatePayload(event.candidate)).catch(() => {});
  });

  const stopInbox = onChildAdded(inbox, (snapshot) => {
    const value = snapshot.val();
    if (!value?.candidate) return;
    pc.addIceCandidate(new RTCIceCandidate(value)).catch(() => {
      /* Candidates that arrive before the remote description are re-offered
         by the browser's own retry; a hard failure here is not fatal. */
    });
  });

  return () => stopInbox();
}

/** Resolves once `path` holds a session description, or rejects on timeout. */
export function waitForDescription(db, path, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new Error('the other side did not answer in time'));
    }, timeoutMs);

    stop = onValue(ref(db, path), (snapshot) => {
      const value = snapshot.val();
      if (!value?.type || !value?.sdp) return;
      clearTimeout(timer);
      stop();
      resolve(value);
    });
  });
}

/* ── holding a session open ─────────────────────────────────────
 *
 * A session row is not bookkeeping: while one exists the connector has a
 * screen capture running and a peer connection open, and the only way it
 * learns to stop is the row disappearing (pc-control.js listens for
 * onChildRemoved). Close the tab without removing it and the PC keeps
 * capturing and encoding for nobody until the ten-minute stale sweep — which
 * only runs when the connector next restarts, so in practice until it does.
 *
 * Two mechanisms, because neither is sufficient alone:
 *
 *   - `onDisconnect`, registered per session, is the one that always works.
 *     The database server performs the delete on our behalf once our socket
 *     drops, no matter how the tab went: closed, crashed, killed, or carried
 *     out of signal range.
 *   - `beforeunload` is what makes it a *deliberate* close, giving the browser
 *     its "Leave site?" dialog so an accidental X doesn't silently drop a live
 *     session. It is the courtesy, not the guarantee: it needs prior user
 *     interaction to fire at all, and iOS Safari ignores it outright — which
 *     is precisely why the onDisconnect above is not optional.
 */

/** Session database paths this tab is currently holding open. */
const openSessions = new Map();

function warnBeforeUnload(event) {
  event.preventDefault();
  // Safari and older Chrome ignore preventDefault() here unless returnValue is
  // also set. The string itself is discarded — every current browser shows its
  // own wording rather than anything we supply.
  event.returnValue = '';
}

/**
 * Best effort on a clean close. A remove() started here frequently does not
 * outlive the page, which is what the onDisconnect registration is for; this
 * just spares the PC the round trip when the tab does go quietly.
 */
function releaseOnPagehide() {
  for (const { db, path } of openSessions.values()) remove(ref(db, path)).catch(() => {});
}

/** Armed only while at least one session is live — a page holding nothing
 *  open has no business interrupting a navigation. */
function syncUnloadGuards() {
  const method = openSessions.size ? 'addEventListener' : 'removeEventListener';
  window[method]('beforeunload', warnBeforeUnload);
  window[method]('pagehide', releaseOnPagehide);
}

export async function createSession(db, machineId, clientUid, mode = 'control', extra = {}) {
  const node = push(ref(db, paths.sessions(machineId)));
  await set(node, {
    clientUid,
    mode,
    state: 'requesting',
    createdAt: Date.now(),
    ...extra,
  });

  // Registered before the caller is told the session exists, so there is no
  // window in which a session is live with nothing arranged to clean it up.
  await onDisconnect(node).remove().catch(() => {});

  const path = paths.session(machineId, node.key);
  openSessions.set(path, { db, path });
  syncUnloadGuards();

  return node.key;
}

export function closeSession(db, machineId, sessionId) {
  if (!machineId || !sessionId) return Promise.resolve();
  const path = paths.session(machineId, sessionId);
  openSessions.delete(path);
  syncUnloadGuards();
  // Remove first so the PC hears immediately; cancelling afterwards just stops
  // the server holding a delete for a row that has already gone.
  return remove(ref(db, path))
    .catch(() => {})
    .then(() => onDisconnect(ref(db, path)).cancel().catch(() => {}));
}

/** Sessions nobody cleaned up — swept by the PC when it comes online. */
export const SESSION_MAX_AGE_MS = 10 * 60 * 1000;
