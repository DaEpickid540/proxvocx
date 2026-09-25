/**
 * Viewer-side key remapping for PC Control.
 *
 * A rule turns one physical key on *this* keyboard into a different key on the
 * PC — the Chromebook's Search key into Shift, say, since it sits exactly where
 * a PC keyboard's Caps Lock does. It is applied before anything leaves the
 * viewer, so the PC only ever sees the key you meant.
 *
 * Rules are kept per device, in this browser's storage, not on the account:
 * they describe a physical keyboard, and the Chromebook that needs Search →
 * Shift is not the Windows laptop signed into the same account.
 */

const STORAGE_KEY = 'proxvocx.keyRemap';

/** Sends nothing at all — for a key you keep hitting by accident. */
export const DISABLED = 'None';

/**
 * Keys a rule can send. `KeyboardEvent.code` values, because that is what the
 * host maps to a physical key; the second item is the `key` name that goes
 * with it, which the host only uses as a fallback.
 */
export const REMAP_TARGETS = [
  ['Modifiers', [
    ['ShiftLeft', 'Shift', 'Left Shift'],
    ['ShiftRight', 'Shift', 'Right Shift'],
    ['ControlLeft', 'Control', 'Left Ctrl'],
    ['ControlRight', 'Control', 'Right Ctrl'],
    ['AltLeft', 'Alt', 'Left Alt'],
    ['AltRight', 'Alt', 'Right Alt'],
    ['MetaLeft', 'Meta', 'Windows key'],
  ]],
  ['Keys', [
    ['Escape', 'Escape', 'Esc'],
    ['Tab', 'Tab', 'Tab'],
    ['CapsLock', 'CapsLock', 'Caps Lock'],
    ['Backspace', 'Backspace', 'Backspace'],
    ['Delete', 'Delete', 'Delete'],
    ['Insert', 'Insert', 'Insert'],
    ['Enter', 'Enter', 'Enter'],
    ['Space', ' ', 'Space'],
    ['Home', 'Home', 'Home'],
    ['End', 'End', 'End'],
    ['PageUp', 'PageUp', 'Page Up'],
    ['PageDown', 'PageDown', 'Page Down'],
    ['ArrowUp', 'ArrowUp', 'Up arrow'],
    ['ArrowDown', 'ArrowDown', 'Down arrow'],
    ['ArrowLeft', 'ArrowLeft', 'Left arrow'],
    ['ArrowRight', 'ArrowRight', 'Right arrow'],
    ['PrintScreen', 'PrintScreen', 'Print Screen'],
  ]],
  ['Function keys', Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`, `F${i + 1}`])],
  ['Other', [
    [DISABLED, '', 'Nothing (disable the key)'],
  ]],
];

const TARGETS_BY_CODE = new Map(
  REMAP_TARGETS.flatMap(([, keys]) => keys.map(([code, key, label]) => [code, { code, key, label }])),
);

/** Ready-made rules worth a single click. */
export const REMAP_PRESETS = [
  { label: 'Chromebook Search → Shift', from: 'MetaLeft', to: 'ShiftLeft' },
  { label: 'Chromebook Search → Caps Lock', from: 'MetaLeft', to: 'CapsLock' },
];

/** A friendly name for a physical key code, for the rule list. */
export function describeCode(code) {
  if (!code) return '—';
  const known = {
    MetaLeft: 'Search / Win (left)',
    MetaRight: 'Search / Win (right)',
    OSLeft: 'Search / Win (left)',
    OSRight: 'Search / Win (right)',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
  }[code];
  if (known) return known;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return TARGETS_BY_CODE.get(code)?.label || code;
}

export function targetLabel(code) {
  return TARGETS_BY_CODE.get(code)?.label || code;
}

/** { fromCode: toCode } — whatever is saved, or nothing. */
export function loadRemap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    // Anything not in the target list is dropped rather than trusted: a rule
    // that sends a code the host cannot map would just silently do nothing.
    return Object.fromEntries(Object.entries(parsed).filter(([, to]) => TARGETS_BY_CODE.has(to)));
  } catch {
    return {};
  }
}

export function saveRemap(map) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* private mode */ }
}

/**
 * What a physical key should be sent as: `{ code, key }`, or `null` for "send
 * nothing". Keys without a rule pass through untouched.
 *
 * Old Firefox reports the Search/Windows key as `OSLeft`/`OSRight` rather than
 * `MetaLeft`/`MetaRight`, so a rule on one covers the other.
 */
export function resolveKey(map, code, key) {
  const alias = { OSLeft: 'MetaLeft', OSRight: 'MetaRight' }[code];
  const to = map[code] ?? (alias ? map[alias] : undefined);
  if (!to) return { code, key };
  if (to === DISABLED) return null;
  const target = TARGETS_BY_CODE.get(to);
  return target ? { code: target.code, key: target.key } : { code, key };
}
