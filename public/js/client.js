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
import { createBrowserTransport } from './fetch-tunnel.js';
import { createControlViewer, SMOOTHING } from './client-control.js';
import {
  REMAP_TARGETS, REMAP_PRESETS, loadRemap, saveRemap, describeCode, targetLabel,
} from './key-remap.js';
import { createScriptedBrowserViewer } from './client-scripted-browser.js';
import { createNativeBrowserViewer, resolveBrowseOrigin } from './client-native-browser.js';
import { BROWSE_ORIGIN } from './firebase-config.js';
import { $, el, openModal, toast, confirmModal, formatBytes, formatRelative, setBusy } from './ui.js';

const SELECTED_KEY = 'proxvocx.selectedMachine';
const LAST_MODE_KEY = 'proxvocx.mode';
const ENGINE_KEY = 'proxvocx.engine';

/**
 * Browser mode's three engines. `native` runs the real page in this browser
 * through Scramjet (full JavaScript, native quality); `safe` renders a
 * script-free rewrite; `pctab` streams a real tab running on the PC.
 */
const ENGINES = {
  native: 'Native (full sites)',
  safe: 'Safe (no scripts)',
  pctab: 'PC tab (streamed)',
};

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
  browserTransport: null,
  scriptedBrowser: null,
  control: null,
  presenceWatchers: new Map(),
  pickerOpen: false,
  nativeBrowser: null,
  browseOrigin: null,
  enginePref: 'native',       // what the engine picker is set to
  activeEngine: null,         // which engine is actually live: native | safe | pctab
  nativeUnavailable: new Map(), // machineId -> reason the native engine could not run there
};

/** isPresenceFresh() against Firebase's clock, not this device's own. */
const fresh = (presence) => isPresenceFresh(presence, serverNow());

/** Whichever Browser-mode engine is currently backing the shared UI. */
function activeBrowser() {
  if (state.activeEngine === 'native') return state.nativeBrowser;
  if (state.activeEngine === 'pctab') return state.scriptedBrowser;
  return state.browser;
}

/**
 * The engine that can actually run, given what was picked: the native engine
 * needs a browse site and a connector new enough to serve it; the PC tab
 * needs the PC to allow scripts. Anything unavailable falls back to `safe`,
 * which works against any connector.
 */
function pickEngine() {
  const entry = state.selected ? state.machines.get(state.selected) : null;
  const scriptsOn = !!(fresh(entry?.presence) && entry.presence.capabilities?.scripts);
  const pref = state.enginePref;
  if (pref === 'native' && state.browseOrigin && !state.nativeUnavailable.has(state.selected)) return 'native';
  if (pref === 'pctab' && scriptsOn) return 'pctab';
  return 'safe';
}

function renderEnginePicker() {
  const picker = $('#browserEngine');
  if (!picker) return;
  const entry = state.selected ? state.machines.get(state.selected) : null;
  const scriptsOn = !!(fresh(entry?.presence) && entry.presence.capabilities?.scripts);
  for (const option of picker.options) {
    if (option.value === 'native') option.disabled = !state.browseOrigin;
    if (option.value === 'pctab') option.disabled = !scriptsOn;
  }
  picker.value = state.activeEngine || state.enginePref;
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
  const engine = pickEngine();

  // The fast lane (fetch-tunnel.js) carries both the native and the safe
  // engine, and is opened as soon as either is on screen so the first page
  // is fast too. The PC-tab engine carries its own connection.
  if (state.mode === 'browser' && engine !== 'pctab' && fresh(entry?.presence)) {
    state.browserTransport?.warm(state.selected);
  } else if (engine === 'pctab') {
    state.browserTransport?.close();
  }

  if (engine !== state.activeEngine) {
    // Swapping engines tears down whichever one was live — they never run
    // at once, and the one going idle has no business holding a session, a
    // socket or a proxy fetch open in the background.
    state.browser?.reset();
    state.scriptedBrowser?.reset();
    state.nativeBrowser?.reset();

    state.activeEngine = engine;
    $('#browserFrame').hidden = engine !== 'safe';
    $('#browserVideo').hidden = engine !== 'pctab';
  }
  renderEnginePicker();
}

/** The engine picker changed: remember it, switch, and re-open the page there. */
function chooseEngine(engine) {
  const entry = state.selected ? state.machines.get(state.selected) : null;
  if (engine === 'pctab' && !(fresh(entry?.presence) && entry.presence.capabilities?.scripts)) {
    renderEnginePicker();
    noScriptsModal(entry?.name);
    return;
  }
  const current = $('#urlInput').value;
  state.enginePref = engine;
  try { localStorage.setItem(ENGINE_KEY, engine); } catch { /* private mode */ }
  if (engine === 'native') state.nativeUnavailable.delete(state.selected);
  const before = state.activeEngine;
  syncBrowserEngine();
  if (current && state.activeEngine !== before) activeBrowser().go(current);
}

/**
 * The native engine could not run against this PC. Say why once, fall back
 * to the safe engine for this PC, and open the page there instead.
 */
function nativeUnavailable(reason, url) {
  const why = {
    unreachable: 'A direct connection to the PC could not be opened (some networks need a TURN relay). Using the safe engine instead.',
    outdated: 'The connector on this PC is too old for the native engine. Update the desktop app on the PC — using the safe engine until then.',
    shell: 'The browse site for the native engine is not reachable. Using the safe engine instead.',
  }[reason] || 'The native engine is not available right now. Using the safe engine instead.';
  if (!state.nativeUnavailable.has(state.selected)) toast(why, 'danger', 9000);
  state.nativeUnavailable.set(state.selected, reason);
  syncBrowserEngine();
  if (url) activeBrowser().go(url);
}

function noScriptsModal(machineName) {
  return openModal((close) =>
    el('div', {},
      el('h2', { class: 'modal-title' }, 'JavaScript isn’t enabled'),
      el('p', { class: 'modal-sub' },
        `${machineName || 'This PC'} does not allow the PC-tab engine, which runs a real browser ` +
        'tab on the PC and streams it here.'),
      el('p', { class: 'hint', style: { marginBottom: '16px' } },
        'Turn on “Allow JavaScript in Browser mode” in the connector’s settings on the PC to use it. ' +
        'The native engine needs no setting on the PC and runs full sites too.'),
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
  state.nativeBrowser?.reset();
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
 * The last state the control viewer reported, kept so the Stream modal can be
 * built from current values at the moment it opens rather than from whatever
 * the toolbar happened to be showing.
 */
let lastControlState = {};

/**
 * Frame-rate stops offered by the slider. The protocol accepts 1–240, and
 * `bitrateFor()` scales the encoder ceiling with the rate — 144fps at 1080p
 * asks for ~18 Mbps, still under the 25 Mbps cap it clamps to.
 *
 * Whether the PC can actually deliver the top of this range is a separate
 * question from whether it will accept the number: the capture, the encoder
 * and the link all have to keep up, and the host reports back what it settled
 * on rather than what it was asked for.
 */
const FPS_STOPS = [15, 30, 60, 90, 120, 144];

/**
 * Heights the viewer can ask the PC to send at. The PC never upscales, so a
 * choice above what it captures simply sends what it captures.
 */
const RESOLUTIONS = [
  [0, 'Full — whatever the PC captures'],
  [1080, '1080p'],
  [900, '900p'],
  [720, '720p — easier on a Chromebook or a weak link'],
  [540, '540p'],
];

/** What each `limit` reason means, and what to try, for the status bar. */
const LIMITS = {
  bandwidth: ['limited by network', 'The link cannot carry this picture. Try Smoothing, a lower resolution or 30 fps, or a wired connection on the PC.'],
  cpu: ['limited by PC CPU', 'The PC cannot encode fast enough. Try a lower resolution or frame rate, or set the PC\'s codec to "Prefer smoothness (H.264)".'],
  decode: ['limited by this device', 'This device is dropping frames it received — it cannot decode or draw them in time. Try 720p or a lower frame rate.'],
  other: ['limited', 'The PC is sending less than it was asked for.'],
};

/**
 * The Stream settings modal: monitor, frame rate, and what the picture is
 * tuned for. These were three dropdowns crowded into the toolbar, where two of
 * the three were dead weight against a browser-hosted connector with nothing
 * on screen to say why.
 *
 * Everything applies to the live session the moment it changes — there is no
 * apply step, and Done only closes the box.
 *
 * Only the desktop app can re-capture silently, so a browser-hosted connector
 * reports no monitors at all. Monitor and frame rate both go through that same
 * re-capture, so both are gated on it and the box says so. Picture tuning only
 * touches the encoder on the existing track, so it works either way.
 */
function openStreamModal() {
  const {
    sources = [], activeSourceId, frameRate, streamMode, connected, resolution, smoothing,
  } = lastControlState;
  if (!connected) return null;
  const canRecapture = sources.length > 0;

  return openModal((close) => {
    /* ── monitor ── */
    const monitor = el('select', { class: 'select-input' });
    if (canRecapture) {
      monitor.replaceChildren(...sources.map((source) => el('option', { value: source.id }, source.name)));
      // The entry already displayed fires no change event when picked, so the
      // picker has to open on the monitor actually being captured — otherwise
      // the one you want is the one you cannot choose. Guarded on the id still
      // being in this host's list: ids are per-machine, and a stale one would
      // silently fall back to the host's first screen.
      if (activeSourceId && sources.some((source) => source.id === activeSourceId)) {
        monitor.value = activeSourceId;
      }
      monitor.addEventListener('change', (event) => state.control.switchDisplay(event.target.value));
    } else {
      monitor.replaceChildren(el('option', {}, 'Whatever the PC is sharing'));
      monitor.disabled = true;
    }

    /* ── frame rate ── */
    const startFps = Number(frameRate) || 60;
    const startIndex = FPS_STOPS.reduce(
      (best, stop, i) => (Math.abs(stop - startFps) < Math.abs(FPS_STOPS[best] - startFps) ? i : best),
      0,
    );
    const fpsValue = el('span', { class: 'field-value' }, `${FPS_STOPS[startIndex]} fps`);
    const fps = el('input', {
      class: 'range-input',
      type: 'range',
      min: '0',
      max: String(FPS_STOPS.length - 1),
      step: '1',
      value: String(startIndex),
    });
    // The readout follows the thumb, but the change only goes to the PC on
    // release: every frame-rate change re-captures the screen over there, so
    // sending one per pixel of travel would thrash the capture pipeline.
    fps.addEventListener('input', () => {
      fpsValue.textContent = `${FPS_STOPS[Number(fps.value)]} fps`;
    });
    fps.addEventListener('change', () => state.control.setFrameRate(FPS_STOPS[Number(fps.value)]));
    fps.disabled = !canRecapture;

    /* ── picture tuning ── */
    const mode = el('select', { class: 'select-input' },
      el('option', { value: 'text' }, 'Sharp text — best for reading, editors, browsing'),
      el('option', { value: 'balanced' }, 'Balanced — sharp when it can be, smooth when it can’t'),
      el('option', { value: 'motion' }, 'Smooth motion — best for video and games'),
    );
    if (streamMode) mode.value = streamMode;
    mode.addEventListener('change', (event) => state.control.setStreamMode(event.target.value));

    /* ── resolution ── */
    const res = el('select', { class: 'select-input' },
      ...RESOLUTIONS.map(([value, label]) => el('option', { value: String(value) }, label)));
    res.value = String(resolution || 0);
    res.addEventListener('change', (event) => state.control.setResolution(Number(event.target.value)));

    /* ── smoothing ── */
    const smooth = el('select', { class: 'select-input' },
      ...Object.entries(SMOOTHING).map(([value, { label }]) => el('option', { value }, label)));
    if (smoothing) smooth.value = smoothing;
    smooth.addEventListener('change', (event) => state.control.setSmoothing(event.target.value));

    return el('div', {},
      el('h2', { class: 'modal-title' }, 'Stream'),
      el('p', { class: 'modal-sub' }, 'Applies to this session, straight away.'),

      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, 'Monitor'),
        monitor,
      ),
      el('div', { class: 'field' },
        el('div', { class: 'field-head' },
          el('span', { class: 'field-label' }, 'Frame rate'),
          fpsValue,
        ),
        fps,
      ),
      canRecapture ? null : el('p', { class: 'field-note' },
        'Monitor and frame rate need the desktop app. This PC is sharing from a browser tab, '
        + 'which cannot change what it captures without raising the screen picker again.'),
      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, 'Tuned for'),
        mode,
      ),
      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, 'Resolution'),
        res,
      ),
      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, 'Smoothing'),
        smooth,
      ),
      el('p', { class: 'field-note' },
        'Choppy but not blurry is usually network jitter — turn Smoothing up. '
        + 'The status bar says when the PC, the network or this device is the bottleneck.'),

      el('div', { class: 'modal-footer' },
        el('button', { class: 'btn btn--primary', onClick: () => close(true) }, 'Done'),
      ),
    );
  }, { width: '420px' });
}

/**
 * The key remap editor. Rules live in this browser (see key-remap.js) and
 * apply to the live session the moment they are saved.
 */
function openRemapModal() {
  let map = loadRemap();
  let stopListening = null;

  return openModal((close) => {
    const list = el('div', { class: 'remap-list' });
    const commit = () => {
      saveRemap(map);
      state.control?.reloadKeyRemap();
      renderList();
    };

    function renderList() {
      const rules = Object.entries(map);
      if (!rules.length) {
        list.replaceChildren(el('p', { class: 'hint' }, 'No keys are remapped.'));
        return;
      }
      list.replaceChildren(...rules.map(([from, to]) =>
        el('div', { class: 'remap-row' },
          el('span', { class: 'remap-key' }, describeCode(from)),
          el('span', { class: 'remap-arrow' }, '→'),
          el('span', { class: 'remap-key' }, targetLabel(to)),
          el('button', {
            class: 'btn btn--ghost btn--sm',
            onClick: () => {
              delete map[from];
              commit();
            },
          }, 'Remove'),
        )));
    }

    /* ── new rule ── */
    let fromCode = null;
    const fromBtn = el('button', { class: 'btn btn--ghost btn--sm remap-capture' }, 'Press to pick a key');
    fromBtn.addEventListener('click', () => {
      if (stopListening) return;
      fromBtn.textContent = 'Press the key to remap…';
      fromBtn.classList.add('active');
      const onKey = (event) => {
        // Capture phase on the window, and stopped here, so neither the
        // modal (which closes on Escape) nor the page sees the key.
        event.preventDefault();
        event.stopImmediatePropagation();
        stopListening();
        if (event.key === 'Escape' || !event.code) {
          fromBtn.textContent = fromCode ? describeCode(fromCode) : 'Press to pick a key';
          return;
        }
        fromCode = event.code;
        fromBtn.textContent = describeCode(fromCode);
      };
      window.addEventListener('keydown', onKey, true);
      stopListening = () => {
        window.removeEventListener('keydown', onKey, true);
        fromBtn.classList.remove('active');
        stopListening = null;
      };
    });

    const toSelect = el('select', { class: 'select-input' },
      ...REMAP_TARGETS.map(([group, keys]) => el('optgroup', { label: group },
        ...keys.map(([code, , label]) => el('option', { value: code }, label)))));

    const addBtn = el('button', {
      class: 'btn btn--primary btn--sm',
      onClick: () => {
        if (!fromCode) {
          toast('Pick the key to remap first', 'danger');
          return;
        }
        map[fromCode] = toSelect.value;
        fromCode = null;
        fromBtn.textContent = 'Press to pick a key';
        commit();
      },
    }, 'Add');

    renderList();

    return el('div', {},
      el('h2', { class: 'modal-title' }, 'Remap keys'),
      el('p', { class: 'modal-sub' },
        'Turn a key on this keyboard into a different key on the PC. Saved on this device only.'),

      el('div', { class: 'section-label' }, 'Quick add'),
      el('div', { class: 'remap-presets' },
        ...REMAP_PRESETS.map((preset) => el('button', {
          class: 'btn btn--ghost btn--sm',
          onClick: () => {
            map[preset.from] = preset.to;
            commit();
          },
        }, preset.label))),

      el('div', { class: 'section-label', style: { marginTop: '16px' } }, 'Rules'),
      list,

      el('div', { class: 'section-label', style: { marginTop: '16px' } }, 'New rule'),
      el('div', { class: 'remap-new' }, fromBtn, el('span', { class: 'remap-arrow' }, '→'), toSelect, addBtn),

      el('p', { class: 'field-note' },
        'On a Chromebook, ChromeOS grabs the Search key for its launcher before a web page sees it. '
        + 'Use Fullscreen while controlling the PC: the page can then ask the browser to hand it '
        + 'those system keys. In a normal window the launcher may still open. '
        + 'Esc always releases the keyboard, so it cannot be remapped.'),

      el('div', { class: 'modal-footer' },
        el('button', { class: 'btn btn--primary', onClick: () => close(true) }, 'Done'),
      ),
    );
  }, { width: '480px' }).finally(() => {
    // The modal can close while a key capture is still armed.
    stopListening?.();
  });
}

/**
 * Keys a Chromebook does not physically have, or that ChromeOS keeps for
 * itself before the page ever sees them.
 *
 * The function row is the obvious gap — a Chromebook has back/forward/reload
 * and brightness where F1–F12 live, and those top-row keys are handled by
 * ChromeOS itself and never reach a web page. But the ones that actually
 * strand people are Search/Launcher (the page sees `MetaLeft` go down, then
 * ChromeOS opens its launcher and the release is delivered somewhere else)
 * and the chords the browser keeps, like Alt+Tab. Sending those as a single
 * synthesised tap sidesteps the local keyboard entirely: nothing is held on
 * this side, so nothing can be stranded held on the PC.
 */
const KEY_PAD = [
  ['Function row', [
    ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`, `F${i + 1}`]),
  ]],
  ['Windows', [
    ['Win', 'MetaLeft', 'Meta'],
    ['Win+D', 'KeyD', 'd', { meta: true }],
    ['Win+E', 'KeyE', 'e', { meta: true }],
    ['Win+L', 'KeyL', 'l', { meta: true }],
    ['Alt+Tab', 'Tab', 'Tab', { alt: true }],
    ['Alt+F4', 'F4', 'F4', { alt: true }],
  ]],
  ['Editing', [
    ['Esc', 'Escape', 'Escape'],
    ['Tab', 'Tab', 'Tab'],
    ['Del', 'Delete', 'Delete'],
    ['Ins', 'Insert', 'Insert'],
    ['Home', 'Home', 'Home'],
    ['End', 'End', 'End'],
    ['PgUp', 'PageUp', 'PageUp'],
    ['PgDn', 'PageDown', 'PageDown'],
    ['PrtScn', 'PrintScreen', 'PrintScreen'],
  ]],
];

function buildKeyPad() {
  const pad = $('#controlKeys');
  const nodes = [];
  for (const [label, keys] of KEY_PAD) {
    nodes.push(el('div', { class: 'key-pad-label' }, label));
    nodes.push(el('div', { class: 'key-pad-group' }, ...keys.map(([caption, code, keyName, mods]) => {
      const cap = el('button', { class: 'key-cap', title: caption }, caption);
      // `mousedown`, not `click`: a click would move focus to the button and
      // the video would lose the keyboard capture the key is meant to reach.
      cap.addEventListener('mousedown', (event) => {
        event.preventDefault();
        state.control?.sendKeyTap(code, keyName, mods || {});
      });
      return cap;
    })));
  }
  pad.replaceChildren(...nodes);
}

function toggleKeyPad(force) {
  const pad = $('#controlKeys');
  const open = force ?? pad.hidden;
  pad.hidden = !open;
  $('#controlKeysBtn').setAttribute('aria-expanded', String(open));
  $('#controlKeysBtn').classList.toggle('active', open);
  $('#controlStage').classList.toggle('keys-open', open);
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
  state.browserTransport = createBrowserTransport({ db: state.db, uid: state.uid });
  state.browser = createMiniBrowser({
    db: state.db,
    getMachineId: () => state.selected,
    request: (machineId, spec, options) => state.browserTransport.request(machineId, spec, options),
    isFast: (machineId) => state.browserTransport.isFast(machineId),
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

  /* native engine — Scramjet on the separate browse origin, fed by the fast lane */
  state.browseOrigin = resolveBrowseOrigin(BROWSE_ORIGIN);
  try {
    const saved = localStorage.getItem(ENGINE_KEY);
    if (ENGINES[saved]) state.enginePref = saved;
  } catch { /* private mode */ }
  state.nativeBrowser = createNativeBrowserViewer({
    getMachineId: () => state.selected,
    transport: state.browserTransport,
    browseOrigin: state.browseOrigin,
    elements: {
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
    onUnavailable: nativeUnavailable,
  });
  $('#browserEngine')?.replaceChildren(...Object.entries(ENGINES).map(([value, label]) =>
    el('option', { value }, label)));
  $('#browserEngine')?.addEventListener('change', (event) => chooseEngine(event.target.value));

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
    // The PC refusing or failing a capture change used to be visible only in
    // the connector's own log, on the other machine.
    onNotice: (message) => toast(`The PC could not apply that: ${message}`, 'danger', 7000),
    onState: ({
      connected, status, rtt, fps, canInput,
      sources, activeSourceId, frameRate, streamMode, mouseLocked,
      resolution, smoothing, limit,
    }) => {
      $('#controlDisconnect').disabled = !connected;
      $('#controlCtrlAltDel').disabled = !connected || !canInput;
      $('#controlPasteBtn').disabled = !connected || !canInput;
      $('#controlKeysBtn').disabled = !connected || !canInput;
      if (!connected || !canInput) toggleKeyPad(false);

      // Every lookup here is null-guarded on purpose. onState runs inside
      // connect(), so a TypeError on one missing button does not just skip a
      // label — it aborts the rest of the connect sequence, bindInput()
      // included. The session still reaches 'connected' at both ends and then
      // accepts no input at all, which is a miserable thing to debug. A
      // browser holding a cached index.html against freshly deployed JS is
      // enough to cause it, and that is not in this page's gift to prevent.
      const lockBtn = $('#controlLockBtn');
      if (lockBtn) {
        lockBtn.disabled = !connected || !canInput;
        lockBtn.setAttribute('aria-pressed', String(!!mouseLocked));
        lockBtn.textContent = mouseLocked ? 'Mouse locked' : 'Lock mouse';
        lockBtn.classList.toggle('btn--active', !!mouseLocked);
      }
      // Frame rate, stream mode and monitor are capture settings, not input,
      // so they stay available on a view-only session.
      lastControlState = {
        connected, sources, activeSourceId, frameRate, streamMode, resolution, smoothing,
      };
      const streamBtn = $('#controlStreamBtn');
      if (streamBtn) streamBtn.disabled = !connected;

      const dot = $('#latencyDot');
      dot.className = 'latency-dot';
      if (!connected) {
        $('#latencyText').textContent = status === 'connecting' ? 'connecting…' : 'not connected';
        return;
      }
      const bits = [];
      // `classList.add('')` throws, so an unknown RTT must add nothing at all
      // rather than an empty class — the throw used to abort this whole update.
      let health = rtt == null ? null : rtt < 60 ? 'good' : rtt < 150 ? 'fair' : 'poor';
      if (rtt != null) bits.push(`${rtt} ms`);
      if (fps) bits.push(`${fps} fps`);
      if (!canInput) bits.push('view-only');
      const [limitLabel, limitHint] = LIMITS[limit] || [];
      if (limitLabel) {
        bits.push(limitLabel);
        if (health !== 'poor') health = 'fair';
      }
      if (health) dot.classList.add(health);
      $('#latencyText').textContent = bits.join(' · ') || 'connected';
      $('#controlStats').title = limitHint || '';
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
  $('#controlStreamBtn')?.addEventListener('click', () => openStreamModal());

  // Pointer Lock is what turns cursor positions into raw motion. Without it a
  // game that captures the mouse only ever sees the cursor walk to the edge of
  // the screen and stop, which reads as the view refusing to turn past about a
  // half-turn. The lock has to start from a real click — browsers refuse it
  // otherwise — so it is a button rather than something applied on connect.
  $('#controlLockBtn')?.addEventListener('click', () => {
    if (state.control.mouseLocked) state.control.unlockMouse();
    else state.control.lockMouse();
  });
  buildKeyPad();
  $('#controlKeysBtn').addEventListener('click', () => toggleKeyPad());
  $('#controlRemapBtn')?.addEventListener('click', () => openRemapModal());
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
    // Merged, not replaced: the live watch above may already have filled in
    // this PC's presence, and dropping it made an online PC read as offline —
    // and raised the "went offline" picker at boot — until its next heartbeat.
    state.machines.set(child.key, { ...state.machines.get(child.key), ...child.val(), id: child.key });
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
