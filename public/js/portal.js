/**
 * Root portal. Two doors: the PC connector (a device identity, signed in
 * anonymously — nothing to type on a machine you may be standing in front of
 * with a controller) and the client app (a real account, because that account
 * is what the PCs get permanently bound to).
 */
import {
  initFirebase,
  MissingConfigError,
  readStoredConfig,
  storeConfig,
  clearStoredConfig,
  parseConfigSnippet,
  usePersistentAuth,
  waitForAuth,
  describeAuthError,
  signInAnonymously,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
} from './firebase.js';
import { $, el, openModal, toast, setBusy } from './ui.js';

const boot = $('#boot');
const errorBox = $('#portalError');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function googleMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.innerHTML =
    '<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.6 9.5 24 9.5z"/>' +
    '<path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.2 5.3-4.7 6.9l7.3 5.7c4.3-3.9 6.8-9.8 6.8-17.1z"/>' +
    '<path fill="#FBBC05" d="M10.4 28.7a14.5 14.5 0 0 1 0-9.4l-7.8-6.1a24 24 0 0 0 0 21.6l7.8-6.1z"/>' +
    '<path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.7 2.3-8.6 2.3-6.4 0-11.7-3.7-13.6-9.1l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/>';
  return svg;
}

/* ── Firebase configuration ──────────────────────────────────── */

function configModal({ dismissable = true } = {}) {
  return openModal((close) => {
    const textarea = el('textarea', {
      class: 'text-input text-input--mono',
      rows: 9,
      placeholder: 'const firebaseConfig = {\n  apiKey: "…",\n  authDomain: "…",\n  databaseURL: "…",\n  projectId: "…",\n  appId: "…"\n};',
    });
    const problem = el('p', { class: 'notice notice--danger', hidden: true });

    const save = el('button', { class: 'btn btn--primary' }, 'Save and reload');
    save.addEventListener('click', () => {
      try {
        storeConfig(parseConfigSnippet(textarea.value));
        close(true);
        location.reload();
      } catch (err) {
        problem.textContent = err.message;
        problem.hidden = false;
      }
    });

    const existing = readStoredConfig();
    if (existing) textarea.value = JSON.stringify(existing, null, 2);

    return el('div', {},
      el('h2', { class: 'modal-title' }, 'Connect a Firebase project'),
      el('p', { class: 'modal-sub' },
        'Paste the firebaseConfig snippet from Firebase console → Project settings → ' +
        'Your apps → Web app. It is kept in this browser only.'),
      textarea,
      el('p', { class: 'hint', style: { marginTop: '10px' } },
        'Enable Anonymous sign-in for the PC connector, plus Email/Password or ' +
        'Google for the client. Publish database.rules.json before pairing.'),
      problem,
      el('div', { class: 'modal-footer' },
        existing
          ? el('button', {
              class: 'btn btn--danger',
              onClick: () => { clearStoredConfig(); location.reload(); },
            }, 'Forget')
          : null,
        dismissable ? el('button', { class: 'btn btn--ghost', onClick: () => close(false) }, 'Cancel') : null,
        save,
      ),
    );
  }, { dismissable });
}

/* ── Client sign-in ──────────────────────────────────────────── */

function signInModal(auth) {
  return openModal((close) => {
    const email = el('input', { class: 'text-input', type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
    const password = el('input', { class: 'text-input', type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const problem = el('p', { class: 'notice notice--danger', hidden: true });

    const fail = (err) => {
      problem.textContent = describeAuthError(err);
      problem.hidden = false;
    };

    const submit = el('button', { class: 'btn btn--primary btn--full' }, 'Sign in');
    const register = el('button', { class: 'btn btn--ghost btn--full' }, 'Create an account');

    const withEmail = async (fn, button, label) => {
      problem.hidden = true;
      if (!email.value.trim() || !password.value) {
        problem.textContent = 'Enter an email address and a password.';
        problem.hidden = false;
        return;
      }
      setBusy(button, true, label);
      try {
        const cred = await fn(auth, email.value.trim(), password.value);
        close(cred.user);
      } catch (err) {
        fail(err);
        setBusy(button, false);
      }
    };

    submit.addEventListener('click', () => withEmail(signInWithEmailAndPassword, submit, 'Signing in…'));
    register.addEventListener('click', () => withEmail(createUserWithEmailAndPassword, register, 'Creating…'));
    password.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit.click(); });

    const google = el('button', { class: 'google-btn' }, googleMark(), 'Continue with Google');
    google.addEventListener('click', async () => {
      problem.hidden = true;
      try {
        const cred = await signInWithPopup(auth, new GoogleAuthProvider());
        close(cred.user);
      } catch (err) {
        fail(err);
      }
    });

    return el('div', {},
      el('h2', { class: 'modal-title' }, 'Sign in to the client'),
      el('p', { class: 'modal-sub' },
        'Your paired PCs live on this account, so signing in on a new device is ' +
        'all it takes to reach them again.'),
      el('div', { class: 'auth-methods' },
        google,
        el('div', { class: 'auth-divider' }, 'or'),
        el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Email'), email),
        el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Password'), password),
        problem,
        submit,
        register,
      ),
    );
  });
}

/* ── Boot ────────────────────────────────────────────────────── */

async function main() {
  let firebase;
  try {
    firebase = initFirebase();
  } catch (err) {
    boot.hidden = true;
    if (err instanceof MissingConfigError) {
      await configModal({ dismissable: false });
      return;
    }
    showError(err.message);
    return;
  }

  const { auth, config } = firebase;
  $('#projectLabel').textContent = config.projectId;
  await usePersistentAuth(auth);

  const user = await waitForAuth(auth);
  boot.hidden = true;

  // Already signed in? Skip straight past the door they came through last time.
  if (user) {
    const target = user.isAnonymous ? './pc/' : './client/';
    const card = user.isAnonymous ? $('#pcCard') : $('#clientCard');
    card.querySelector('.portal-card-cta').textContent =
      user.isAnonymous ? 'Resume this PC →' : `Continue as ${user.email || 'your account'} →`;
  }

  $('#reconfigure').addEventListener('click', (event) => {
    event.preventDefault();
    configModal();
  });

  $('#pcCard').addEventListener('click', async () => {
    const card = $('#pcCard');
    card.classList.add('loading');
    showError('');
    try {
      if (!auth.currentUser?.isAnonymous) {
        await signInAnonymously(auth);
      }
      location.href = './pc/';
    } catch (err) {
      card.classList.remove('loading');
      showError(describeAuthError(err));
    }
  });

  $('#clientCard').addEventListener('click', async () => {
    showError('');
    if (auth.currentUser && !auth.currentUser.isAnonymous) {
      location.href = './client/';
      return;
    }
    const signedIn = await signInModal(auth);
    if (signedIn) {
      toast('Signed in', 'success');
      location.href = './client/';
    }
  });
}

main().catch((err) => {
  boot.hidden = true;
  showError(err?.message || 'Failed to start.');
});
