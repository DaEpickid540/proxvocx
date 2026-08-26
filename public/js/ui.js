/** Small DOM helpers shared by every page. No framework, no build step. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastHost = null;

export function toast(message, kind = 'info', ttl = 4200) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-container' });
    document.body.append(toastHost);
  }
  const node = el('div', { class: `toast ${kind}` }, message);
  toastHost.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 320);
  }, ttl);
  return node;
}

/**
 * Opens a modal built from `render(close)`. Resolves with whatever `close`
 * was called with — `undefined` when dismissed with Escape, the backdrop or
 * the close button.
 */
export function openModal(render, { dismissable = true, width } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };

    const box = el('div', { class: 'modal-box' });
    if (width) box.style.maxWidth = width;

    if (dismissable) {
      box.append(
        el('button', { class: 'modal-close', 'aria-label': 'Close', onClick: () => finish(undefined) }, '×'),
      );
    }
    box.append(render(finish));

    const overlay = el('div', {
      class: 'modal',
      onClick: (event) => {
        if (dismissable && event.target === overlay) finish(undefined);
      },
    }, box);

    const onKey = (event) => {
      if (dismissable && event.key === 'Escape') finish(undefined);
    };
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);

    const focusable = box.querySelector('input, button.btn, select, textarea');
    if (focusable) setTimeout(() => focusable.focus(), 30);
  });
}

export function confirmModal({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return openModal((close) =>
    el('div', {},
      el('h2', { class: 'modal-title' }, title),
      el('p', { class: 'modal-sub' }, message),
      el('div', { class: 'modal-footer' },
        el('button', { class: 'btn btn--ghost', onClick: () => close(false) }, 'Cancel'),
        el('button', {
          class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`,
          onClick: () => close(true),
        }, confirmLabel),
      ),
    ),
  ).then((value) => value === true);
}

export function setBusy(button, busy, busyLabel = 'Working…') {
  if (busy) {
    button.dataset.idleLabel = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
  } else {
    button.disabled = false;
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatRelative(timestamp) {
  const ms = Date.now() - Number(timestamp || 0);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
