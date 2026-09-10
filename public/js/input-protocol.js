/**
 * The wire format for remote input, shared by the viewer that produces the
 * events and the connector that replays them.
 *
 * Pointer positions are normalised to 0..1 across the captured screen, never
 * pixels: the viewer's window is almost never the size of the PC's display,
 * and normalising means neither side has to know the other's resolution.
 *
 * Messages travel over the WebRTC data channel as compact JSON. The keys are
 * short because a drag can emit a couple of hundred of them a second.
 */

export const INPUT_CHANNEL = 'input';

/** Pointer: move, press, release, click, double click. */
export const pointer = (action, x, y, button = 'left', rel = false) =>
  ({ t: 'p', a: action, x: clamp01(x), y: clamp01(y), b: button, ...(rel ? { rel: true } : {}) });

/** Relative pointer motion under Pointer Lock — for FPS-style games. */
export const pointerRel = (dx, dy) => ({ t: 'pr', dx: Math.round(dx), dy: Math.round(dy) });

/** Ask the host to change its live capture frame rate, without reconnecting. */
export const setFps = (value) => ({ t: 'fps', v: value });

/** Ask the host to switch which display it is capturing, without reconnecting. */
export const switchDisplay = (id) => ({ t: 'disp', id: String(id) });

/**
 * Ask the scripted browser to re-render at this width/height ratio.
 *
 * A shape, not a size: how many pixels to spend is the PC's decision (its
 * "Page size" setting is a rendering budget), while only the viewer knows what
 * shape its stage is. Sending the ratio lets the host keep the budget and
 * still hand back a picture that fills the stage instead of one letterboxed
 * into it.
 */
export const pageAspect = (ratio) => ({ t: 'ar', v: Math.round(ratio * 1000) / 1000 });

/** Wheel, in CSS-pixel-ish deltas the host scales to notches. */
export const wheel = (x, y, dx, dy) =>
  ({ t: 'w', x: clamp01(x), y: clamp01(y), dx: Math.round(dx), dy: Math.round(dy) });

/** A single key. `key`/`code` come straight off the KeyboardEvent. */
export const key = (action, event) => ({
  t: 'k',
  a: action,
  key: event.key,
  code: event.code,
  m: modifierMask(event),
});

/**
 * "Let go of everything you think is held."
 *
 * A viewer can only send a key-up for a key it actually saw released, and
 * there are several ordinary ways it never sees that: the OS eats the release
 * (a Chromebook's Search key opens the launcher and the page never gets the
 * keyup), the browser claims the chord (Ctrl+W closes the tab), the window
 * loses focus mid-chord, or capture is dropped with Escape while a modifier
 * is down. Every one of those leaves a modifier latched *on the PC*, which is
 * how an innocent "w" later becomes Win+W and the Windows widgets panel opens
 * by itself. This is the reset, sent whenever the viewer stops being sure.
 */
export const keysUp = () => ({ t: 'ku' });

/**
 * Re-tune the encoder mid-session for a different kind of content, without
 * reconnecting. Not input — it changes how the picture is coded, not what the
 * PC does — so the host applies it even on a view-only session.
 */
export const streamMode = (value) => ({ t: 'sm', v: String(value) });

/** A run of literal text — paste, or an IME commit. */
export const text = (value) => ({ t: 'x', v: String(value).slice(0, 4096) });

/** Clipboard push from viewer to host. */
export const clipboard = (value) => ({ t: 'c', v: String(value).slice(0, 100_000) });

/**
 * Navigation commands for a 'scripted' session — the PC is driving a real
 * browser tab, and these are exactly the controls a URL bar and back/forward
 * buttons need. Sent over the same data channel as input, since it is
 * already the one live channel between the two peers.
 */
export const navGo = (url) => ({ t: 'n', a: 'go', url: String(url).slice(0, 2048) });
export const navBack = () => ({ t: 'n', a: 'back' });
export const navForward = () => ({ t: 'n', a: 'forward' });
export const navReload = () => ({ t: 'n', a: 'reload' });

/**
 * Host → client only: the real browser's navigation state, pushed whenever it
 * changes so the viewer's URL bar and back/forward buttons reflect reality —
 * a real page can navigate on its own from a click inside the video, not
 * just from the URL bar.
 */
export const navState = ({ url, title, canGoBack, canGoForward, loading }) =>
  ({ t: 'ns', url, title: String(title || '').slice(0, 200), canGoBack: !!canGoBack, canGoForward: !!canGoForward, loading: !!loading });

export const MOD = { ctrl: 1, alt: 2, shift: 4, meta: 8 };

export function modifierMask(event) {
  return (event.ctrlKey ? MOD.ctrl : 0)
    | (event.altKey ? MOD.alt : 0)
    | (event.shiftKey ? MOD.shift : 0)
    | (event.metaKey ? MOD.meta : 0);
}

export function maskToNames(mask) {
  const out = [];
  if (mask & MOD.ctrl) out.push('ctrl');
  if (mask & MOD.alt) out.push('alt');
  if (mask & MOD.shift) out.push('shift');
  if (mask & MOD.meta) out.push('meta');
  return out;
}

/** Rejects anything that is not a well-formed event before it reaches the OS. */
export function isValidEvent(event) {
  if (!event || typeof event !== 'object') return false;
  switch (event.t) {
    case 'p':
      return ['move', 'down', 'up', 'click', 'dblclick'].includes(event.a)
        && isUnit(event.x) && isUnit(event.y)
        && ['left', 'right', 'middle'].includes(event.b ?? 'left');
    case 'pr':
      return Number.isFinite(event.dx) && Number.isFinite(event.dy);
    case 'fps':
      return Number.isFinite(event.v) && event.v >= 1 && event.v <= 240;
    case 'disp':
      return typeof event.id === 'string' && event.id.length > 0 && event.id.length <= 256;
    case 'ar':
      return Number.isFinite(event.v) && event.v >= 0.2 && event.v <= 5;
    case 'w':
      return isUnit(event.x) && isUnit(event.y)
        && Number.isFinite(event.dx) && Number.isFinite(event.dy);
    case 'k':
      return ['down', 'up', 'press'].includes(event.a) && typeof event.code === 'string';
    case 'ku':
      return true;
    case 'sm':
      return typeof event.v === 'string' && event.v.length > 0 && event.v.length <= 24;
    case 'x':
    case 'c':
      return typeof event.v === 'string';
    case 'n':
      if (event.a === 'go') return typeof event.url === 'string' && /^https?:\/\//i.test(event.url);
      return ['back', 'forward', 'reload'].includes(event.a);
    default:
      return false;
  }
}

const isUnit = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Buttons a viewer may send. `contextmenu` is suppressed viewer-side. */
export const BUTTONS = ['left', 'middle', 'right'];
export const buttonFromEvent = (event) => BUTTONS[event.button] || 'left';
