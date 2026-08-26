/**
 * One-time pairing that becomes permanent.
 *
 * The PC publishes a short-lived code at `pairing/{code}`. A signed-in client
 * that knows the code stamps its uid onto that node. The PC — the only party
 * the rules trust to do so — then writes `machines/{id}/ownerUid` and burns
 * the code. From then on the machine appears under `users/{uid}/machines` on
 * *every* device that account signs in on, so the code is never needed again.
 *
 *   PC                          Firebase                    client
 *   ──                          ────────                    ──────
 *   set pairing/{code}   ──────▶ pairing/{code}
 *                                                    ◀────── get pairing/{code}
 *                                pairing/{code}      ◀────── set claimedBy=uid
 *   onValue claimedBy    ◀──────
 *   set machines/{id}/ownerUid
 *   remove pairing/{code}
 *                                machines/{id}       ──────▶ onValue ownerUid
 *                                                            set users/{uid}/machines/{id}
 */
import { ref, get, set, update, remove, onValue } from './firebase.js';
import {
  paths,
  PAIRING_TTL_MS,
  generatePairingCode,
  normalisePairingCode,
} from './paths.js';

/** PC side: publish a fresh code. Returns `{ code, expiresAt }`. */
export async function publishPairingCode(db, { machineId, machineName, deviceUid }) {
  const code = generatePairingCode();
  const now = Date.now();
  const expiresAt = now + PAIRING_TTL_MS;
  await set(ref(db, paths.pairing(code)), {
    machineId,
    machineName: machineName || 'This PC',
    deviceUid,
    createdAt: now,
    expiresAt,
    claimedBy: null,
  });
  return { code, expiresAt };
}

export function revokePairingCode(db, code) {
  if (!code) return Promise.resolve();
  return remove(ref(db, paths.pairing(code))).catch(() => {});
}

/**
 * PC side: watch for a claim. When one lands, take ownership and burn the
 * code. `onPaired(uid)` fires once. Returns an unsubscribe function.
 */
export function watchForClaim(db, { machineId, code, onPaired, onError }) {
  let done = false;
  const stop = onValue(ref(db, paths.pairing(code)), async (snapshot) => {
    const value = snapshot.val();
    if (done || !value?.claimedBy) return;
    done = true;
    stop();
    try {
      await set(ref(db, paths.ownerUid(machineId)), value.claimedBy);
      await remove(ref(db, paths.pairing(code)));
      onPaired?.(value.claimedBy);
    } catch (err) {
      onError?.(err);
    }
  }, (err) => onError?.(err));

  return () => {
    done = true;
    stop();
  };
}

export class PairingError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PairingError';
    this.reason = code;
  }
}

/**
 * Client side: redeem a code typed by the user. Resolves with
 * `{ machineId, machineName }` once the PC has confirmed ownership.
 */
export async function claimPairingCode(db, rawCode, uid, { timeoutMs = 25_000 } = {}) {
  const code = normalisePairingCode(rawCode);
  if (code.length !== 8) {
    throw new PairingError('That code is not complete — it is 8 characters.', 'malformed');
  }

  const node = ref(db, paths.pairing(code));
  let snapshot;
  try {
    snapshot = await get(node);
  } catch {
    throw new PairingError('Could not check that code. Check your connection.', 'unreachable');
  }

  const entry = snapshot.val();
  if (!entry) {
    throw new PairingError('That code is not valid. Generate a new one on the PC.', 'unknown');
  }
  if (entry.claimedBy && entry.claimedBy !== uid) {
    throw new PairingError('That code has already been used.', 'claimed');
  }
  if (Number(entry.expiresAt) < Date.now()) {
    throw new PairingError('That code has expired. Generate a new one on the PC.', 'expired');
  }

  try {
    await update(node, { claimedBy: uid });
  } catch {
    throw new PairingError('That code could not be claimed — it may have just been used.', 'claimed');
  }

  await waitForOwnership(db, entry.machineId, uid, timeoutMs);

  await set(ref(db, paths.userMachine(uid, entry.machineId)), {
    name: entry.machineName || 'PC',
    pairedAt: Date.now(),
  });

  return { machineId: entry.machineId, machineName: entry.machineName || 'PC' };
}

function waitForOwnership(db, machineId, uid, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new PairingError('The PC did not confirm the pairing. Is it still online?', 'timeout'));
    }, timeoutMs);

    stop = onValue(
      ref(db, paths.ownerUid(machineId)),
      (snapshot) => {
        if (snapshot.val() !== uid) return;
        clearTimeout(timer);
        stop();
        resolve();
      },
      () => {
        /* Until ownerUid is ours the rules deny the read, which surfaces here
           as a permission error. Keep waiting — the retry below re-subscribes. */
      },
    );

    // The first subscribe usually fails the rules check, so poll gently until
    // the PC has stamped ownership and the read is permitted.
    const poll = setInterval(async () => {
      try {
        const snap = await get(ref(db, paths.ownerUid(machineId)));
        if (snap.val() === uid) {
          clearInterval(poll);
          clearTimeout(timer);
          stop();
          resolve();
        }
      } catch {
        /* still denied — keep polling */
      }
    }, 1200);

    setTimeout(() => clearInterval(poll), timeoutMs + 100);
  });
}

/** Client side: forget a machine. Only removes it from *this* account's list. */
export function unpairMachine(db, uid, machineId) {
  return remove(ref(db, paths.userMachine(uid, machineId)));
}
