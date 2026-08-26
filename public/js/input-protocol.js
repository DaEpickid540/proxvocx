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
export const pointer = (action, x, y, button = 'left') =>
  ({ t: 'p', a: action, x: clamp01(x), y: clamp01(y), b: button });

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

/** A run of literal text — paste, or an IME commit. */
export const text = (value) => ({ t: 'x', v: String(value).slice(0, 4096) });

/** Clipboard push from viewer to host. */
export const clipboard = (value) => ({ t: 'c', v: String(value).slice(0, 100_000) });

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
    case 'w':
      return isUnit(event.x) && isUnit(event.y)
        && Number.isFinite(event.dx) && Number.isFinite(event.dy);
    case 'k':
      return ['down', 'up', 'press'].includes(event.a) && typeof event.code === 'string';
    case 'x':
    case 'c':
      return typeof event.v === 'string';
    default:
      return false;
  }
}

const isUnit = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Buttons a viewer may send. `contextmenu` is suppressed viewer-side. */
export const BUTTONS = ['left', 'middle', 'right'];
export const buttonFromEvent = (event) => BUTTONS[event.button] || 'left';
