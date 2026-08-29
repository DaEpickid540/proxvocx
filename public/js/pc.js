/**
 * The PC connector's controller.
 *
 * The same code drives the Firebase-hosted page and the desktop app's window;
 * `hostBridge` is the only thing that knows the difference. Its job:
 * register this machine, keep presence fresh, get itself paired to one or
 * more accounts (several Google accounts can share the same PC), and then
 * serve those accounts' proxy requests and sessions.
 */
import {
  initFirebase,
  MissingConfigError,
  usePersistentAuth,
  waitForAuth,
  signInWithGoogle,
  signOut,
  describeAuthError,
  serverNow,
  ref,
  get,
  set,
  update,
  remove,
  onValue,
  onDisconnect,
} from './firebase.js';
import { paths, generateMachineId, HEARTBEAT_MS, formatPairingCode } from './paths.js';
import { publishPairingCode, revokePairingCode, watchForClaim } from './pairing.js';
import { hostBridge } from './host-bridge.js';
import { startProxyServer } from './pc-proxy.js';
import { startControlHost } from './pc-control.js';
import { startScriptedBrowserHost } from './pc-scripted-browser.js';
import { $, el, openModal, toast, confirmModal, formatBytes } from './ui.js';

const DEFAULT_SETTINGS = {
  allowControl: true,
  allowScripts: false,
  allowInput: true,
  allowProxy: true,
  maxHeight: 1080,
  frameRate: 30,
  screenSourceId: null,
  autoLaunch: false,
};

const state = {
  db: null,
  auth: null,
  machineId: null,
  machineName: 'This PC',
  owners: {},  // uid -> true, for every account this PC is paired to
  settings: { ...DEFAULT_SETTINGS },
  stats: { requests: 0, bytes: 0, sessions: 0, errors: 0 },
  proxy: null,
  control: null,
  scripted: null,
  pairing: null,
  heartbeat: null,
};

/* ── logging ─────────────────────────────────────────────────── */

const logHost = $('#log');
const LOG_LIMIT = 300;

function log(message, kind = '') {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const line = el('div', { class: `log-line ${kind}` },
    el('span', { class: 'log-time' }, time),
    el('span', { class: 'log-msg' }, message),
  );
  const pinned = logHost.scrollTop + logHost.clientHeight >= logHost.scrollHeight - 24;
  logHost.append(line);
  while (logHost.childElementCount > LOG_LIMIT) logHost.firstElementChild.remove();
  if (pinned) logHost.scrollTop = logHost.scrollHeight;
}

function bumpStat(key, amount) {
  state.stats[key] = (state.stats[key] || 0) + amount;
  renderStats();
}

function renderStats() {
  $('#statRequests').textContent = state.stats.requests.toLocaleString();
  $('#statBytes').textContent = formatBytes(state.stats.bytes);
  $('#statSessions').textContent = state.stats.sessions.toLocaleString();
  $('#statErrors').textContent = state.stats.errors.toLocaleString();
}

/* ── status chrome ───────────────────────────────────────────── */

function setStatus(text, tone = 'idle') {
  $('#statusPill').textContent = text;
  const dot = $('#statusDot');
  dot.classList.toggle('logo-dot--live', tone === 'live');
  dot.classList.toggle('logo-dot--idle', tone === 'idle');
  hostBridge.reportStatus({ text, tone });
}

/* ── capabilities panel ──────────────────────────────────────── */

function renderCapabilities() {
  const caps = hostBridge.capabilities;
  const rows = [
    {
      ok: caps.proxy && state.settings.allowProxy,
      warn: caps.proxy && !state.settings.allowProxy,
      name: 'Browser proxy',
      detail: !caps.proxy
        ? 'Needs the desktop app — a web page cannot fetch other origins.'
        : state.settings.allowProxy
          ? 'Fetching pages on behalf of the client.'
          : 'Switched off in settings.',
    },
    {
      ok: caps.capture && state.settings.allowControl,
      warn: caps.capture && !state.settings.allowControl,
      name: caps.captureSilent ? 'Screen capture' : 'Screen capture (picker)',
      detail: !caps.capture
        ? 'This host cannot capture the screen.'
        : !state.settings.allowControl
          ? 'Remote control is switched off in settings.'
          : caps.captureSilent
            ? 'Shares the selected display without prompting.'
            : 'The browser will ask which window to share each session.',
    },
    {
      ok: caps.input && state.settings.allowInput,
      warn: caps.input && !state.settings.allowInput,
      name: 'Remote input',
      detail: !caps.input
        ? hostBridge.isDesktop
          ? 'The optional input backend is not installed — sessions will be view-only.'
          : 'Needs the desktop app. Sessions from a browser tab are view-only.'
        : state.settings.allowInput
          ? 'Mouse and keyboard will be replayed on this desktop.'
          : 'View-only: input is switched off in settings.',
    },
    {
      ok: caps.scripts && state.settings.allowScripts,
      warn: caps.scripts && !state.settings.allowScripts,
      name: 'Scripted Browser mode',
      detail: !caps.scripts
        ? 'Needs the desktop app — a plain browser tab cannot run a second real browser.'
        : state.settings.allowScripts
          ? 'Browser mode opens a real, scripted tab on this PC — full JavaScript and WebSockets.'
          : 'Off by default. Browser mode falls back to a script-free page render.',
    },
  ];

  $('#capList').replaceChildren(...rows.map((row) => {
    const cls = row.ok ? 'ok' : row.warn ? 'warn' : 'off';
    const glyph = row.ok ? '✓' : row.warn ? '!' : '–';
    return el('div', { class: `cap ${cls}` },
      el('span', { class: 'cap-icon' }, glyph),
      el('div', {},
        el('div', { class: 'cap-name' }, row.name),
        el('div', { class: 'cap-detail' }, row.detail),
      ),
    );
  }));

  $('#browserNotice').hidden = hostBridge.isDesktop;
}

/* ── pairing panel ───────────────────────────────────────────── */

let countdownTimer = null;

async function enterPairingMode() {
  $('#pairPanel').hidden = false;
  $('#linkCard').hidden = true;
  $('#statsCard').hidden = true;
  $('#logCard').hidden = true;
  setStatus('Waiting to be paired', 'idle');

  await issueCode();
}

/**
 * Publishes one code and watches for it to be claimed, writing progress into
 * whatever `codeEl`/`countdownEl` are handed in — the dedicated unpaired
 * panel and the "add another account" modal are the same flow pointed at
 * different DOM.
 */
async function runPairingFlow({ codeEl, countdownEl, onPaired, onError }) {
  clearInterval(countdownTimer);
  if (state.pairing) {
    state.pairing.stop();
    await revokePairingCode(state.db, state.pairing.code);
  }

  codeEl.classList.remove('expired');
  codeEl.textContent = '••••-••••';

  let published;
  try {
    published = await publishPairingCode(state.db, {
      machineId: state.machineId,
      machineName: state.machineName,
      deviceUid: state.auth.currentUser.uid,
    });
  } catch (err) {
    log(`could not publish a pairing code: ${err.message}`, 'error');
    countdownEl.textContent = 'Could not reach Firebase.';
    return;
  }

  codeEl.textContent = formatPairingCode(published.code);
  log('pairing code ready, valid for 5 minutes');

  const stop = watchForClaim(state.db, {
    machineId: state.machineId,
    code: published.code,
    onPaired: (uid) => {
      clearInterval(countdownTimer);
      state.pairing = null;
      log(`paired to account ${uid.slice(0, 8)}…`, 'good');
      onPaired?.(uid);
    },
    onError: (err) => {
      log(`pairing failed: ${err.message}`, 'error');
      onError?.(err);
    },
  });
  state.pairing = { code: published.code, stop };

  countdownTimer = setInterval(() => {
    const left = published.expiresAt - Date.now();
    if (left <= 0) {
      clearInterval(countdownTimer);
      codeEl.classList.add('expired');
      countdownEl.innerHTML = 'This code has expired.';
      return;
    }
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    countdownEl.innerHTML =
      `Expires in <strong>${mins}:${String(secs).padStart(2, '0')}</strong>`;
  }, 500);
}

function issueCode() {
  return runPairingFlow({
    codeEl: $('#pairCode'),
    countdownEl: $('#pairCountdown'),
    onPaired: () => toast('Paired', 'success'),
  });
}

/** Lets an already-paired PC add a second (or third) Google account. */
function openAddAccountModal() {
  return openModal((close) => {
    const codeEl = el('div', { class: 'pair-code' }, '••••-••••');
    const countdownEl = el('p', { class: 'pair-countdown' }, 'Publishing a code…');

    runPairingFlow({
      codeEl,
      countdownEl,
      onPaired: (uid) => {
        toast('Account added', 'success');
        close(uid);
      },
    });

    const copyBtn = el('button', { class: 'btn btn--ghost btn--sm' }, 'Copy');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codeEl.textContent);
        toast('Code copied', 'success');
      } catch {
        toast('Could not reach the clipboard', 'danger');
      }
    });

    return el('div', {},
      el('h2', { class: 'modal-title' }, 'Add another account'),
      el('p', { class: 'modal-sub' },
        'Sign in on the client with the Google account you want to add, choose ' +
        '“Add a PC with a code”, and type this in. Both accounts keep working afterwards.'),
      codeEl,
      countdownEl,
      el('div', { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } }, copyBtn),
    );
  }, { dismissable: true }).finally(() => {
    if (state.pairing) {
      state.pairing.stop();
      revokePairingCode(state.db, state.pairing.code);
      state.pairing = null;
    }
  });
}

/* ── paired mode ─────────────────────────────────────────────── */

function enterPairedMode() {
  clearInterval(countdownTimer);
  if (state.pairing) {
    state.pairing.stop();
    revokePairingCode(state.db, state.pairing.code);
    state.pairing = null;
  }

  $('#pairPanel').hidden = true;
  $('#linkCard').hidden = false;
  $('#statsCard').hidden = false;
  $('#logCard').hidden = false;

  $('#machineName').textContent = state.machineName;
  $('#machineIdText').textContent = state.machineId;
  $('#deviceText').textContent = state.auth.currentUser.uid;
  renderOwnerList();

  setStatus('Online · waiting for the client', 'live');
  renderStats();

  if (!state.proxy) {
    state.proxy = startProxyServer({
      db: state.db,
      machineId: state.machineId,
      bridge: hostBridge,
      log,
      onStat: bumpStat,
      getSettings: () => state.settings,
    });
    log('serving proxy requests', 'good');
  }

  if (!state.control) {
    state.control = startControlHost({
      db: state.db,
      machineId: state.machineId,
      bridge: hostBridge,
      log,
      onStat: bumpStat,
      getSettings: () => state.settings,
      onSessionChange: renderSessions,
    });
    log('listening for control sessions', 'good');
  }

  if (!state.scripted) {
    state.scripted = startScriptedBrowserHost({
      db: state.db,
      machineId: state.machineId,
      bridge: hostBridge,
      log,
      onStat: bumpStat,
      getSettings: () => state.settings,
      onSessionChange: renderSessions,
    });
    log('listening for scripted browser sessions', 'good');
  }
}

function renderSessions() {
  const count = (state.control?.sessions.length || 0) + (state.scripted?.sessions.length || 0);
  const banner = $('#liveBanner');
  banner.hidden = count === 0;
  if (count) {
    $('#liveText').textContent = count === 1
      ? 'A client is connected to this PC.'
      : `${count} clients are connected to this PC.`;
    setStatus('Online · session active', 'live');
  } else if (Object.keys(state.owners).length) {
    setStatus('Online · waiting for the client', 'live');
  }
}

function renderOwnerList() {
  const uids = Object.keys(state.owners);
  $('#ownerList').replaceChildren(...uids.map((uid) => {
    const revokeBtn = el('button', { class: 'btn btn--xs', title: 'Revoke this account' }, 'Revoke');
    revokeBtn.addEventListener('click', () => revokeOwner(uid));
    return el('div', { class: 'row', style: { justifyContent: 'space-between' } },
      el('span', { class: 'owner-val mono', style: { fontSize: '0.72rem' } }, uid),
      revokeBtn,
    );
  }));
}

async function revokeOwner(uid) {
  const sure = await confirmModal({
    title: 'Revoke this account?',
    message: 'That account loses access to this PC immediately.',
    confirmLabel: 'Revoke',
    danger: true,
  });
  if (!sure) return;
  try {
    await remove(ref(state.db, paths.owner(state.machineId, uid)));
    toast('Access revoked', 'info');
  } catch (err) {
    toast(`Could not revoke: ${err.message}`, 'danger');
  }
}

/* ── settings ────────────────────────────────────────────────── */

async function openSettings() {
  const sources = hostBridge.capabilities.captureSilent
    ? await hostBridge.listScreenSources().catch(() => [])
    : [];

  await openModal((close) => {
    const nameInput = el('input', { class: 'text-input', value: state.machineName, maxlength: 48 });

    const toggle = (key, name, detail, enabled = true) => {
      const button = el('button', {
        class: 'switch',
        role: 'switch',
        'aria-checked': String(!!state.settings[key]),
        disabled: !enabled,
      });
      button.addEventListener('click', () => {
        state.settings[key] = !state.settings[key];
        button.setAttribute('aria-checked', String(state.settings[key]));
        persistSettings();
        renderCapabilities();
        if (key === 'allowControl' && !state.settings[key]) {
          state.control?.endAll('remote control was switched off');
        }
        if (key === 'allowScripts' && !state.settings[key]) {
          state.scripted?.endAll('JavaScript was switched off for Browser mode');
        }
      });
      return el('div', { class: 'toggle-row' },
        el('div', { class: 'toggle-copy' },
          el('div', { class: 'toggle-name' }, name),
          el('div', { class: 'toggle-detail' }, detail),
        ),
        button,
      );
    };

    const quality = el('select', { class: 'select-input' },
      ...[
        [720, '720p · lightest'],
        [1080, '1080p · balanced'],
        [1440, '1440p · sharp'],
        [2160, 'Native · heaviest'],
      ].map(([value, label]) =>
        el('option', { value, selected: state.settings.maxHeight === value }, label)),
    );
    quality.addEventListener('change', () => {
      state.settings.maxHeight = Number(quality.value);
      persistSettings();
    });

    const display = sources.length
      ? el('select', { class: 'select-input' },
          ...sources.map((source) =>
            el('option', {
              value: source.id,
              selected: state.settings.screenSourceId === source.id,
            }, source.name)),
        )
      : null;
    display?.addEventListener('change', () => {
      state.settings.screenSourceId = display.value;
      persistSettings();
    });

    const unpair = el('button', { class: 'btn btn--danger btn--full' }, 'Unpair this PC (revoke everyone)');
    unpair.addEventListener('click', async () => {
      const sure = await confirmModal({
        title: 'Unpair this PC?',
        message:
          `Every account with access (${Object.keys(state.owners).length}) loses it immediately, ` +
          'and this machine goes back to showing a pairing code. To remove just one account, use ' +
          'the Revoke button next to it on the main screen instead.',
        confirmLabel: 'Unpair everyone',
        danger: true,
      });
      if (!sure) return;
      close(false);
      await unpairSelf();
    });

    const signOutBtn = el('button', { class: 'btn btn--ghost btn--full' }, 'Sign out of this PC');
    signOutBtn.addEventListener('click', async () => {
      const sure = await confirmModal({
        title: 'Sign out of this PC?',
        message:
          'This PC keeps a Google identity of its own, separate from the accounts paired to it. ' +
          'Signing out means signing back in — with the same or a different Google account — before ' +
          'this connector can do anything. If you sign back in with a different account, this becomes ' +
          'a brand new machine and needs pairing again; the paired accounts stay exactly as they are.',
        confirmLabel: 'Sign out',
        danger: true,
      });
      if (!sure) return;
      close(false);
      state.control?.endAll('signing out of this PC');
      state.scripted?.endAll('signing out of this PC');
      await signOut(state.auth);
      location.reload();
    });

    return el('div', {},
      el('h2', { class: 'modal-title' }, 'Connector settings'),
      el('p', { class: 'modal-sub' }, 'Applies to this machine only.'),

      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, 'Name shown on the client'),
        nameInput,
      ),

      el('div', { class: 'section-label', style: { marginTop: '18px' } }, 'Permissions'),
      toggle('allowProxy', 'Serve browser traffic',
        'Fetch pages the client asks for.', hostBridge.capabilities.proxy),
      toggle('allowControl', 'Allow remote sessions',
        'Let the paired account view this screen.', hostBridge.capabilities.capture),
      toggle('allowInput', 'Allow remote input',
        'Replay mouse and keyboard. Off means view-only.', hostBridge.capabilities.input),

      el('div', { class: 'section-label', style: { marginTop: '18px' } }, 'Browser mode'),
      toggle('allowScripts', 'Allow JavaScript in Browser mode',
        'Opens a real, scripted browser tab on this PC instead of a script-free page render — ' +
        'full JavaScript and WebSockets, at the cost of it no longer being a lightweight text proxy. ' +
        'Off by default.', hostBridge.capabilities.scripts),

      el('div', { class: 'section-label', style: { marginTop: '18px' } }, 'Screen'),
      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, 'Streaming quality'),
        quality,
      ),
      display
        ? el('div', { class: 'field' },
            el('span', { class: 'field-label' }, 'Display to share'),
            display,
          )
        : null,

      hostBridge.isDesktop ? autoLaunchRow() : null,

      el('div', { class: 'section-label', style: { marginTop: '18px' } }, 'Danger zone'),
      Object.keys(state.owners).length ? unpair : el('p', { class: 'hint' }, 'This PC is not paired yet.'),
      signOutBtn,

      el('div', { class: 'modal-footer' },
        el('button', { class: 'btn btn--ghost', onClick: () => close(false) }, 'Close'),
        el('button', {
          class: 'btn btn--primary',
          onClick: async () => {
            const name = nameInput.value.trim() || 'This PC';
            if (name !== state.machineName) {
              state.machineName = name;
              await update(ref(state.db, paths.machineMeta(state.machineId)), { name });
              await hostBridge.saveStore({ machineName: name });
              $('#machineName').textContent = name;
              log(`renamed to "${name}"`);
            }
            close(true);
          },
        }, 'Save'),
      ),
    );
  }, { width: '560px' });
}

function autoLaunchRow() {
  const button = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(state.settings.autoLaunch) });
  button.addEventListener('click', async () => {
    state.settings.autoLaunch = !state.settings.autoLaunch;
    button.setAttribute('aria-checked', String(state.settings.autoLaunch));
    await hostBridge.setAutoLaunch(state.settings.autoLaunch);
    persistSettings();
  });
  return el('div', {},
    el('div', { class: 'section-label', style: { marginTop: '18px' } }, 'Desktop app'),
    el('div', { class: 'toggle-row' },
      el('div', { class: 'toggle-copy' },
        el('div', { class: 'toggle-name' }, 'Start with this computer'),
        el('div', { class: 'toggle-detail' }, 'Launch to the tray on sign-in so the PC is always reachable.'),
      ),
      button,
    ),
  );
}

function persistSettings() {
  hostBridge.saveStore({ settings: state.settings });
  update(ref(state.db, paths.presence(state.machineId)), {
    capabilities: currentCapabilities(),
  }).catch(() => {});
}

function currentCapabilities() {
  const caps = hostBridge.capabilities;
  return {
    proxy: !!(caps.proxy && state.settings.allowProxy),
    control: !!(caps.capture && state.settings.allowControl),
    input: !!(caps.input && state.settings.allowInput),
    scripts: !!(caps.scripts && state.settings.allowScripts),
  };
}

async function unpairSelf() {
  try {
    await remove(ref(state.db, paths.owners(state.machineId)));
    state.control?.endAll('the PC was unpaired');
    state.scripted?.endAll('the PC was unpaired');
    log('unpaired', 'warn');
    toast('This PC is no longer paired', 'info');
  } catch (err) {
    toast(`Could not unpair: ${err.message}`, 'danger');
  }
}

/* ── registration & presence ─────────────────────────────────── */

async function registerMachine() {
  const uid = state.auth.currentUser.uid;
  const machineRef = ref(state.db, paths.machine(state.machineId));
  const snapshot = await get(machineRef).catch(() => null);

  if (snapshot?.exists() && snapshot.val().deviceUid && snapshot.val().deviceUid !== uid) {
    // The stored machine id belongs to a device account we have lost — start
    // over rather than fighting the rules on every write.
    log('this machine id belongs to another device account, re-registering', 'warn');
    state.machineId = generateMachineId();
    await hostBridge.saveStore({ machineId: state.machineId });
    return registerMachine();
  }

  if (!snapshot?.exists()) {
    try {
      await set(machineRef, {
        deviceUid: uid,
        meta: {
          name: state.machineName,
          platform: hostBridge.platform,
          appVersion: hostBridge.version || 'web',
          createdAt: Date.now(),
        },
      });
      log('registered this machine');
    } catch (err) {
      // A read denied by the rules looks identical to "does not exist yet"
      // from here — the get() above cannot tell "brand new id" from "this id
      // belongs to a different identity" (e.g. a stale id from before
      // Google-only auth, whose deviceUid can never sign in again). If the
      // create-write also fails, it is the latter: the node really does
      // exist server-side, just not under this identity. Stop fighting the
      // rules for a name that is not ours and mint a fresh one instead.
      log(`could not claim machine id ${state.machineId} (${err.code || err.message}) — it belongs to a different identity, generating a new one`, 'warn');
      state.machineId = generateMachineId();
      await hostBridge.saveStore({ machineId: state.machineId });
      return registerMachine();
    }
  } else {
    await update(ref(state.db, paths.machineMeta(state.machineId)), {
      name: state.machineName,
      platform: hostBridge.platform,
      appVersion: hostBridge.version || 'web',
    });
    state.owners = snapshot.val().owners || {};
    const storedName = snapshot.val().meta?.name;
    if (storedName) state.machineName = storedName;
  }
}

async function startPresence() {
  const presenceRef = ref(state.db, paths.presence(state.machineId));
  const beat = () => update(presenceRef, {
    online: true,
    lastSeen: serverNow(),
    capabilities: currentCapabilities(),
  }).catch(() => {});

  await onDisconnect(presenceRef).update({ online: false, lastSeen: serverNow() });
  await beat();
  state.heartbeat = setInterval(beat, HEARTBEAT_MS);

  // Best effort on a clean close; the onDisconnect above is the real backstop.
  window.addEventListener('pagehide', () => {
    update(presenceRef, { online: false, lastSeen: serverNow() }).catch(() => {});
  });
}

/* ── sign-in gate ────────────────────────────────────────────── */

/**
 * There is no anonymous fallback any more, and `signInWithPopup` needs a
 * genuine user gesture — so boot stalls here, showing a button, until
 * somebody actually clicks it.
 */
function signInGate() {
  $('#bootSpinner').hidden = true;
  $('#bootLabel').hidden = true;
  $('#signInGate').hidden = false;

  return new Promise((resolve) => {
    $('#pcGoogleBtn').addEventListener('click', async () => {
      const button = $('#pcGoogleBtn');
      const error = $('#signInError');
      error.hidden = true;
      button.disabled = true;
      try {
        const cred = await signInWithGoogle(state.auth);
        $('#signInGate').hidden = true;
        $('#bootSpinner').hidden = false;
        $('#bootLabel').hidden = false;
        resolve(cred.user);
      } catch (err) {
        error.textContent = describeAuthError(err);
        error.hidden = false;
        button.disabled = false;
      }
    });
  });
}

/* ── boot ────────────────────────────────────────────────────── */

async function main() {
  document.body.dataset.shell = hostBridge.isDesktop ? 'desktop' : 'browser';
  $('#shellBadge').textContent = hostBridge.isDesktop
    ? `desktop ${hostBridge.version || ''}`.trim()
    : 'browser tab';

  let firebase;
  try {
    firebase = initFirebase();
  } catch (err) {
    if (err instanceof MissingConfigError) {
      location.replace('../');
      return;
    }
    throw err;
  }

  state.db = firebase.db;
  state.auth = firebase.auth;
  await usePersistentAuth(state.auth);

  $('#bootLabel').textContent = 'Checking sign-in…';
  const restored = await waitForAuth(state.auth);
  await (restored ? Promise.resolve(restored) : signInGate());

  await hostBridge.probe();

  const store = await hostBridge.loadStore();
  state.machineId = store.machineId || generateMachineId();
  state.machineName = store.machineName || (await hostBridge.defaultName());
  state.settings = { ...DEFAULT_SETTINGS, ...(store.settings || {}) };
  if (hostBridge.isDesktop) {
    state.settings.autoLaunch = await hostBridge.getAutoLaunch();
  }
  await hostBridge.saveStore({ machineId: state.machineId, machineName: state.machineName });

  $('#bootLabel').textContent = 'Registering this machine…';
  await registerMachine();
  await startPresence();

  renderCapabilities();
  $('#boot').hidden = true;
  log(`connector up as ${state.machineName}`, 'good');

  // Ownership drives the whole UI: nobody paired shows a code, at least one
  // owner starts work. The set can change shape after that too — adding or
  // revoking an account — without ever leaving paired mode.
  //
  // Which mode we are in is tracked explicitly rather than inferred from
  // "did the owner set just become non-empty": registerMachine() has already
  // populated state.owners by the time this subscribes, so on an
  // already-paired PC that transition never happens. That left the connector
  // silently half-started — the paired cards stayed hidden, the status pill
  // stayed on "Connecting…", and startControlHost() (which lives in
  // enterPairedMode) never ran, so client sessions were never answered.
  let uiMode = null;
  onValue(ref(state.db, paths.owners(state.machineId)), (snapshot) => {
    const owners = snapshot.val() || {};
    state.owners = owners;

    if (Object.keys(owners).length === 0) {
      if (uiMode !== 'pairing') { uiMode = 'pairing'; enterPairingMode(); }
      return;
    }
    if (uiMode !== 'paired') { uiMode = 'paired'; enterPairedMode(); }
    else renderOwnerList();
  }, (err) => log(`ownership watch failed: ${err.message}`, 'error'));

  /* controls */
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#newCodeBtn').addEventListener('click', () => issueCode());
  $('#addAccountBtn').addEventListener('click', () => openAddAccountModal());
  $('#copyCodeBtn').addEventListener('click', async () => {
    if (!state.pairing) return;
    try {
      await navigator.clipboard.writeText(formatPairingCode(state.pairing.code));
      toast('Code copied', 'success');
    } catch {
      toast('Could not reach the clipboard', 'danger');
    }
  });
  $('#endSessionBtn').addEventListener('click', () => {
    state.control?.endAll('ended on the PC');
    state.scripted?.endAll('ended on the PC');
  });
  $('#clearLogBtn').addEventListener('click', () => logHost.replaceChildren());
  $('#resetStatsBtn').addEventListener('click', () => {
    state.stats = { requests: 0, bytes: 0, sessions: 0, errors: 0 };
    renderStats();
  });
}

main().catch((err) => {
  $('#boot').hidden = true;
  $('#pairPanel').hidden = true;
  document.querySelector('.pc-body').prepend(
    el('div', { class: 'notice notice--danger pc-wide' },
      `The connector could not start: ${err.message}`),
  );
  console.error(err);
});
