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
  ensureProfile,
  getMyProfile,
  isSignedIn,
  loadAuthSettings,
  saveUsername,
  signIn as apiSignIn,
  signOut as apiSignOut,
  signUp as apiSignUp,
  startOAuth,
} from './supabase-client.js';
import {
  isProviderEnabled,
  passwordChecks,
  validateEmail,
  validatePassword,
  validateSignupCredentials,
  validateSignupForm,
} from './auth-utils.js';
import { displayUsername, validateUsername } from './username-utils.js';
import { describeError, refreshAccount } from './direct-messages.js';

const el = {};

/**
 * Hard deadline for the initial session check.
 *
 * Every network call already has its own budget, but the gate is the outermost
 * boundary: if anything in the check chain failed to settle, the user would sit
 * on "Checking your session…" with no way forward. After this long we stop
 * waiting and show a retryable sign-in screen instead of a spinner.
 */
const SESSION_CHECK_DEADLINE_MS = 12000;

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

/* Button labels while a request is in flight: the pressed button says what it
 * is doing, so a slow network never looks like a dead tap. */
const BUSY_LABELS = {
  signin: { idle: 'Sign in', busy: 'Signing in…' },
  signup: { idle: 'Create account', busy: 'Creating your account…' },
  username: { idle: 'Save username', busy: 'Saving…' },
};

function setBusy(busy, active = '') {
  state.busy = Boolean(busy);
  const buttons = { signin: el.signInBtn, signup: el.signUpBtn, username: el.usernameSave };
  for (const [key, button] of Object.entries(buttons)) {
    if (!button) continue;
    button.disabled = state.busy;
    const label = BUSY_LABELS[key];
    if (!label) continue;
    button.textContent = state.busy && key === active ? label.busy : label.idle;
  }
  // OAuth buttons keep their icon, so only the disabled state changes.
  for (const button of [el.googleBtn, el.googleBtnSignIn]) {
    if (!button) continue;
    button.disabled = state.busy;
    button.setAttribute('aria-busy', state.busy && active === 'google' ? 'true' : 'false');
  }
  if (el.gate) el.gate.dataset.busy = state.busy ? 'yes' : 'no';
}

import { closeLayer, openLayer, resetLayers } from './back-nav.js';

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
  if (screen === 'signup') focusIfDesktop(el.emailNew);
  if (screen === 'username') focusIfDesktop(el.usernameInput);

  // Leaving Create Account (by Back or by tapping "Sign in") drops its entry,
  // so history never keeps a dead signup step around.
  if (screen !== 'signup') closeLayer('auth-signup');
}

/** Let the app through. */
function unlock() {
  if (el.gate) el.gate.hidden = true;
  document.body.classList.remove('auth-locked');
  state.screen = 'app';
  hooks.onUnlocked();
  // A fresh session starts at the root; no gate step or panel survives it.
  resetLayers();
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
      // No username yet: either a brand-new account or a confirmation link that
      // carried no stored intent. Create the default profile automatically so
      // signup lands straight in the chat; the manual step stays as a fallback
      // for accounts where the automatic attempt cannot complete.
      try {
        await ensureProfile();
        unlock();
        return 'app';
      } catch {
        lock('username');
        return 'username';
      }
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

  setBusy(true, 'signin');
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

  const email = (el.emailNew?.value || '').trim();
  const password = el.passwordNew?.value || '';

  const form = validateSignupCredentials({ email, password });
  if (!form.ok) {
    return setError(form.errors.email || form.errors.password || 'Please check the details above.');
  }

  setBusy(true, 'signup');
  setError('');
  setNotice('');

  try {
    const result = await apiSignUp(form.value.email, form.value.password);

    // Email confirmation is never bypassed: without a session Supabase created
    // an unconfirmed account, so the user is sent to sign in with the link.
    if (result?.needsEmailConfirmation) {
      setScreen('signin');
      setNotice(
        `Account created. Open the confirmation link we sent to ${form.value.email}, then sign in here.`
      );
      if (el.email) el.email.value = form.value.email;
      return;
    }

    if (el.passwordNew) el.passwordNew.value = '';
    renderPasswordRequirements(el.passwordNew, el.passwordReq);

    // Signed in immediately: give the new account a real, unique profile so the
    // app opens in the chat instead of an onboarding form. A profile problem
    // must not hide the app, so the one-time username step stays available.
    try {
      await ensureProfile();
    } catch {
      setNotice('Signed in. We could not finish your profile — you can set a username from your profile.');
    }

    await checkSession({ silent: true });
  } catch (error) {
    setError(describeError(error));
  } finally {
    setBusy(false);
  }
}

/** Show or hide a password field without moving focus out of the input. */
function wirePasswordToggle(input, toggle) {
  if (!input || !toggle) return;
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    toggle.textContent = show ? 'Hide' : 'Show';
  });
}

/** Render the live password checklist next to the signup password field. */
function renderPasswordRequirements(input, list) {
  if (!list) return;
  list.replaceChildren();
  for (const check of passwordChecks(input?.value || '')) {
    const item = document.createElement('li');
    item.className = 'authgate__reqitem';
    item.dataset.met = check.met ? 'yes' : 'no';
    item.textContent = check.label;
    list.appendChild(item);
  }
}

/**
 * Start Google sign-in. The redirect returns to this origin with the session in
 * the URL fragment, which the existing confirmation handler already consumes.
 */
async function startGoogle() {
  if (state.busy) return;
  setError('');
  setNotice('');
  setBusy(true, 'google');
  try {
    await startOAuth('google');
  } catch (error) {
    setBusy(false);
    setError(describeError(error));
  }
}

/**
 * Reveal the Google buttons only when the Supabase project really has the
 * provider enabled. Supabase's public /auth/v1/settings lists enabled
 * providers, so a project without Google credentials shows nothing rather than
 * a button that dead-ends.
 */
async function applyOAuthAvailability({ attempts = 2 } = {}) {
  // One failed settings request must not hide the button for the whole session:
  // a single retry covers a cold start or a network blip. The check still ends
  // closed, so a project without Google never shows a dead button.
  let settings = null;
  for (let attempt = 0; attempt < attempts && !settings; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      settings = await loadAuthSettings();
    } catch {
      settings = null;
    }
  }
  const enabled = isProviderEnabled(settings, 'google');
  state.oauthEnabled = enabled;
  for (const node of [el.oauthSignIn, el.oauthSignUp]) {
    if (node) node.hidden = !enabled;
  }
  return enabled;
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

/** True only once the gate has verified a session and let the app through. */
export function isUnlocked() {
  return state.screen === 'app';
}

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

  el.emailNew = document.getElementById('authEmailNew');
  el.passwordNew = document.getElementById('authPasswordNew');
  el.passwordNewToggle = document.getElementById('authPasswordNewToggle');
  el.passwordReq = document.getElementById('authPasswordNewReq');
  el.signUpBtn = document.getElementById('authSignUpBtn');
  el.goSignIn = document.getElementById('authGoSignIn');

  el.passwordToggle = document.getElementById('authPasswordToggle');
  el.oauthSignIn = document.getElementById('authOauth');
  el.oauthSignUp = document.getElementById('authOauthSignup');
  el.googleBtn = document.getElementById('authGoogleBtn');
  el.googleBtnSignIn = document.getElementById('authGoogleBtnSignIn');

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

    el.goSignUp?.addEventListener('click', () => {
      setScreen('signup');
      // Back from Create Account returns to Sign In instead of closing the app.
      openLayer('auth-signup', () => {
        if (state.screen !== 'app') setScreen('signin');
      });
    });
    el.goSignIn?.addEventListener('click', () => setScreen('signin'));
    el.usernameSignOut?.addEventListener('click', () => {
      signOutNow().catch(() => {});
    });

    // Password visibility, plus the live checklist on the signup screen.
    wirePasswordToggle(el.password, el.passwordToggle);
    wirePasswordToggle(el.passwordNew, el.passwordNewToggle);
    el.passwordNew?.addEventListener('input', () =>
      renderPasswordRequirements(el.passwordNew, el.passwordReq)
    );
    renderPasswordRequirements(el.passwordNew, el.passwordReq);

    // Optional Google sign-in: both buttons share one handler, and the blocks
    // stay hidden unless the project reports the provider as enabled.
    el.googleBtn?.addEventListener('click', startGoogle);
    el.googleBtnSignIn?.addEventListener('click', startGoogle);
    applyOAuthAvailability().catch(() => {});

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

  // Belt and braces: whatever the check chain does, the user must leave the
  // "Checking your session…" screen within this budget.
  const deadline = new Promise((resolve) => {
    setTimeout(() => resolve('deadline'), SESSION_CHECK_DEADLINE_MS);
  });

  Promise.race([checkSession(), deadline])
    .then((result) => {
      if (result === 'deadline' && state.screen === 'checking') {
        lock('signin');
        setError('Could not check your session. Check your connection and try again.');
      }
    })
    .catch(() => {
      lock('signin');
      setError('Could not check your session. Check your connection and try again.');
    });
}
