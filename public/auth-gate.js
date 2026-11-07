/**
 * LOKY AI Next — mandatory authentication gate.
 *
 * The app is unusable until a Supabase session exists. This module owns that
 * boundary and nothing else:
 *
 *   checking  → is there a stored, still-valid session?
 *   signin    → full-screen sign-in screen (separate from sign-up)
 *   signup    → full-screen create-account screen
 *   username  → post-auth step, only when the profile has no username yet
 *   app       → gate hidden, assistant + Messages reachable
 *
 * Design notes
 * ------------
 * - The session is already persisted by supabase-client.js (localStorage), so
 *   "stay signed in across restarts" needs no new storage here: we simply never
 *   clear it unless the user signs out or the provider rejects it.
 * - Nothing is fabricated. Every screen is driven by a real request result, and
 *   failures are shown as errors instead of being treated as success.
 * - The module never sees a key: it calls the same helpers as the rest of the
 *   app, and all privileged calls stay server-side.
 * - No input is focused automatically on touch devices, so opening the gate can
 *   never pop the Android keyboard on its own.
 */

import {
  SupabaseError,
  getMyProfile,
  isSignedIn,
  saveUsername,
  signIn as apiSignIn,
  signOut as apiSignOut,
  signUp as apiSignUp,
} from './supabase-client.js';
import { validateEmail, validatePassword, validateSignupForm } from './auth-utils.js';
import { displayUsername, validateUsername } from './username-utils.js';
import { describeError, refreshAccount } from './direct-messages.js';

const el = {};

const state = {
  /** 'checking' | 'signin' | 'signup' | 'username' | 'app' */
  screen: 'checking',
  busy: false,
  /** In-flight session check, so two entry points cannot race. */
  checking: null,
  ready: false,
};

let hooks = { onUnlocked: () => {}, onLocked: () => {} };

/* -------------------------------- helpers -------------------------------- */

function isTouchOnly() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    !window.matchMedia('(hover: hover) and (pointer: fine)').matches
  );
}

/** Focus an input only where a physical keyboard is expected. */
function focusIfDesktop(node) {
  if (!node || isTouchOnly()) return;
  try {
    node.focus({ preventScroll: true });
  } catch {
    /* focus is a convenience; never a requirement */
  }
}

function setError(message) {
  if (!el.error) return;
  el.error.textContent = message || '';
  el.error.hidden = !message;
}

function setNotice(message) {
  if (!el.notice) return;
  el.notice.textContent = message || '';
  el.notice.hidden = !message;
}

function setBusy(busy) {
  state.busy = Boolean(busy);
  for (const button of [el.signInBtn, el.signUpBtn, el.usernameSave]) {
    if (button) button.disabled = state.busy;
  }
  if (el.gate) el.gate.dataset.busy = state.busy ? 'yes' : 'no';
}

/** Show exactly one screen inside the gate. */
function setScreen(screen) {
  state.screen = screen;

  const screens = {
    checking: el.checking,
    signin: el.signIn,
    signup: el.signUp,
    username: el.username,
  };

  for (const [name, node] of Object.entries(screens)) {
    if (node) node.hidden = name !== screen;
  }

  // The error line belongs to the form the user is looking at.
  setError('');
  if (screen === 'signin' || screen === 'signup') setNotice('');

  if (screen === 'signin') focusIfDesktop(el.email);
  if (screen === 'signup') focusIfDesktop(el.displayName);
  if (screen === 'username') focusIfDesktop(el.usernameInput);
}

/** Let the app through. */
function unlock() {
  if (el.gate) el.gate.hidden = true;
  document.body.classList.remove('auth-locked');
  state.screen = 'app';
  hooks.onUnlocked();
  // Repaint the nav chip / profile from the same session we just verified.
  try {
    refreshAccount();
  } catch {
    /* the chip retries on its own */
  }
}

/** Keep the app closed on a specific screen. */
function lock(screen = 'signin') {
  if (el.gate) el.gate.hidden = false;
  document.body.classList.add('auth-locked');
  setScreen(screen);
  hooks.onLocked();
}

/* ----------------------------- session check ------------------------------ */

/**
 * Decide which screen the user belongs on, from the real session state.
 *
 * A stored session that the provider rejects means "signed out". A stored
 * session whose *profile* request merely failed (offline, timeout) is still a
 * valid sign-in: we let the user in and let the profile dialog offer a retry,
 * because forcing a re-login on a network blip would be a worse bug than a
 * momentarily missing username.
 */
export async function checkSession({ silent = false } = {}) {
  if (state.checking) return state.checking;

  state.checking = (async () => {
    if (!silent && state.screen !== 'app') setScreen('checking');

    if (!isSignedIn()) {
      lock('signin');
      return 'signed_out';
    }

    try {
      const profile = await getMyProfile();
      if (profile && profile.username) {
        unlock();
        return 'app';
      }
      lock('username');
      return 'username';
    } catch (error) {
      const code = error instanceof SupabaseError ? error.code : '';
      if (code === 'signed_out' || code === 'email_unconfirmed') {
        lock('signin');
        if (code === 'email_unconfirmed') setError(describeError(error));
        return 'signed_out';
      }
      unlock();
      return 'degraded';
    }
  })();

  try {
    return await state.checking;
  } finally {
    state.checking = null;
  }
}

/* -------------------------------- actions -------------------------------- */

/** Sign in with the existing Supabase password grant. */
async function submitSignIn(event) {
  event?.preventDefault();
  if (state.busy) return;

  const email = (el.email?.value || '').trim();
  const password = el.password?.value || '';

  const emailCheck = validateEmail(email);
  if (!emailCheck.ok) return setError(emailCheck.error || 'Enter a valid email address.');

  const passwordCheck = validatePassword(password);
  if (!passwordCheck.ok) return setError(passwordCheck.error || 'Enter your password.');

  setBusy(true);
  setError('');

  try {
    await apiSignIn(email, password);
    if (el.password) el.password.value = '';
    // A successful grant is not the same as a usable profile: re-check before
    // letting the user in, so a missing username still gets its one-time step.
    await checkSession({ silent: true });
  } catch (error) {
    setError(describeError(error));
  } finally {
    setBusy(false);
  }
}

/**
 * Create an account with the profile details already chosen.
 *
 * When the project requires email confirmation, Supabase returns no session;
 * that is reported honestly and the user is sent back to sign-in instead of
 * being dropped into the app without a verified account.
 */
async function submitSignUp(event) {
  event?.preventDefault();
  if (state.busy) return;

  const displayName = (el.displayName?.value || '').trim();
  const username = (el.usernameNew?.value || '').trim();
  const email = (el.emailNew?.value || '').trim();
  const password = el.passwordNew?.value || '';

  const form = validateSignupForm({ displayName, username, email, password });
  if (form && form.ok === false) {
    return setError(form.error || 'Please check the details above.');
  }

  const values = (form && form.value) || {};
  const finalUsername = values.username || username;
  const finalDisplayName = values.displayName ?? displayName;

  const usernameCheck = validateUsername(finalUsername);
  if (!usernameCheck.ok) return setError(usernameCheck.error || 'Pick a valid username.');

  setBusy(true);
  setError('');
  setNotice('');

  try {
    const result = await apiSignUp(email, password);

    if (result?.needsEmailConfirmation) {
      setScreen('signin');
      setNotice(
        `Account created. Open the confirmation link we sent to ${email}, then sign in here.`
      );
      return;
    }

    // Signed in straight away: store the chosen username now so onboarding never
    // asks for it a second time.
    try {
      await saveUsername(usernameCheck.value || finalUsername, finalDisplayName);
    } catch (error) {
      // The account exists; the username can be finished on the gate's own step.
      if (el.usernameInput) el.usernameInput.value = usernameCheck.value || finalUsername;
    }

    await checkSession({ silent: true });
  } catch (error) {
    setError(describeError(error));
  } finally {
    setBusy(false);
  }
}

/** Save the username for an already-authenticated user who has none. */
async function submitUsername(event) {
  event?.preventDefault();
  if (state.busy) return;

  const raw = (el.usernameInput?.value || '').trim();
  const check = validateUsername(raw);
  if (!check.ok) {
    if (el.usernameHelp) {
      el.usernameHelp.textContent = check.error || 'Pick a valid username.';
      el.usernameHelp.dataset.kind = 'error';
    }
    return setError(check.error || 'Pick a valid username.');
  }

  setBusy(true);
  setError('');

  try {
    await saveUsername(check.value || raw);
    await checkSession({ silent: true });
  } catch (error) {
    setError(describeError(error));
  } finally {
    setBusy(false);
  }
}

/** Clear the session and return to the sign-in screen. */
export async function signOutNow() {
  try {
    await apiSignOut();
  } catch {
    /* even a failed revoke must not leave the UI looking signed in */
  }
  lock('signin');
  setNotice('You have been signed out.');
}

/* ------------------------------- entry points ----------------------------- */

/** Open the sign-in screen (used by the profile dialog). */
export function openAuthGate() {
  lock('signin');
}

/** Open the one-time username step (used when a profile has no username). */
export function openUsernameSetup() {
  if (el.usernameInput) el.usernameInput.value = '';
  lock('username');
}

/** Wire the gate once. Called from app.js at page load. */
export function initAuthGate(nextHooks = {}) {
  hooks = { ...hooks, ...nextHooks };

  el.gate = document.getElementById('authGate');
  if (!el.gate) return;

  el.checking = document.getElementById('authChecking');
  el.signIn = document.getElementById('authSignIn');
  el.signUp = document.getElementById('authSignUp');
  el.username = document.getElementById('authUsername');

  el.email = document.getElementById('authEmail');
  el.password = document.getElementById('authPassword');
  el.signInBtn = document.getElementById('authSignInBtn');
  el.goSignUp = document.getElementById('authGoSignUp');

  el.displayName = document.getElementById('authDisplayName');
  el.usernameNew = document.getElementById('authUsernameNew');
  el.emailNew = document.getElementById('authEmailNew');
  el.passwordNew = document.getElementById('authPasswordNew');
  el.signUpBtn = document.getElementById('authSignUpBtn');
  el.goSignIn = document.getElementById('authGoSignIn');

  el.usernameInput = document.getElementById('authUsernameInput');
  el.usernameHelp = document.getElementById('authUsernameHelp');
  el.usernameSave = document.getElementById('authUsernameSave');
  el.usernameSignOut = document.getElementById('authUsernameSignOut');

  el.error = document.getElementById('authError');
  el.notice = document.getElementById('authNotice');

  if (!state.ready) {
    state.ready = true;

    el.signIn?.addEventListener('submit', submitSignIn);
    el.signUp?.addEventListener('submit', submitSignUp);
    el.username?.addEventListener('submit', submitUsername);

    el.goSignUp?.addEventListener('click', () => setScreen('signup'));
    el.goSignIn?.addEventListener('click', () => setScreen('signin'));
    el.usernameSignOut?.addEventListener('click', () => {
      signOutNow().catch(() => {});
    });

    // Live username feedback uses the same rules the database enforces.
    el.usernameNew?.addEventListener('input', () => {
      const value = el.usernameNew.value.trim();
      if (!el.signupHelp) return;
      if (!value) {
        el.signupHelp.textContent = '3–20 letters, numbers or _ — this is how people find you.';
        el.signupHelp.dataset.kind = '';
        return;
      }
      const check = validateUsername(value);
      el.signupHelp.textContent = check.ok
        ? `You will be reachable as ${displayUsername(check.value)}`
        : check.error;
      el.signupHelp.dataset.kind = check.ok ? 'ok' : 'error';
    });

    el.usernameInput?.addEventListener('input', () => {
      if (!el.usernameHelp) return;
      const value = el.usernameInput.value.trim();
      if (!value) {
        el.usernameHelp.textContent = 'Pick a username so people can find you.';
        el.usernameHelp.dataset.kind = '';
        return;
      }
      const check = validateUsername(value);
      el.usernameHelp.textContent = check.ok
        ? `You will be reachable as ${displayUsername(check.value)}`
        : check.error;
      el.usernameHelp.dataset.kind = check.ok ? 'ok' : 'error';
    });

    // The profile dialog can sign out and the redirect handler can establish a
    // session; both announce it, so the gate never has to poll.
    window.addEventListener('loky:auth-changed', (event) => {
      const signedIn = Boolean(event?.detail?.signedIn);
      if (signedIn) {
        checkSession({ silent: true }).catch(() => {});
      } else {
        lock('signin');
      }
    });
  }

  // The gate starts visible in the markup, so a slow or failed check can never
  // flash the assistant. The first real answer decides the screen.
  document.body.classList.add('auth-locked');
  checkSession().catch(() => {
    lock('signin');
    setError('Could not check your session. Check your connection and try again.');
  });
}
