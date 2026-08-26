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
import { ref, push, set, remove, onValue, onChildAdded } from './firebase.js';
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

export async function createSession(db, machineId, clientUid, mode = 'control') {
  const node = push(ref(db, paths.sessions(machineId)));
  await set(node, {
    clientUid,
    mode,
    state: 'requesting',
    createdAt: Date.now(),
  });
  return node.key;
}

export function closeSession(db, machineId, sessionId) {
  if (!machineId || !sessionId) return Promise.resolve();
  return remove(ref(db, paths.session(machineId, sessionId))).catch(() => {});
}

/** Sessions nobody cleaned up — swept by the PC when it comes online. */
export const SESSION_MAX_AGE_MS = 10 * 60 * 1000;
