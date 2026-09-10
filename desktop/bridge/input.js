/**
 * Replays remote input on the real desktop.
 *
 * The actual key and mouse synthesis needs a native module, which is the one
 * part of this app that cannot be pure JavaScript. It is an *optional*
 * dependency on purpose: if it is missing or fails to build, the connector
 * still runs and control sessions simply become view-only rather than the
 * whole app refusing to start.
 */

let backend = null;
let probed = false;
let reason = 'not probed yet';

async function loadBackend() {
  if (probed) return backend;
  probed = true;
  try {
    const nut = await import('@nut-tree-fork/nut-js');
    // Zero delays: the viewer already paces events, and nut's defaults add
    // ~100ms per action which makes dragging unusable.
    nut.mouse.config.autoDelayMs = 0;
    nut.keyboard.config.autoDelayMs = 0;
    backend = nut;
    reason = 'ready';
  } catch (err) {
    backend = null;
    reason = `native input module unavailable: ${err.message}`;
  }
  return backend;
}

/**
 * True relative mouse motion, for games that use the Pointer Lock API.
 *
 * nut-js/libnut only ever offer SetCursorPos-style absolute warping — there
 * is no relative primitive anywhere in that stack. On Windows, Chromium's
 * Pointer Lock computes movementX/Y from the raw-input (WM_INPUT) mouse
 * queue while locked, specifically *not* from cursor-position deltas, so a
 * SetCursorPos-based nudge either produces no motion the game can see or
 * fights with the browser's own handling of the (hidden, locked) cursor.
 * Reported as a game's camera spasming or spinning on every move — not
 * occasionally; structurally, every single injected move was affected.
 *
 * SendInput's relative MOUSEEVENTF_MOVE — no MOUSEEVENTF_ABSOLUTE — injects
 * into that same low-level mouse queue as a real device would, which is what
 * actually reaches a locked page. koffi calls it directly via user32.dll; no
 * native compile step, so it stays an optional dependency like nut-js.
 * Windows-only: this specific failure mode is a Windows Pointer Lock
 * implementation detail, and absolute nudging remains the mouse-look path on
 * other platforms.
 */
let sendInput = null;
let sendInputProbed = false;

async function loadSendInput() {
  if (sendInputProbed) return sendInput;
  sendInputProbed = true;
  if (process.platform !== 'win32') return null;
  try {
    // koffi is CJS; dynamic import() into this ESM module exposes its
    // module.exports as the default export.
    const koffi = (await import('koffi')).default;
    const user32 = koffi.load('user32.dll');
    const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
      dx: 'long', dy: 'long',
      mouseData: 'uint32', dwFlags: 'uint32',
      time: 'uint32', dwExtraInfo: 'uint64',
    });
    const INPUT = koffi.struct('INPUT', { type: 'uint32', mi: MOUSEINPUT });
    sendInput = {
      call: user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int']),
      size: koffi.sizeof(INPUT),
    };
  } catch {
    // Falls back to cursor-nudging below — worse for a Pointer-Locked game,
    // but still functional for everything else this module does.
    sendInput = null;
  }
  return sendInput;
}

const MOUSEEVENTF_MOVE = 0x0001;

export async function inputAvailable() {
  return !!(await loadBackend());
}

export function inputStatus() {
  return reason;
}

/**
 * @param {object} event  a validated event from input-protocol.js
 * @param {{x:number,y:number,width:number,height:number}} bounds
 *        the display being shared, in real desktop pixels
 */
export async function injectInput(event, bounds) {
  const nut = await loadBackend();
  if (!nut) throw new Error(reason);

  // Mouse-move events arrive far faster than an IPC round trip to nut-js
  // completes — the viewer paces them at up to ~125Hz, one native call away.
  // Handling them as they arrive, unserialized, meant two in-flight moves
  // could each read the cursor's position before the other had written its
  // own, so one delta silently overwrote the other instead of both applying.
  // Under a fast flick that dropped or reordered enough deltas to feel like
  // the cursor was fighting the mouse — reported as a game's camera randomly
  // "tripping out" or spinning. Queuing every position-touching call behind
  // the previous one's completion is what actually fixes that, not just
  // caching the position (below) — the cache only removes the read half of
  // the race, not the write-ordering half.
  if (event.t === 'p' || event.t === 'pr' || event.t === 'w') {
    return enqueue(() => {
      if (event.t === 'pr') return pointerRelEvent(nut, event);
      if (event.t === 'w') return wheelEvent(nut, event, bounds);
      return pointerEvent(nut, event, bounds);
    });
  }

  switch (event.t) {
    case 'k': return keyEvent(nut, event);
    case 'ku': return releaseAllKeys(nut);
    case 'x': return nut.keyboard.type(event.v);
    case 'c': return setClipboard(nut, event.v);
    default: return undefined;
  }
}

/**
 * Keys this connector has pressed and not yet released.
 *
 * The viewer keeps its own list and is the first line of defence, but it can
 * only ever release what it saw pressed — and it is exactly the events it
 * never sees (a chord the browser or ChromeOS swallowed, a tab closed
 * mid-keystroke, a connection that dropped between the down and the up) that
 * strand a modifier here. This side is the one that knows the truth, because
 * this side is the one that pressed the key.
 */
const pressedKeys = new Set();

/** Lets go of everything, in reverse order of pressing. Never throws. */
async function releaseAllKeys(nut) {
  // Reversed so a chord comes apart the way a hand would: Ctrl+Shift+X lets
  // go of X first, not of Ctrl, which would otherwise deliver a bare Shift+X
  // to whatever is focused on the way out.
  const keys = Array.from(pressedKeys).reverse();
  pressedKeys.clear();
  for (const mapped of keys) {
    try {
      await nut.keyboard.releaseKey(mapped);
    } catch {
      /* Already up, or the backend disagrees about this key — either way the
         goal is "nothing held", so keep going through the rest. */
    }
  }
}

/** The connector is shutting down; do not leave the desktop holding keys. */
export async function releaseAll() {
  const nut = await loadBackend();
  if (nut) await releaseAllKeys(nut);
}

let mouseQueue = Promise.resolve();

/** Runs `task` after every previously queued mouse task has settled. */
function enqueue(task) {
  const run = mouseQueue.then(task, task);
  // Swallow so one failed task does not wedge every task queued after it —
  // the caller of enqueue() still sees its own rejection via `run`.
  mouseQueue = run.catch(() => {});
  return run;
}

/**
 * Where the cursor actually is, tracked locally instead of re-read from the
 * OS on every relative move — nut-js's own getPosition() is itself an IPC
 * round trip, and calling it per event was the other half of the race this
 * queue exists to close. Cleared whenever an absolute move lands, so the two
 * kinds of positioning can never drift apart from each other.
 */
let cachedPos = null;

function toPixels(event, bounds) {
  return {
    x: Math.round(bounds.x + event.x * bounds.width),
    y: Math.round(bounds.y + event.y * bounds.height),
  };
}

function buttonOf(nut, name) {
  if (name === 'right') return nut.Button.RIGHT;
  if (name === 'middle') return nut.Button.MIDDLE;
  return nut.Button.LEFT;
}

async function pointerEvent(nut, event, bounds) {
  // Under Pointer Lock the viewer has no meaningful x/y — it is driving via
  // relative deltas instead (see pointerRelEvent) — so a click there must not
  // also snap the cursor back to some stale absolute position.
  if (!event.rel) {
    const { x, y } = toPixels(event, bounds);
    cachedPos = { x, y };
    await nut.mouse.setPosition(new nut.Point(x, y));
  }

  const button = buttonOf(nut, event.b);
  switch (event.a) {
    case 'down':     return nut.mouse.pressButton(button);
    case 'up':       return nut.mouse.releaseButton(button);
    case 'click':    return nut.mouse.click(button);
    case 'dblclick': return nut.mouse.doubleClick(button);
    default:         return undefined; // plain move, already applied
  }
}

/** Always via `enqueue()`; see injectInput() and loadSendInput() above. */
async function pointerRelEvent(nut, event) {
  const si = await loadSendInput();
  if (si) {
    si.call(1, {
      type: 0, // INPUT_MOUSE
      mi: { dx: event.dx, dy: event.dy, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE, time: 0, dwExtraInfo: 0 },
    }, si.size);
    cachedPos = null; // SendInput moved the real cursor — the cache is now unknown, not stale-safe.
    return;
  }
  if (!cachedPos) cachedPos = await nut.mouse.getPosition();
  cachedPos = { x: cachedPos.x + event.dx, y: cachedPos.y + event.dy };
  await nut.mouse.setPosition(new nut.Point(Math.round(cachedPos.x), Math.round(cachedPos.y)));
}

/**
 * Leftover scroll pixels that did not add up to a whole notch yet.
 *
 * Browsers report pixels and nut counts notches, and the old rounding gave
 * *any* non-zero delta at least one full notch. A mouse wheel produces one
 * ~100px delta per notch so that was invisible there, but a precision
 * trackpad — every Chromebook — produces a stream of 2–10px deltas for the
 * same gesture, each of which was being promoted to a whole notch. A gentle
 * two-finger scroll therefore arrived on the PC as ten or twenty notches and
 * the page shot past whatever you were reading. Carrying the remainder
 * forward makes a hundred pixels of gesture equal a hundred pixels of scroll,
 * however finely they were reported.
 */
const PIXELS_PER_NOTCH = 100;
let scrollDebtX = 0;
let scrollDebtY = 0;

async function wheelEvent(nut, event, bounds) {
  const { x, y } = toPixels(event, bounds);
  cachedPos = { x, y };
  await nut.mouse.setPosition(new nut.Point(x, y));

  // A reversal means a new gesture, and carrying the old one's leftovers into
  // it would spend them in the wrong direction. Only an actual reversal: a
  // zero delta on one axis is a scroll along the *other* one, not a change of
  // mind about this one, and `Math.sign(0) === -Math.sign(0)` would otherwise
  // read it as one and throw the gesture's progress away.
  if (reversed(event.dy, scrollDebtY)) scrollDebtY = 0;
  if (reversed(event.dx, scrollDebtX)) scrollDebtX = 0;

  scrollDebtY += event.dy || 0;
  scrollDebtX += event.dx || 0;

  // Whole notches only; the fraction stays on the books for the next event.
  // Clamped so a single flung gesture cannot ask for a hundred notches at
  // once, which nut replays one blocking call at a time.
  const take = (debt) => clamp(Math.trunc(debt / PIXELS_PER_NOTCH), -10, 10);

  const stepsY = take(scrollDebtY);
  if (stepsY) {
    scrollDebtY = keepFraction(scrollDebtY - stepsY * PIXELS_PER_NOTCH);
    if (stepsY > 0) await nut.mouse.scrollDown(stepsY);
    else await nut.mouse.scrollUp(-stepsY);
  }

  const stepsX = take(scrollDebtX);
  if (stepsX) {
    scrollDebtX = keepFraction(scrollDebtX - stepsX * PIXELS_PER_NOTCH);
    if (stepsX > 0) await nut.mouse.scrollRight(stepsX);
    else await nut.mouse.scrollLeft(-stepsX);
  }
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/**
 * What is left over after the whole notches have been spent — but never more
 * than one notch's worth. A hard fling reports thousands of pixels in a
 * single event and the ±10 clamp above deliberately refuses to replay all of
 * them at once; without this the unspent remainder would simply sit there and
 * be added to whatever you scrolled next, minutes later.
 */
const keepFraction = (debt) => clamp(debt, -PIXELS_PER_NOTCH, PIXELS_PER_NOTCH);

/** True only when `delta` genuinely pushes against an existing debt. */
const reversed = (delta, debt) => !!delta && !!debt && (delta > 0) !== (debt > 0);

async function keyEvent(nut, event) {
  const mapped = mapKey(nut, event.code, event.key);
  if (mapped == null) {
    // No physical key for it — fall back to typing the character on press.
    if (event.a === 'down' && typeof event.key === 'string' && event.key.length === 1) {
      return nut.keyboard.type(event.key);
    }
    return undefined;
  }
  if (event.a === 'down') {
    pressedKeys.add(mapped);
    return nut.keyboard.pressKey(mapped);
  }
  if (event.a === 'up') {
    pressedKeys.delete(mapped);
    return nut.keyboard.releaseKey(mapped);
  }
  await nut.keyboard.pressKey(mapped);
  pressedKeys.delete(mapped);
  return nut.keyboard.releaseKey(mapped);
}

async function setClipboard(nut, value) {
  try {
    await nut.clipboard.setContent(value);
  } catch {
    // Older builds expose it as `copy`.
    await nut.clipboard?.copy?.(value);
  }
}

/**
 * `KeyboardEvent.code` is a physical key, which is exactly what a synthesiser
 * wants — the layout is applied by the OS on the other end.
 */
function mapKey(nut, code, key) {
  const K = nut.Key;
  if (!code) return null;

  if (/^Key[A-Z]$/.test(code)) return K[code.slice(3)];
  if (/^Digit[0-9]$/.test(code)) return K[`Num${code.slice(5)}`];
  if (/^Numpad[0-9]$/.test(code)) return K[`NumPad${code.slice(6)}`];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return K[code];

  const table = {
    Escape: K.Escape, Tab: K.Tab, CapsLock: K.CapsLock,
    ShiftLeft: K.LeftShift, ShiftRight: K.RightShift,
    ControlLeft: K.LeftControl, ControlRight: K.RightControl,
    AltLeft: K.LeftAlt, AltRight: K.RightAlt,
    MetaLeft: K.LeftSuper, MetaRight: K.RightSuper,
    Space: K.Space, Enter: K.Enter, NumpadEnter: K.Enter,
    Backspace: K.Backspace, Delete: K.Delete, Insert: K.Insert,
    Home: K.Home, End: K.End, PageUp: K.PageUp, PageDown: K.PageDown,
    ArrowUp: K.Up, ArrowDown: K.Down, ArrowLeft: K.Left, ArrowRight: K.Right,
    Minus: K.Minus, Equal: K.Equal,
    BracketLeft: K.LeftBracket, BracketRight: K.RightBracket,
    Backslash: K.Backslash, Semicolon: K.Semicolon, Quote: K.Quote,
    Backquote: K.Grave, Comma: K.Comma, Period: K.Period, Slash: K.Slash,
    NumpadAdd: K.Add, NumpadSubtract: K.Subtract,
    NumpadMultiply: K.Multiply, NumpadDivide: K.Divide,
    NumpadDecimal: K.Decimal, NumLock: K.NumLock,
    PrintScreen: K.Print, ScrollLock: K.ScrollLock, Pause: K.Pause,
    AudioVolumeUp: K.AudioVolUp, AudioVolumeDown: K.AudioVolDown,
    AudioVolumeMute: K.AudioMute,
  };

  const mapped = table[code];
  if (mapped !== undefined) return mapped;

  // Last resort: a printable single character we can type instead.
  return typeof key === 'string' && key.length === 1 ? null : null;
}
