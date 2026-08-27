/**
 * The single source of truth for the Realtime Database layout. Both sides of
 * every conversation import from here so a path can never drift.
 *
 *   machines/{machineId}
 *     meta        { name, platform, appVersion, createdAt }
 *     deviceUid   uid of the PC's own Google device account — written once
 *     owners      { uid: true, ... } — every account paired to this PC;
 *                 several Google accounts can share one machine
 *     presence    { online, lastSeen, capabilities: { proxy, control, input, scripts } }
 *     requests/{requestId}    any owner writes, PC reads and deletes
 *     responses/{requestId}   PC writes, that owner reads and deletes
 *     sessions/{sessionId}    WebRTC signalling for PC Control / scripted Browser mode
 *
 *   users/{uid}/machines/{machineId}   { name, pairedAt }
 *
 *   pairing/{code}   { machineId, machineName, deviceUid, createdAt, expiresAt, claimedBy }
 */

export const paths = {
  machine:      (m) => `machines/${m}`,
  machineMeta:  (m) => `machines/${m}/meta`,
  deviceUid:    (m) => `machines/${m}/deviceUid`,
  owners:       (m) => `machines/${m}/owners`,
  owner:        (m, uid) => `machines/${m}/owners/${uid}`,
  presence:     (m) => `machines/${m}/presence`,

  requests:     (m) => `machines/${m}/requests`,
  request:      (m, r) => `machines/${m}/requests/${r}`,
  responses:    (m) => `machines/${m}/responses`,
  response:     (m, r) => `machines/${m}/responses/${r}`,

  sessions:     (m) => `machines/${m}/sessions`,
  session:      (m, s) => `machines/${m}/sessions/${s}`,
  sessionOffer: (m, s) => `machines/${m}/sessions/${s}/offer`,
  sessionAnswer:(m, s) => `machines/${m}/sessions/${s}/answer`,
  /** ICE candidates, one bucket per role so neither side reads its own back. */
  sessionIce:   (m, s, role) => `machines/${m}/sessions/${s}/ice/${role}`,

  userMachines: (u) => `users/${u}/machines`,
  userMachine:  (u, m) => `users/${u}/machines/${m}`,

  pairing:      (code) => `pairing/${code}`,
};

/** How long a freshly generated pairing code stays usable. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/** Presence is refreshed on this cadence; anything older reads as offline. */
export const HEARTBEAT_MS = 20 * 1000;
export const PRESENCE_STALE_MS = 60 * 1000;

/**
 * Crockford-ish alphabet: no I, L, O, U, 0 or 1, so a code read off a screen
 * and typed on a phone cannot be misread. 30^8 ≈ 6.6e11 combinations, which
 * with a five minute TTL and single use makes guessing hopeless.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 8;

export function generatePairingCode() {
  // Rejection sampling: 256 is not a multiple of 30, so bytes at or above the
  // largest whole multiple would bias the low end of the alphabet.
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let out = '';
  while (out.length < CODE_LENGTH) {
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= limit) continue;
      out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

/**
 * Uppercases, drops separators, folds the look-alikes people type, then throws
 * away anything still outside the alphabet.
 */
export function normalisePairingCode(input) {
  return (input || '')
    .toUpperCase()
    .replace(/[IL1]/g, 'J')
    .replace(/[O0]/g, 'Q')
    .replace(/U/g, 'V')
    .split('')
    .filter((ch) => CODE_ALPHABET.includes(ch))
    .join('')
    .slice(0, CODE_LENGTH);
}

/** `K7F2-9QXB` — easier to read aloud and to copy off a screen. */
export function formatPairingCode(code) {
  if (!code) return '';
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A stable per-installation machine id. */
export function generateMachineId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isPresenceFresh(presence, now = Date.now()) {
  if (!presence?.online) return false;
  const seen = Number(presence.lastSeen) || 0;
  return now - seen < PRESENCE_STALE_MS;
}
