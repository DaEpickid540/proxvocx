/**
 * Client app shell.
 *
 * Owns the account, the list of paired PCs, which one is selected, and which
 * of the two modes is on screen. Browser mode and PC Control mode are separate
 * modules that get handed the selected machine.
 *
 * The server picker is the gate: nothing loads until a PC is chosen, and it
 * comes back by itself if the chosen PC drops offline.
 */
import {
  initFirebase,
  MissingConfigError,
  usePersistentAuth,
  waitForAuth,
  signOut,
  serverNow,
  ref,
  get,
  onValue,
} from './firebase.js';
import { paths, isPresenceFresh, formatPairingCode } from './paths.js';
import { claimPairingCode, unpairMachine, PairingError } from './pairing.js';
import { createMiniBrowser, normaliseUrl } from './client-browser.js';
import { createControlViewer } from './client-control.js';
import { createScriptedBrowserViewer } from './client-scripted-browser.js';
import { $, el, openModal, toast, confirmModal, formatBytes, formatRelative, setBusy } from './ui.js';

const SELECTED_KEY = 'proxvocx.selectedMachine';
const LAST_MODE_KEY = 'proxvocx.mode';

const QUICK_LINKS = [
  ['Wikipedia', 'https://en.wikipedia.org'],
  ['Hacker News', 'https://news.ycombinator.com'],
  ['DuckDuckGo', 'https://duckduckgo.com/html/?q=proxvocx'],
  ['example.com', 'https://example.com'],
];

const state = {
  db: null,
  auth: null,
  uid: null,
  machines: new Map(),   // machineId -> { name, pairedAt, presence, meta }
  selected: null,
  mode: 'browser',
  browser: null,
  scriptedBrowser: null,
  control: null,
  presenceWatchers: new Map(),
  pickerOpen: false,
  scriptsActive: false,       // which Browser-mode engine is currently live
  notifiedNoScripts: new Set(), // machineIds already told "JS isn't enabled" this load
};

/** isPresenceFresh() against Firebase's clock, not this device's own. */
const fresh = (presence) => isPresenceFresh(presence, serverNow());

/** Whichever Browser-mode engine is currently backing the shared UI. */
function activeBrowser() {
  return state.scriptsActive ? state.scriptedBrowser : state.browser;
}

/**
 * Browser mode has two entirely different engines sharing one screen: the
 * script-free DOM rewriter (client-browser.js) and a real, scripted browser
 * tab on the PC (client-scripted-browser.js). Which one is live depends on
 * the selected machine's own "Allow JavaScript" setting, surfaced as
 * presence.capabilities.scripts — never assumed, always read fresh, since a
 * PC's setting can change mid-session.
 */
function syncBrowserEngine() {
  const entry = state.selected ? state.machines.get(state.selected) : null;
  const scriptsOn = !!(fresh(entry?.presence) && entry.presence.capabilities?.scripts);

  if (scriptsOn === state.scriptsActive) return;

  // Swapping engines mid-session tears down whichever one was live — the two
  // never run at once, and the one going idle has no business holding a
  // WebRTC session or a proxy fetch open in the background.
  state.browser?.reset();
  state.scriptedBrowser?.reset();

  state.scriptsActive = scriptsOn;
  $('#browserFrame').hidden = scriptsOn;
  $('#browserVideo').hidden = !scriptsOn;

  if (!scriptsOn && entry && state.mode === 'browser' && !state.notifiedNoScripts.has(state.selected)) {
    state.notifiedNoScripts.add(state.selected);
    noScriptsModal(entry.name);
  }
}

function noScriptsModal(machineName) {
  return openModal((close) =>
    el('div', {},
      el('h2', { class: 'modal-title' }, 'JavaScript isn’t enabled'),
      el('p', { class: 'modal-sub' },
        `${machineName || 'This PC'} is running Browser mode without JavaScript. Pages render as ` +
        'plain, static markup — fine for articles and simple sites, but games, most modern web ' +
        'apps, and anything that needs a live connection will not work.'),
      el('p', { class: 'hint', style: { marginBottom: '16px' } },
        'Turn on “Allow JavaScript in Browser mode” in the connector’s settings on the PC ' +
        'for a real, fully scripted browser tab instead — full JavaScript, full WebSockets.'),
      el('div', { class: 'modal-footer' },
        el('button', { class: 'btn btn--primary', onClick: () => close() }, 'Got it')),
    ),
  );
}

/* ── machine list ────────────────────────────────────────────── */

function watchMachines() {
  onValue(ref(state.db, paths.userMachines(state.uid)), (snapshot) => {
    const seen = new Set();
    snapshot.forEach((child) => {
      const id = child.key;
      seen.add(id);
      const existing = state.machines.get(id) || {};
      state.machines.set(id, { ...existing, ...child.val(), id });
      watchPresence(id);
    });

    for (const id of Array.from(state.machines.keys())) {
      if (seen.has(id)) continue;
      state.machines.delete(id);
      state.presenceWatchers.get(id)?.();
      state.presenceWatchers.delete(id);
      if (state.selected === id) selectMachine(null);
    }
    renderMachinePill();
  }, (err) => {
    toast(`Could not read your PCs: ${err.message}`, 'danger');
  });
}

function watchPresence(machineId) {
  if (state.presenceWatchers.has(machineId)) return;
  const stop = onValue(ref(state.db, paths.presence(machineId)), (snapshot) => {
    const entry = state.machines.get(machineId);
    if (!entry) return;
    const wasOnline = fresh(entry.presence);
    entry.presence = snapshot.val() || null;
    const isOnline = fresh(entry.presence);
    renderMachinePill();

    // The selected PC going away is exactly when the picker should reappear.
    if (state.selected === machineId && wasOnline && !isOnline) {
      toast(`${entry.name} went offline`, 'danger');
      openPicker({ reason: 'offline' });
    }
    if (state.selected === machineId) syncBrowserEngine();
  }, () => { /* denied means unpaired on the PC side; the list watch handles it */ });
  state.presenceWatchers.set(machineId, stop);
}

function machineList() {
  return Array.from(state.machines.values()).sort((a, b) => {
    const online = Number(fresh(b.presence)) - Number(fresh(a.presence));
    if (online) return online;
    return (b.pairedAt || 0) - (a.pairedAt || 0);
  });
}

function selectMachine(machineId) {
  state.selected = machineId;
  try {
    if (machineId) localStorage.setItem(SELECTED_KEY, machineId);
    else localStorage.removeItem(SELECTED_KEY);
  } catch { /* private mode */ }

  state.browser?.reset();
  state.scriptedBrowser?.reset();
  state.control?.reset();
  renderMachinePill();
  syncBrowserEngine();
}

function renderMachinePill() {
  const entry = state.selected ? state.machines.get(state.selected) : null;
  const online = entry ? fresh(entry.presence) : false;
  $('#machineLabel').textContent = entry ? entry.name : 'No PC selected';
  const dot = $('#machineDot');
  dot.classList.toggle('online', online);
  dot.classList.toggle('offline', !!entry && !online);
}

/* ── server picker ───────────────────────────────────────────── */

async function openPicker({ reason = 'manual' } = {}) {
  if (state.pickerOpen) return;
  state.pickerOpen = true;

  const dismissable = reason === 'manual' && !!state.selected;

  const chosen = await openModal((close) => {
    const listHost = el('div', { class: 'machine-list' });
    const codeProblem = el('p', { class: 'notice notice--danger', hidden: true });

    const renderList = () => {
      const machines = machineList();
      if (!machines.length) {
        listHost.replaceChildren(el('p', { class: 'empty-state' },
          'No PCs are paired to this account yet. Add one with a code below.'));
        return;
      }
      listHost.replaceChildren(...machines.map((machine) => {
        const online = fresh(machine.presence);
        const caps = machine.presence?.capabilities || {};
        const detail = online
          ? [caps.proxy && 'browsing', caps.control && 'control', caps.input && 'input']
              .filter(Boolean).join(' · ') || 'connected, no capabilities'
          : `offline · last seen ${formatRelative(machine.presence?.lastSeen)}`;

        const row = el('button', {
          class: `machine-row ${online ? '' : 'offline'} ${state.selected === machine.id ? 'selected' : ''}`,
        },
          el('span', { class: 'machine-glyph' },
            iconSvg('M2 3h20v14H2zM8 21h8M12 17v4')),
          el('div', { class: 'machine-info' },
            el('div', { class: 'machine-title' }, machine.name || 'PC'),
            el('div', { class: 'machine-meta' }, detail),
          ),
          el('span', { class: `badge ${online ? 'badge--online' : 'badge--offline'} badge--dot` },
            online ? 'Online' : 'Offline'),
        );

        row.addEventListener('click', () => {
          if (!online) {
            toast('That PC is offline. Start the connector on it first.', 'danger');
            return;
          }
          close(machine.id);
        });

        const forget = el('button', { class: 'btn btn--xs', title: 'Forget this PC' }, 'Forget');
        forget.addEventListener('click', async (event) => {
          event.stopPropagation();
          const sure = await confirmModal({
            title: `Forget ${machine.name}?`,
            message: 'You will need a new pairing code from that PC to use it again.',
            confirmLabel: 'Forget',
            danger: true,
          });
          if (!sure) return;
          await unpairMachine(state.db, state.uid, machine.id);
          toast('PC forgotten', 'info');
        });
        row.append(forget);
        return row;
      }));
    };

    renderList();

    /* code entry */
    const codeInput = el('input', {
      class: 'text-input text-input--mono',
      placeholder: 'ABCD-1234',
      maxlength: 9,
      autocapitalize: 'characters',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const addBtn = el('button', { class: 'btn btn--primary' }, 'Pair');

    const submitCode = async () => {
      codeProblem.hidden = true;
      setBusy(addBtn, true, 'Pairing…');
      try {
        const result = await claimPairingCode(state.db, codeInput.value, state.uid);
        toast(`${result.machineName} paired`, 'success');
        codeInput.value = '';
        // Give the machine list a moment to catch up, then jump straight in.
        close(result.machineId);
      } catch (err) {
        codeProblem.textContent = err instanceof PairingError
          ? err.message
          : `Could not pair: ${err.message}`;
        codeProblem.hidden = false;
        setBusy(addBtn, false);
      }
    };

    addBtn.addEventListener('click', submitCode);
    codeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitCode();
    });
    codeInput.addEventListener('input', () => {
      const raw = codeInput.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
      codeInput.value = raw.length > 4 ? formatPairingCode(raw) : raw;
    });

    const heading = {
      offline: ['That PC went offline', 'Pick another PC, or bring that one back online and try again.'],
      none: ['Choose a PC', 'Pick the machine you want to browse through or take control of.'],
      manual: ['Switch PC', 'Everything you do runs through the PC you pick here.'],
    }[reason] || ['Choose a PC', 'Pick a machine to connect to.'];

    return el('div', {},
      el('h2', { class: 'modal-title' }, heading[0]),
      el('p', { class: 'modal-sub' }, heading[1]),

      el('div', { class: 'section-label' }, 'Your PCs'),
      listHost,

      el('div', { class: 'section-label', style: { marginTop: '20px' } }, 'Add a PC with a code'),
      el('p', { class: 'hint', style: { marginBottom: '10px' } },
        'Open the PC Site on the machine you want to add and type its code here. ' +
        'You only do this once — it stays on your account.'),
      el('div', { class: 'code-entry' }, codeInput, addBtn),
      codeProblem,

      dismissable
        ? el('div', { class: 'modal-footer' },
            el('button', { class: 'btn btn--ghost', onClick: () => close(undefined) }, 'Cancel'))
        : null,
    );
  }, { dismissable, width: '560px' });

  state.pickerOpen = false;

  if (chosen) {
    selectMachine(chosen);
    const entry = state.machines.get(chosen);
    toast(`Connected to ${entry?.name || 'your PC'}`, 'success');
  } else if (!state.selected) {
    // Nothing selected and nothing chosen — the app has no PC to talk to.
    setMode(state.mode);
  }
}

function iconSvg(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = `<path d="${path}"/>`;
  return svg;
}

/* ── modes ───────────────────────────────────────────────────── */

function setMode(mode) {
  state.mode = mode;
  try { localStorage.setItem(LAST_MODE_KEY, mode); } catch { /* private mode */ }

  $('#paneBrowser').classList.toggle('active', mode === 'browser');
  $('#paneControl').classList.toggle('active', mode === 'control');
  $('#modeBrowser').classList.toggle('active', mode === 'browser');
  $('#modeControl').classList.toggle('active', mode === 'control');
  $('#modeBrowser').setAttribute('aria-selected', String(mode === 'browser'));
  $('#modeControl').setAttribute('aria-selected', String(mode === 'control'));

  // Leaving control mode should not leave a screen share running.
  if (mode !== 'control') state.control?.disconnect('Switched to Browser mode.');
  if (mode === 'browser') syncBrowserEngine();
}

/**
 * Fills the display picker from the monitors the connector reported. Only the
 * desktop app can switch silently, so a browser-hosted connector sends an
 * empty list and the control stays hidden.
 */
function fillDisplays(sources) {
  const select = $('#controlDisplay');
  if (select.dataset.filled === String(sources.length) && sources.length) return;
  select.dataset.filled = String(sources.length);
  select.replaceChildren(...sources.map((source) => {
    const option = document.createElement('option');
    option.value = source.id;
    option.textContent = source.name;
    return option;
  }));
}

/* ── account ─────────────────────────────────────────────────── */

function openAccount() {
  const user = state.auth.currentUser;
  return openModal((close) =>
    el('div', {},
      el('h2', { class: 'modal-title' }, 'Account'),
      el('p', { class: 'modal-sub' }, user.email || 'Signed in'),
      el('div', { class: 'notice' },
        `${state.machines.size} PC${state.machines.size === 1 ? '' : 's'} paired to this account. ` +
        'They follow you onto any device you sign in on.'),
      el('div', { class: 'modal-footer' },
        el('button', { class: 'btn btn--ghost', onClick: () => close(false) }, 'Close'),
        el('button', {
          class: 'btn btn--danger',
          onClick: async () => {
            close(false);
            await state.control?.disconnect('Signed out.');
            await state.scriptedBrowser?.reset();
            await signOut(state.auth);
            location.replace('../');
          },
        }, 'Sign out'),
      ),
    ),
  );
}

/* ── boot ────────────────────────────────────────────────────── */

async function main() {
  let firebase;
  try {
    firebase = initFirebase();
  } catch (err) {
    if (err instanceof MissingConfigError) { location.replace('../'); return; }
    throw err;
  }

  state.db = firebase.db;
  state.auth = firebase.auth;
  await usePersistentAuth(state.auth);

  // Firebase's local persistence survives reloads by design, which is right
  // for the PC (it should never need re-auth just to reboot) but wrong here —
  // landing on this page should always mean a Google prompt was just shown,
  // not a silently resumed session. `?fresh=1` is the one-time signal the
  // portal attaches right after that prompt; anything else (a reload, a
  // bookmark, a stale tab) signs out whatever Firebase restores and bounces
  // back for a fresh one.
  const url = new URL(location.href);
  const arrivedFresh = url.searchParams.get('fresh') === '1';
  if (arrivedFresh) {
    url.searchParams.delete('fresh');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  let user = await waitForAuth(state.auth);
  if (user && !arrivedFresh) {
    await signOut(state.auth);
    user = null;
  }
  if (!user) {
    location.replace('../');
    return;
  }
  state.uid = user.uid;
  $('#accountBtn').textContent = (user.email || user.displayName || '?').slice(0, 1);

  /* mini browser */
  state.browser = createMiniBrowser({
    db: state.db,
    getMachineId: () => state.selected,
    elements: {
      frame: $('#browserFrame'),
      stage: $('#browserStage'),
      overlay: $('#stageOverlay'),
      overlayTitle: $('#stageTitle'),
      overlayMessage: $('#stageMsg'),
      urlInput: $('#urlInput'),
      urlLock: $('#urlLock'),
      loadBar: $('#loadBar'),
      backBtn: $('#navBack'),
      forwardBtn: $('#navForward'),
    },
    onStatus: ({ text, bytes, ms, truncated }) => {
      $('#statusText').textContent = truncated ? `${text} · truncated` : text;
      $('#statusBytes').textContent = bytes != null ? formatBytes(bytes) : '';
      $('#statusTime').textContent = ms != null ? `${ms} ms` : '';
    },
  });

  /* scripted browser viewer — the other Browser-mode engine, sharing the
     same URL bar / back / forward / stage / overlay elements */
  state.scriptedBrowser = createScriptedBrowserViewer({
    db: state.db,
    uid: state.uid,
    getMachineId: () => state.selected,
    elements: {
      video: $('#browserVideo'),
      stage: $('#browserStage'),
      overlay: $('#stageOverlay'),
      overlayTitle: $('#stageTitle'),
      overlayMessage: $('#stageMsg'),
      urlInput: $('#urlInput'),
      urlLock: $('#urlLock'),
      loadBar: $('#loadBar'),
      backBtn: $('#navBack'),
      forwardBtn: $('#navForward'),
    },
    onStatus: ({ text }) => {
      $('#statusText').textContent = text;
      $('#statusBytes').textContent = '';
      $('#statusTime').textContent = '';
    },
  });

  /* control viewer */
  state.control = createControlViewer({
    db: state.db,
    uid: state.uid,
    getMachineId: () => state.selected,
    elements: {
      stage: $('#controlStage'),
      video: $('#controlVideo'),
      overlay: $('#controlOverlay'),
      overlayTitle: $('#controlTitle'),
      overlayMessage: $('#controlMsg'),
      connectBtn: $('#connectControlBtn'),
      hint: $('#captureHint'),
    },
    onState: ({ connected, status, rtt, fps, canInput, sources, frameRate }) => {
      $('#controlDisconnect').disabled = !connected;
      $('#controlCtrlAltDel').disabled = !connected || !canInput;
      $('#controlPasteBtn').disabled = !connected || !canInput;
      // Frame rate and display are capture settings, not input, so they stay
      // available on a view-only session.
      $('#controlFps').disabled = !connected;
      if (frameRate) $('#controlFps').value = String(frameRate);
      if (sources) fillDisplays(sources);
      $('#controlDisplay').hidden = !connected || !sources?.length;

      const dot = $('#latencyDot');
      dot.className = 'latency-dot';
      if (!connected) {
        $('#latencyText').textContent = status === 'connecting' ? 'connecting…' : 'not connected';
        return;
      }
      dot.classList.add(rtt == null ? '' : rtt < 60 ? 'good' : rtt < 150 ? 'fair' : 'poor');
      const bits = [];
      if (rtt != null) bits.push(`${rtt} ms`);
      if (fps) bits.push(`${fps} fps`);
      if (!canInput) bits.push('view-only');
      $('#latencyText').textContent = bits.join(' · ') || 'connected';
    },
  });

  /* wiring */
  $('#modeBrowser').addEventListener('click', () => setMode('browser'));
  $('#modeControl').addEventListener('click', () => setMode('control'));
  $('#machinePill').addEventListener('click', () => openPicker({ reason: 'manual' }));
  $('#accountBtn').addEventListener('click', openAccount);

  $('#navGo').addEventListener('click', () => activeBrowser().go($('#urlInput').value));
  $('#urlInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') activeBrowser().go($('#urlInput').value);
  });
  $('#navBack').addEventListener('click', () => activeBrowser().back());
  $('#navForward').addEventListener('click', () => activeBrowser().forward());
  $('#navReload').addEventListener('click', () => activeBrowser().reload());
  $('#browserFullscreen').addEventListener('click', () => {
    const stage = $('#browserStage');
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen?.().catch(() => toast('Fullscreen was refused', 'danger'));
  });

  $('#connectControlBtn').addEventListener('click', () => state.control.connect());
  $('#controlDisconnect').addEventListener('click', () => state.control.disconnect('You disconnected.'));
  $('#controlCtrlAltDel').addEventListener('click', () => state.control.sendCtrlAltDel());
  $('#controlPasteBtn').addEventListener('click', async () => {
    const sent = await state.control.sendClipboard();
    toast(sent ? 'Clipboard sent to the PC' : 'Could not read the clipboard', sent ? 'success' : 'danger');
  });
  $('#controlFps').addEventListener('change', (event) => {
    state.control.setFrameRate(Number(event.target.value));
  });
  $('#controlDisplay').addEventListener('change', (event) => {
    state.control.switchDisplay(event.target.value);
  });
  $('#controlFullscreen').addEventListener('click', () => {
    const stage = $('#controlStage');
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen?.().catch(() => toast('Fullscreen was refused', 'danger'));
  });

  $('#quickLinks').replaceChildren(...QUICK_LINKS.map(([label, url]) => {
    const link = el('button', { class: 'quick-link' }, label);
    link.addEventListener('click', () => activeBrowser().go(url));
    return link;
  }));

  /* load the account's PCs, then decide whether to show the picker */
  watchMachines();
  const initial = await get(ref(state.db, paths.userMachines(state.uid))).catch(() => null);
  initial?.forEach((child) => {
    state.machines.set(child.key, { ...child.val(), id: child.key });
    watchPresence(child.key);
  });

  let saved = null;
  try { saved = localStorage.getItem(SELECTED_KEY); } catch { /* private mode */ }
  try { state.mode = localStorage.getItem(LAST_MODE_KEY) || 'browser'; } catch { /* private mode */ }
  setMode(state.mode);

  $('#boot').hidden = true;

  if (saved && state.machines.has(saved)) {
    state.selected = saved;
    renderMachinePill();
    syncBrowserEngine();
    // Presence arrives a beat after the list; give it a moment before judging.
    setTimeout(() => {
      const entry = state.machines.get(saved);
      if (!fresh(entry?.presence)) openPicker({ reason: 'offline' });
      else syncBrowserEngine();
    }, 1500);
  } else {
    openPicker({ reason: 'none' });
  }

  // Deep link: /client/?go=https://example.com
  const target = new URLSearchParams(location.search).get('go');
  if (target) {
    setMode('browser');
    const url = normaliseUrl(target);
    if (url) setTimeout(() => activeBrowser().go(url), 400);
  }
}

main().catch((err) => {
  $('#boot').hidden = true;
  toast(`The client could not start: ${err.message}`, 'danger', 12_000);
  console.error(err);
});
