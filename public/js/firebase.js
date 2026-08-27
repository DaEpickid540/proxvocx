/**
 * Firebase bootstrap shared by the root portal, the PC connector and the
 * client app. Nothing here needs Cloud Functions or a service account —
 * every participant is an ordinary Web SDK client and the Realtime Database
 * rules decide who may read or write what.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  setPersistence,
  browserLocalPersistence,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getDatabase,
  ref,
  child,
  push,
  get,
  set,
  update,
  remove,
  onValue,
  onChildAdded,
  onChildRemoved,
  onDisconnect,
  serverTimestamp,
  query,
  orderByChild,
  limitToLast,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';

import { FIREBASE_CONFIG } from './firebase-config.js';

export {
  ref, child, push, get, set, update, remove,
  onValue, onChildAdded, onChildRemoved, onDisconnect,
  serverTimestamp, query, orderByChild, limitToLast,
  onAuthStateChanged, signOut,
  signInWithPopup, GoogleAuthProvider,
};

/**
 * The only sign-in method this app offers, anywhere. Forces Google's account
 * chooser every time instead of silently re-using whichever Google session
 * is already active in the browser, so "sign in" always means an actual,
 * visible prompt rather than an invisible pass-through.
 */
export function signInWithGoogle(auth) {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth, provider);
}

const STORAGE_KEY = 'proxvocx.firebaseConfig';
const REQUIRED_KEYS = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'];

export class MissingConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingConfigError';
  }
}

function isComplete(cfg) {
  return !!cfg && REQUIRED_KEYS.every((k) => typeof cfg[k] === 'string' && cfg[k].trim());
}

/** The stored config, or the baked-in one, or null. */
export function readStoredConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isComplete(parsed)) return parsed;
    }
  } catch {
    /* corrupt entry — fall through to the baked-in config */
  }
  return isComplete(FIREBASE_CONFIG) ? FIREBASE_CONFIG : null;
}

export function storeConfig(cfg) {
  if (!isComplete(cfg)) {
    const missing = REQUIRED_KEYS.filter((k) => !cfg?.[k]);
    throw new Error(`config is missing: ${missing.join(', ')}`);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function clearStoredConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Accepts either raw JSON or a pasted `const firebaseConfig = { … };` snippet
 * straight out of the Firebase console, which is what people actually have on
 * their clipboard.
 */
export function parseConfigSnippet(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) throw new Error('paste the firebaseConfig snippet from the Firebase console');

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('could not find a { … } object in that text');
  }
  const objectText = trimmed.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(objectText);
  } catch {
    // Not strict JSON — quote the bare keys and swap single quotes, then retry.
    const normalised = objectText
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
      .replace(/,(\s*[}\]])/g, '$1');
    try {
      parsed = JSON.parse(normalised);
    } catch {
      throw new Error('that does not look like a firebaseConfig object');
    }
  }

  if (!parsed.databaseURL && parsed.projectId) {
    // Hosting sometimes omits databaseURL; the default instance is derivable.
    parsed.databaseURL = `https://${parsed.projectId}-default-rtdb.firebaseio.com`;
  }
  if (!isComplete(parsed)) {
    const missing = REQUIRED_KEYS.filter((k) => !parsed[k]);
    throw new Error(`that config is missing: ${missing.join(', ')}`);
  }
  return parsed;
}

let cached = null;

/** Initialise (once) and hand back `{ app, auth, db, config }`. */
export function initFirebase() {
  if (cached) return cached;
  const config = readStoredConfig();
  if (!config) {
    throw new MissingConfigError('no Firebase configuration has been set for this browser yet');
  }
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getDatabase(app);
  cached = { app, auth, db, config };
  return cached;
}

/** Keep the session across reloads — the whole point of permanent pairing. */
export async function usePersistentAuth(auth) {
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch {
    /* Private-mode browsers refuse; sign-in still works for this tab. */
  }
}

/** Resolves with the current user (or null) once Firebase has restored state. */
export function waitForAuth(auth) {
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user);
    });
  });
}

/** Turns Firebase's error codes into something worth showing a person. */
export function describeAuthError(err) {
  const code = err?.code || '';
  const map = {
    'auth/popup-closed-by-user': 'The Google sign-in window was closed.',
    'auth/popup-blocked': 'Your browser blocked the Google sign-in popup.',
    'auth/cancelled-popup-request': 'Another sign-in was already in progress.',
    'auth/unauthorized-domain':
      'This domain is not in the Firebase authorised-domains list. Add it under Authentication → Settings.',
    'auth/operation-not-allowed':
      'Google sign-in is not enabled for this Firebase project — enable it under Authentication → Sign-in method.',
    'auth/network-request-failed': 'Could not reach Firebase. Check the network.',
  };
  return map[code] || err?.message || 'Something went wrong.';
}
