/**
 * Runs a real, scripted browser tab on the PC's own network and hands its
 * pixels and navigation state to whoever is managing the WebRTC side of a
 * 'scripted' session.
 *
 * This is the answer to "I want scripts and WebSockets to actually work,
 * routed through the PC": there is no way to reconstruct arbitrary JS-driven
 * network behaviour (fetch, XHR, live sockets) in a client-side sandboxed
 * iframe without rebuilding a general-purpose proxy for every browser
 * network primitive. Instead, Electron's own Chromium runs the page for
 * real — offscreen, so nothing shows on the PC's actual display — and its
 * rendered frames and input are relayed exactly the way PC Control already
 * relays a whole desktop, just scoped to one window.
 *
 * Offscreen rendering (`webPreferences.offscreen`) is the right mechanism
 * here, not `desktopCapturer`: it captures a window's compositor output
 * directly regardless of on-screen visibility, so the tab never has to be
 * shown, positioned off-screen, or fought over with whatever the person at
 * the PC is actually doing with their own display.
 */
import { BrowserWindow } from 'electron';

const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 1000;
const DEFAULT_FRAME_RATE = 20;
/**
 * JPEG quality for the frames handed to the renderer.
 *
 * This is the first of two compressions the picture meets — WebRTC then
 * re-encodes it — so whatever this throws away is gone before the video codec
 * ever sees the frame, and the codec spends bits faithfully reproducing the
 * artefacts. At 70 that was plainly visible as mush on small text, which is
 * the one thing a browser is mostly made of. These frames cross a local IPC
 * boundary rather than the network, so the larger buffer costs memory
 * bandwidth on the PC, not anything the viewer waits for.
 */
const DEFAULT_QUALITY = 92;

const sessions = new Map(); // sessionId -> { win, width, height }

export function openScriptedBrowser(sessionId, url, {
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  frameRate = DEFAULT_FRAME_RATE,
  quality = DEFAULT_QUALITY,
  onFrame,
  onNavState,
} = {}) {
  closeScriptedBrowser(sessionId);

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      offscreen: true,
      // Scripts running here are the whole point — this window renders one
      // specific site the account chose to open, not arbitrary local content,
      // and it never shares a session with the PC connector's own page.
      contextIsolation: true,
      nodeIntegration: false,
      partition: `persist:scripted-browser`,
    },
  });

  win.webContents.setFrameRate(frameRate);
  win.webContents.on('paint', (_event, _dirty, image) => {
    onFrame?.(image.toJPEG(quality), width, height);
  });

  const pushNavState = () => {
    onNavState?.({
      url: win.webContents.getURL(),
      title: win.webContents.getTitle(),
      canGoBack: win.webContents.canGoBack(),
      canGoForward: win.webContents.canGoForward(),
      loading: win.webContents.isLoading(),
    });
  };
  for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated',
    'did-start-loading', 'did-stop-loading', 'did-fail-load']) {
    win.webContents.on(event, pushNavState);
  }

  // New-window requests (target=_blank, window.open) become in-place
  // navigations — there is only one tab in this session, by design.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    win.loadURL(target).catch(() => {});
    return { action: 'deny' };
  });

  sessions.set(sessionId, { win, width, height });
  win.loadURL(url).catch((err) => {
    onNavState?.({ url, title: '', canGoBack: false, canGoForward: false, loading: false, error: err.message });
  });
}

export function navigateScriptedBrowser(sessionId, { action, url }) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  const { win } = entry;
  switch (action) {
    case 'go': if (url) win.loadURL(url).catch(() => {}); break;
    case 'back': if (win.webContents.canGoBack()) win.webContents.goBack(); break;
    case 'forward': if (win.webContents.canGoForward()) win.webContents.goForward(); break;
    case 'reload': win.webContents.reload(); break;
    default: break;
  }
}

/** @param {{x:number,y:number}} normalised 0..1 across the session's fixed viewport */
export function sendScriptedBrowserInput(sessionId, event) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  const { win, width, height } = entry;
  const wc = win.webContents;

  switch (event.t) {
    case 'p': return pointerEvent(wc, event, width, height);
    case 'w': return wheelEvent(wc, event, width, height);
    case 'k': return keyEvent(wc, event);
    case 'x': return typeText(wc, event.v);
    default: return undefined;
  }
}

export function closeScriptedBrowser(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  try { entry.win.destroy(); } catch { /* already gone */ }
}

export function closeAllScriptedBrowsers() {
  for (const id of Array.from(sessions.keys())) closeScriptedBrowser(id);
}

/* ── input translation ───────────────────────────────────────── */

function toPixels(event, width, height) {
  return { x: Math.round(event.x * width), y: Math.round(event.y * height) };
}

function pointerEvent(wc, event, width, height) {
  const { x, y } = toPixels(event, width, height);
  const button = event.b === 'right' ? 'right' : event.b === 'middle' ? 'middle' : 'left';

  switch (event.a) {
    case 'move':
      return wc.sendInputEvent({ type: 'mouseMove', x, y });
    case 'down':
      return wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
    case 'up':
      return wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
    case 'click':
      wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
      return wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
    case 'dblclick':
      wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 2 });
      return wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 2 });
    default:
      return undefined;
  }
}

function wheelEvent(wc, event, width, height) {
  const { x, y } = toPixels(event, width, height);
  return wc.sendInputEvent({
    type: 'mouseWheel',
    x, y,
    deltaX: -event.dx,
    deltaY: -event.dy,
  });
}

/**
 * DOM `KeyboardEvent.key` values map onto Electron's `sendInputEvent`
 * keyCode strings almost one-to-one; the handful of renamed arrow/space keys
 * are the only real divergence.
 */
const KEY_RENAME = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  ' ': 'Space', Escape: 'Escape', Control: 'Control', Alt: 'Alt', Shift: 'Shift',
  Meta: 'Meta', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete',
  Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Insert: 'Insert', CapsLock: 'Capslock',
};

function electronKeyCode(event) {
  return KEY_RENAME[event.key] || event.key;
}

function modifierList(mask) {
  const mods = [];
  if (mask & 1) mods.push('control');
  if (mask & 2) mods.push('alt');
  if (mask & 4) mods.push('shift');
  if (mask & 8) mods.push('meta');
  return mods;
}

function keyEvent(wc, event) {
  const keyCode = electronKeyCode(event);
  const modifiers = modifierList(event.m || 0);

  if (event.a === 'down') {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    // A plain single character also needs a 'char' event to actually appear
    // in a text field — keyDown alone only fires JS keydown handlers.
    if (event.key.length === 1) {
      wc.sendInputEvent({ type: 'char', keyCode: event.key, modifiers });
    }
    return undefined;
  }
  if (event.a === 'up') {
    return wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (event.key.length === 1) wc.sendInputEvent({ type: 'char', keyCode: event.key, modifiers });
  return wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

function typeText(wc, text) {
  for (const ch of text) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
    wc.sendInputEvent({ type: 'char', keyCode: ch });
    wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
  }
}
