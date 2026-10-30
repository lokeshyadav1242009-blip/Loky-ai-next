/**
 * LOKY AI Next — Mini Chat account layer (usernames + real people).
 *
 * This module owns everything that needs a server:
 *   - sign in / sign up / sign out (Supabase Auth)
 *   - creating and changing your username (uniqueness enforced by the DB)
 *   - searching other registered users by username
 *   - opening / sending messages in a real conversation
 *
 * It is deliberately separate from messages.js so the existing local
 * conversations keep working exactly as before, and so the "Messages makes no
 * network calls" guarantee still holds for messages.js itself.
 *
 * Nothing here decides authorization: Row Level Security does. See
 * supabase/migrations/0001_username_system.sql.
 */

import { displayUsername, normalizeUsername, validateUsername } from './username-utils.js';
import {
  createSignupIntent,
  describeAuthLinkError,
  isSignupIntentUsable,
  parseAuthRedirect,
  stripAuthRedirect,
  validateSignupForm,
} from './auth-utils.js';
import {
  SupabaseError,
  currentUser,
  establishSession,
  getMyProfile,
  isSignedIn,
  listMessages,
  saveUsername,
  searchUsers,
  sendMessage as sendRemoteMessageApi,
  signIn as apiSignIn,
  signOut as apiSignOut,
  signUp as apiSignUp,
  startConversation,
  verifyTokenHash,
} from './supabase-client.js';
import { avatarColorFor, initialsFor } from './messages-utils.js';

const el = {
  account: null,
  configNote: null,
  signedOut: null,
  email: null,
  password: null,
  signInBtn: null,
  signUpBtn: null,
  signedIn: null,
  whoami: null,
  signOutBtn: null,
  usernameForm: null,
  usernameInput: null,
  usernameSave: null,
  usernameHelp: null,
  find: null,
  searchInput: null,
  results: null,
  notice: null,
  // Nav-level account chip + profile dialog (visible from every section).
  navAccount: null,
  navAvatar: null,
  navAccountLabel: null,
  profileDialog: null,
  profileClose: null,
  profileAvatar: null,
  profileHandle: null,
  profileMeta: null,
  profileUsername: null,
  profileEmail: null,
  profileState: null,
  profileActions: null,
  whoamiEmail: null,
  // Signup extras (display name + username) and the app-wide auth banner.
  signupFields: null,
  displayName: null,
  usernameNew: null,
  signupHelp: null,
  banner: null,
};

const state = {
  ready: false,
  profileReady: false,
  user: null,
  profile: null,
  /** 'unknown' | 'loading' | 'signed_out' | 'signed_in' | 'error' */
  status: 'unknown',
  authError: '',
  /** Blocks repeated failed sign-in/sign-up attempts until the cooldown ends. */
  cooldownUntil: 0,
  cooldownTimer: null,
  results: [],
  busy: false,
  /** True once "Create account" has revealed the display name + username fields. */
  signupOpen: false,
  /** Set when the username chosen at signup was taken after the email confirmed. */
  signupConflict: '',
  pollTimer: null,
  pollThreadId: null,
  renderToken: 0,
};

let hooks = { openRemoteThread: () => {}, rerender: () => {}, openMessages: () => {} };

/**
 * The profile check that is currently in flight, if any.
 *
 * Every entry point (page load, Messages opening, the dialog's "Try again" and
 * the nav chip) funnels through `bootstrap()`, so this guard is what keeps a
 * double tap from firing two profile requests at once.
 */
let profileRequest = null;

/* -------------------------------- helpers -------------------------------- */

function setStatus(message, kind = 'info') {
  if (!el.notice) return;
  el.notice.textContent = message || '';
  el.notice.dataset.kind = kind;
  el.notice.hidden = !message;
}

function setBusy(busy) {
  state.busy = busy;
  const locked = busy || isCoolingDown();
  for (const button of [el.signInBtn, el.signUpBtn, el.usernameSave, el.signOutBtn]) {
    if (button) button.disabled = locked;
  }
  renderChip();
  renderProfile();
}

/** True while a failed attempt has locked the buttons. */
function isCoolingDown() {
  return state.cooldownUntil > Date.now();
}

/**
 * Lock the auth buttons for a while after a rate limit. The point is that a
 * throttled request must never be re-fired by the user tapping again, which is
 * what turns one 429 into a long lockout.
 */
function startCooldown(seconds, reason) {
  const wait = Math.max(1, Math.min(Math.ceil(seconds) || 60, 3600));
  state.cooldownUntil = Date.now() + wait * 1000;
  if (state.cooldownTimer) clearInterval(state.cooldownTimer);

  const paint = () => {
    const left = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
    if (left > 0) {
      setStatus(`${reason} You can try again in ${left}s.`, 'error');
      return;
    }
    clearInterval(state.cooldownTimer);
    state.cooldownTimer = null;
    state.cooldownUntil = 0;
    setBusy(false);
    setStatus('You can try again now.', 'info');
  };

  setBusy(false);
  state.cooldownTimer = setInterval(paint, 1000);
  paint();
}

/** Turn any thrown thing into something a human can act on. */
export function describeError(error) {
  if (error instanceof SupabaseError) {
    if (error.code === 'not_configured') {
      return 'Mini Chat accounts are not configured on this server yet.';
    }
    if (error.code === 'migration_missing') {
      return 'The Mini Chat database tables are missing. Apply supabase/migrations/0001_username_system.sql.';
    }
    if (error.code === 'signed_out') return 'Please sign in again.';
    if (error.code === 'network') return 'Network problem. Check your connection and retry.';
    if (error.code === 'username_taken') return 'That username is already taken. Try another one.';
    if (error.code === 'email_unconfirmed') {
      return 'This account still needs its email confirmed. Open the confirmation link we emailed you, then sign in.';
    }
    return error.message || 'Something went wrong.';
  }
  return 'Something went wrong. Please try again.';
}

/** Extra guidance shown next to an error, without repeating the error itself. */
function errorHint(error) {
  if (error instanceof SupabaseError && error.code === 'email_rate_limited') {
    return 'This limit is per project, so it applies on every device until the quota resets.';
  }
  return '';
}

function dayLabel(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function clockLabel(value) {
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* -------------------------------- rendering ------------------------------- */

/**
 * The nav chip is the always-visible answer to "am I signed in?". It is painted
 * from the same state as the profile dialog so the two can never disagree.
 */
function renderChip() {
  if (!el.navAccount) return;

  const signedIn = Boolean(state.user);
  let label = 'Sign in';
  let avatarText = '?';
  let seed = 'signed-out';
  let tone = 'out';

  if (state.status === 'loading' || state.status === 'unknown') {
    label = 'Checking…';
    avatarText = '…';
    tone = 'loading';
  } else if (signedIn) {
    const handle = state.profile?.username || '';
    label = handle ? displayUsername(handle) : state.user.email || 'Signed in';
    seed = handle || state.user.email || 'signed-in';
    avatarText = initialsFor(seed) || '?';
    tone = handle ? 'in' : 'setup';
  }

  if (state.busy) tone = 'busy';

  el.navAccount.dataset.state = tone;
  if (el.navAccountLabel) el.navAccountLabel.textContent = label;
  if (el.navAvatar) {
    el.navAvatar.textContent = avatarText;
    el.navAvatar.style.setProperty('--avatar-color', avatarColorFor(seed));
  }

  const detail = !signedIn
    ? 'Signed out. Open your profile to sign in.'
    : state.profile?.username
      ? `Signed in as ${displayUsername(state.profile.username)}`
      : 'Signed in. No username set yet.';
  el.navAccount.setAttribute('aria-label', `Profile: ${detail}`);
  el.navAccount.title = detail;
}

function profileActionButton(label, { primary = false, onClick } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = primary ? 'btn btn--primary dm-btn' : 'btn dm-btn';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

/**
 * Paint the profile dialog. Every state the user can be in has an explicit
 * branch, so the dialog is never an empty shell.
 */
function renderProfile() {
  if (!el.profileDialog) return;

  const signedIn = Boolean(state.user);
  const signedOut = state.status === 'signed_out' || (!signedIn && state.status !== 'loading');

  if (el.profileActions) el.profileActions.replaceChildren();
  if (el.profileMeta) el.profileMeta.hidden = !(signedIn && state.profile?.username);
  if (el.profileAvatar) el.profileAvatar.textContent = '?';

  if (signedIn && state.profile?.username) {
    if (el.profileAvatar) {
      el.profileAvatar.textContent = initialsFor(state.profile.username) || '?';
      el.profileAvatar.style.setProperty('--avatar-color', avatarColorFor(state.profile.username));
    }
    if (el.profileHandle) el.profileHandle.textContent = displayUsername(state.profile.username);
    if (el.profileUsername) el.profileUsername.textContent = displayUsername(state.profile.username);
    if (el.profileEmail) el.profileEmail.textContent = state.user.email || 'Not provided';
  } else if (signedIn) {
    if (el.profileAvatar) {
      el.profileAvatar.textContent = initialsFor(state.user.email || '?') || '?';
      el.profileAvatar.style.setProperty('--avatar-color', avatarColorFor(state.user.email || 'signed-in'));
    }
    if (el.profileHandle) el.profileHandle.textContent = 'No username yet';
    if (el.profileEmail) el.profileEmail.textContent = state.user.email || 'Not provided';
  } else {
    if (el.profileHandle) el.profileHandle.textContent = 'Signed out';
  }

  // Loading state: the profile request is in flight.
  if (state.status === 'loading') {
    if (el.profileState) {
      el.profileState.hidden = false;
      el.profileState.dataset.kind = 'info';
      el.profileState.textContent = 'Loading your profile…';
    }
    return;
  }

  // Error state: keep the retry explicit, never automatic.
  if (state.status === 'error') {
    if (el.profileState) {
      el.profileState.hidden = false;
      el.profileState.dataset.kind = 'error';
      el.profileState.textContent = state.authError || 'Your profile could not be loaded.';
    }
    el.profileActions?.append(
      profileActionButton(isCoolingDown() ? 'Please wait…' : 'Try again', {
        primary: true,
        onClick: () => {
          if (!isCoolingDown()) bootstrap().catch(() => {});
        },
      })
    );
    if (!signedIn) {
      el.profileActions?.append(
        profileActionButton('Sign in', {
          onClick: () => {
            closeProfile();
            hooks.openMessages();
          },
        })
      );
    }
    return;
  }

  if (el.profileState) {
    el.profileState.hidden = true;
    el.profileState.textContent = '';
  }

  if (signedIn) {
    if (!state.profile?.username) {
      if (el.profileState) {
        el.profileState.hidden = false;
        el.profileState.dataset.kind = 'info';
        el.profileState.textContent = 'Choose a username so other people can find you.';
      }
      el.profileActions?.append(
        profileActionButton('Choose a username', {
          primary: true,
          onClick: () => {
            closeProfile();
            hooks.openMessages();
            el.usernameInput?.focus();
          },
        })
      );
    }
    el.profileActions?.append(
      profileActionButton('Open Messages', {
        primary: Boolean(state.profile?.username),
        onClick: () => {
          closeProfile();
          hooks.openMessages();
        },
      }),
      profileActionButton('Sign out', {
        onClick: () => {
          closeProfile();
          doSignOut();
        },
      })
    );
    return;
  }

  // Signed out: offer the sign-in entry point instead of an empty profile.
  if (el.profileState) {
    el.profileState.hidden = false;
    el.profileState.dataset.kind = 'info';
    el.profileState.textContent = signedOut
      ? 'You are signed out. Sign in to sync your username and chat with other people.'
      : 'Checking your session…';
  }
  el.profileActions?.append(
    profileActionButton('Sign in', {
      primary: true,
      onClick: () => {
        closeProfile();
        hooks.openMessages();
        window.setTimeout(() => el.email?.focus(), 60);
      },
    })
  );
}

function renderAccount() {
  const signedIn = Boolean(state.user);

  if (el.signedOut) el.signedOut.hidden = signedIn;
  if (el.find) el.find.hidden = !signedIn || !state.profile;
  if (el.signedIn) el.signedIn.hidden = !signedIn;

  if (!signedIn) {
    if (el.whoami) el.whoami.textContent = '';
    if (el.whoamiEmail) el.whoamiEmail.textContent = '';
    renderChip();
    renderProfile();
    return;
  }

  if (el.whoami) {
    el.whoami.textContent = state.profile
      ? displayUsername(state.profile.username)
      : state.user.email || 'Signed in';
  }
  if (el.whoamiEmail) el.whoamiEmail.textContent = state.user.email || '';

  // Username form is shown until a username exists; afterwards it becomes the
  // "change username" control, prefilled with the current one.
  if (el.usernameInput && document.activeElement !== el.usernameInput) {
    el.usernameInput.value = state.profile?.username || '';
  }
  if (el.usernameSave) {
    el.usernameSave.textContent = state.profile ? 'Save username' : 'Create username';
  }
  if (el.usernameHelp && !state.profile) {
    el.usernameHelp.textContent = 'Pick a username so people can find you. 3–20 letters, numbers or _';
  }

  renderChip();
  renderProfile();
}

function renderResults() {
  if (!el.results) return;
  el.results.replaceChildren();

  if (!state.results.length) {
    el.results.hidden = true;
    return;
  }

  el.results.hidden = false;

  for (const person of state.results) {
    const li = document.createElement('li');
    li.className = 'dm-result';

    const avatar = document.createElement('span');
    avatar.className = 'msg-avatar msg-avatar--sm';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = initialsFor(person.username);
    avatar.style.background = avatarColorFor(person.avatar_seed || person.username);

    const main = document.createElement('span');
    main.className = 'dm-result__main';

    const name = document.createElement('span');
    name.className = 'dm-result__name';
    name.textContent = person.display_name || displayUsername(person.username);

    const handle = document.createElement('span');
    handle.className = 'dm-result__handle';
    handle.textContent = displayUsername(person.username);

    main.append(name, handle);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn btn--primary dm-result__action';
    action.textContent = 'Chat';
    action.addEventListener('click', () => {
      openChatWith(person, action);
    });

    li.append(avatar, main, action);
    el.results.append(li);
  }
}

/* --------------------------------- actions -------------------------------- */

async function openChatWith(person, button) {
  if (state.busy) return;
  setBusy(true);
  setStatus('');
  try {
    const conversationId = await startConversation(person.id);
    if (!conversationId) throw new SupabaseError('database', 'The conversation could not be opened.');
    state.results = [];
    renderResults();
    if (el.searchInput) el.searchInput.value = '';
    hooks.openRemoteThread(conversationId, person);
  } catch (error) {
    setStatus(describeError(error), 'error');
  } finally {
    setBusy(false);
    if (button) button.disabled = false;
  }
}

async function submitSignIn() {
  const email = el.email?.value.trim() || '';
  const password = el.password?.value || '';
  if (!email || !password) {
    setStatus('Enter your email and password.', 'error');
    return;
  }

  setBusy(true);
  setStatus('');
  try {
    await apiSignIn(email, password);
    if (el.password) el.password.value = '';
    await bootstrap({ force: true });
    // An account confirmed on another device still gets its chosen username.
    const applied = await applySignupIntent();
    setStatus(
      state.profile
        ? `Signed in as ${displayUsername(state.profile.username)}.`
        : applied
          ? `Signed in as ${displayUsername(applied.username)}.`
          : 'Signed in. Now pick a username.',
      'ok'
    );
  } catch (error) {
    if (error instanceof SupabaseError && error.code === 'email_not_confirmed') {
      setStatus(describeError(error), 'error');
      return;
    }
    // A throttled request must not be retried automatically: lock the buttons for
    // as long as Auth asked us to wait.
    if (error instanceof SupabaseError && error.status === 429) {
      state.authError = describeError(error);
      startCooldown(error.retryAfter || 60, state.authError);
      return;
    }
    const hint = errorHint(error);
    setStatus(hint ? `${describeError(error)} ${hint}` : describeError(error), 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * Two-step signup: the first tap reveals display name + username, the second
 * creates the account with everything already validated.
 */
async function submitSignUp() {
  if (!state.signupOpen) {
    state.signupOpen = true;
    if (el.signupFields) el.signupFields.hidden = false;
    if (el.signupHelp) el.signupHelp.hidden = false;
    setStatus(
      'Add a display name (optional) and the username you want — then tap "Create account".',
      'info'
    );
    el.displayName?.focus();
    return;
  }

  const form = validateSignupForm({
    displayName: el.displayName?.value || '',
    username: el.usernameNew?.value || '',
    email: el.email?.value || '',
    password: el.password?.value || '',
  });

  if (!form.ok) {
    const message =
      form.errors.username || form.errors.email || form.errors.password || 'Check the form and try again.';
    setStatus(message, 'error');
    if (form.errors.username) el.usernameNew?.focus();
    else if (form.errors.email) el.email?.focus();
    else el.password?.focus();
    return;
  }

  const { displayName, username, email, password } = form.value;
  state.signupConflict = '';
  setBusy(true);
  setStatus('');

  // Remember the username before the account exists: while confirmation is
  // pending there is no session, so the profile cannot be created yet.
  writeSignupIntent(createSignupIntent({ email, username, displayName }));

  try {
    const result = await apiSignUp(email, password);
    if (el.password) el.password.value = '';

    if (result.needsEmailConfirmation) {
      setStatus(
        `Account created for ${email}. Confirm the link we emailed you — you'll be signed in automatically ` +
          `and ${displayUsername(username)} is set up for you, no second sign-in or extra steps.`,
        'ok'
      );
      return;
    }

    await bootstrap({ force: true });
    const applied = await applySignupIntent();
    const handle = state.profile?.username || applied?.username || '';
    setStatus(
      handle
        ? `Welcome, ${displayUsername(handle)}. Your account is ready.`
        : 'Account created. Now pick a username.',
      state.signupConflict ? 'error' : 'ok'
    );
    if (state.signupConflict) setStatus(state.signupConflict, 'error');
    if (handle) {
      state.signupOpen = false;
      if (el.signupFields) el.signupFields.hidden = true;
      if (el.signupHelp) el.signupHelp.hidden = true;
    }
  } catch (error) {
    if (error instanceof SupabaseError && error.status === 429) {
      state.authError = describeError(error);
      startCooldown(error.retryAfter || 60, state.authError);
      return;
    }
    const hint = errorHint(error);
    setStatus(hint ? `${describeError(error)} ${hint}` : describeError(error), 'error');
    if (error instanceof SupabaseError && error.code === 'email_taken') {
      // The address already has an account: the intent is useless here.
      clearSignupIntent();
    }
  } finally {
    setBusy(false);
  }
}

async function submitUsername(event) {
  event?.preventDefault?.();
  const check = validateUsername(el.usernameInput?.value || '');
  if (!check.ok) {
    setStatus(check.error, 'error');
    return;
  }

  setBusy(true);
  setStatus('');
  try {
    const profile = await saveUsername(check.value, el.usernameInput?.value);
    state.profile = profile;
    renderAccount();
    setStatus(`Username saved: ${displayUsername(profile.username)}`, 'ok');
    hooks.rerender();
  } catch (error) {
    setStatus(describeError(error), 'error');
    if (el.usernameInput) el.usernameInput.focus();
  } finally {
    setBusy(false);
  }
}

async function submitSearch(event) {
  event?.preventDefault?.();
  const term = normalizeUsername(el.searchInput?.value || '');

  if (term.length < 2) {
    state.results = [];
    renderResults();
    setStatus('Type at least 2 characters of a username.', 'info');
    return;
  }

  // Never offer yourself as a contact.
  if (state.profile && term === state.profile.username) {
    state.results = [];
    renderResults();
    setStatus('That is your own username.', 'info');
    return;
  }

  setStatus('Searching…', 'info');
  try {
    const people = await searchUsers(term);
    state.results = people.filter((p) => p.id !== state.user?.id);
    renderResults();
    setStatus(state.results.length ? '' : `No user found for “${term}”.`, state.results.length ? 'info' : 'error');
  } catch (error) {
    state.results = [];
    renderResults();
    setStatus(describeError(error), 'error');
  }
}

async function doSignOut() {
  await apiSignOut();
  state.user = null;
  state.profile = null;
  state.results = [];
  state.status = 'signed_out';
  state.authError = '';
  stopPolling();
  renderAccount();
  renderResults();
  setStatus('Signed out.', 'info');
  hooks.rerender();
}

/* ---------------------------- auth redirects ----------------------------- */

/**
 * Username + display name chosen before the account was confirmed.
 *
 * With email confirmation enabled Supabase returns no session at signup, so the
 * profile row cannot be created yet (RLS requires an authenticated user). The
 * intent is kept here — no password, no token — and applied automatically the
 * first time that account has a session, so onboarding never re-asks.
 */
const SIGNUP_INTENT_KEY = 'loky.ai.next.signup.intent.v1';

function readSignupIntent() {
  try {
    const raw = globalThis.localStorage?.getItem(SIGNUP_INTENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSignupIntent(intent) {
  try {
    globalThis.localStorage?.setItem(SIGNUP_INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* private mode: onboarding just asks again */
  }
}

function clearSignupIntent() {
  try {
    globalThis.localStorage?.removeItem(SIGNUP_INTENT_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Status line for the confirmation result, visible from every section. */
function setBanner(message, kind = 'info') {
  if (el.banner) {
    el.banner.textContent = message || '';
    el.banner.dataset.kind = kind;
    el.banner.hidden = !message;
  }
  // The account panel shows the same message, so it is never only in one place.
  setStatus(message, kind);
}

/** Remove Auth's parameters from the address bar without reloading the page. */
function stripAuthParamsFromLocation(href) {
  try {
    const clean = stripAuthRedirect(href);
    const target = clean || globalThis.location?.pathname || '/';
    globalThis.history?.replaceState?.(null, '', target);
  } catch {
    /* history API unavailable: harmless, the token is still consumed once */
  }
}

/**
 * Create the profile from a stored signup intent, but only when the account has
 * none. An existing username is never overwritten.
 */
async function applySignupIntent() {
  const intent = readSignupIntent();
  if (!intent || !state.user) return null;

  // Already onboarded, or the intent belongs to a different account.
  if (state.profile?.username) {
    clearSignupIntent();
    return null;
  }
  if (!isSignupIntentUsable(intent, state.user.email)) {
    clearSignupIntent();
    return null;
  }

  try {
    const profile = await saveUsername(intent.username, intent.displayName);
    state.profile = profile;
    clearSignupIntent();
    renderAccount();
    return profile;
  } catch (error) {
    // A taken username must not trap the user in a retry loop: drop the intent
    // and let the normal username form take over.
    if (
      error instanceof SupabaseError &&
      (error.code === 'username_taken' || error.code === 'invalid_username')
    ) {
      clearSignupIntent();
      state.signupConflict = `${describeError(error)} Your email is confirmed — pick a different username in Messages.`;
      return null;
    }
    // Network/other failure: keep the intent so the next load finishes onboarding.
    return null;
  }
}

/**
 * Handle a Supabase auth redirect (#access_token=…, ?token_hash=…, ?code=…,
 * #error=…). Returns `{ handled, status }`; never throws.
 *
 * This runs once per page load, before any profile work, because the session has
 * to exist before `/rest/v1/profiles` can be authorized.
 */
let authRedirectRun = null;

export function handleAuthRedirect() {
  if (!authRedirectRun) {
    authRedirectRun = runAuthRedirect().catch((error) => {
      setBanner(describeError(error), 'error');
      return { handled: true, status: 'error' };
    });
  }
  return authRedirectRun;
}

async function runAuthRedirect() {
  const href = globalThis.location?.href || '';
  const parsed = parseAuthRedirect(href);
  if (parsed.action === 'none') return { handled: false, status: 'none' };

  // Consume the URL before doing any network work: a reload must not replay a
  // token that was just used, and the token should not stay in history.
  stripAuthParamsFromLocation(href);

  if (parsed.action === 'error') {
    setBanner(describeAuthLinkError(parsed.error), 'error');
    return { handled: true, status: 'error', code: parsed.error?.code || '' };
  }

  if (parsed.action === 'code') {
    setBanner(
      'That link was created by a different sign-in flow and cannot be completed here. ' +
        'Sign in with your email and password — your address is already confirmed.',
      'error'
    );
    return { handled: true, status: 'unsupported' };
  }

  setBanner('Confirming your email…', 'info');

  try {
    if (parsed.action === 'session') {
      await establishSession(parsed.session);
    } else {
      await verifyTokenHash(parsed.tokenHash, parsed.type || 'signup');
    }
    state.user = currentUser();
    return { handled: true, status: 'confirmed', type: parsed.type || 'signup' };
  } catch (error) {
    const expired =
      error instanceof SupabaseError &&
      (error.code === 'expired_link' || error.code === 'invalid_link' || error.status === 403);
    setBanner(
      expired ? describeAuthLinkError({ kind: 'expired' }) : describeError(error),
      'error'
    );
    return { handled: true, status: 'error', code: expired ? 'expired_link' : 'other' };
  }
}

/** Final banner once the session and profile are known after a confirmation. */
async function finishAuthRedirect(result) {
  const applied = await applySignupIntent();
  const handle = state.profile?.username ? displayUsername(state.profile.username) : '';
  const email = state.user?.email || 'your account';

  if (state.signupConflict) {
    setBanner(state.signupConflict, 'error');
  } else if (handle) {
    setBanner(`Email confirmed. You're signed in as ${handle}.`, 'ok');
  } else if (applied) {
    setBanner(`Email confirmed. You're signed in as ${displayUsername(applied.username)}.`, 'ok');
  } else {
    setBanner(
      `Email confirmed. You're signed in as ${email}. Pick a username in Messages so people can find you.`,
      'ok'
    );
  }
  renderAccount();
  renderProfile();
  return result;
}

/**
 * Page-startup auth work: consume any redirect, then validate the session.
 * Shared, so the nav chip and the Messages panel never run it twice.
 */
let authStart = null;

function startAuth() {
  if (!authStart) {
    authStart = (async () => {
      const result = await handleAuthRedirect();
      await bootstrap();
      if (result.status === 'confirmed') await finishAuthRedirect(result);
    })().catch(() => {});
  }
  return authStart;
}

/* --------------------------------- bootstrap ------------------------------ */

/**
 * Load (or reload) the session + profile and repaint everywhere.
 *
 * This runs at page load, not just when Messages opens, so a stored session is
 * restored and validated on reload. It never retries by itself: if the profile
 * request fails (or times out, see REQUEST_TIMEOUT_MS) the dialog shows the
 * error and a manual "Try again".
 *
 * At most one check runs at a time; concurrent callers share it, and `force`
 * waits for the current one before starting a fresh check (used after sign-in).
 */
export function bootstrap({ force = false } = {}) {
  if (profileRequest) {
    // Already checking: hand back the same request so a second tap is free.
    if (!force) return profileRequest;
    return profileRequest.catch(() => {}).then(() => startProfileCheck());
  }
  return startProfileCheck();
}

function startProfileCheck() {
  profileRequest = runBootstrap().finally(() => {
    profileRequest = null;
  });
  return profileRequest;
}

async function runBootstrap() {
  const hadUser = Boolean(state.user);
  state.user = currentUser();

  if (!state.user) {
    state.profile = null;
    state.status = 'signed_out';
    state.authError = '';
    renderAccount();
    hooks.rerender();
    return;
  }

  state.status = 'loading';
  state.authError = '';
  renderChip();
  renderProfile();

  try {
    state.profile = await getMyProfile();
    state.status = 'signed_in';
  } catch (error) {
    state.profile = null;
    // A failed refresh clears the stored session, so re-read it: a dead session
    // must show as signed out, not as a phantom logged-in user.
    state.user = currentUser();
    state.status = state.user ? 'error' : 'signed_out';
    state.authError = state.user ? describeError(error) : '';
    if (state.user) setStatus(describeError(error), 'error');
  }

  // Safety net: the chip must never be left on "Checking…", whatever happened
  // above. Anything still pending here is reported as a retryable error.
  if (state.status === 'loading') {
    state.status = state.user ? 'error' : 'signed_out';
    if (state.user && !state.authError) {
      state.authError = 'Your profile could not be loaded. Tap Try again.';
    }
  }

  renderAccount();
  if (state.status !== 'loading') hooks.rerender();
  if (hadUser !== Boolean(state.user)) renderAccount();
}

/** Read-only view of the account check, used by tests and diagnostics. */
export function profileStatus() {
  return {
    status: state.status,
    error: state.authError,
    hasUser: Boolean(state.user),
    username: state.profile?.username || '',
    email: state.user?.email || '',
    inFlight: Boolean(profileRequest),
  };
}

/* ------------------------------ remote threads ---------------------------- */

/** True when this thread is backed by a Supabase conversation. */
export function isRemoteThread(thread) {
  return Boolean(thread && typeof thread.remoteId === 'string' && thread.remoteId);
}

function stopPolling() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.pollThreadId = null;
}

/**
 * Fetch and paint the messages of a server-backed conversation into `container`.
 * Re-entrant calls for the same thread simply refresh in place.
 */
export async function renderRemoteThread(thread, container) {
  if (!container || !isRemoteThread(thread)) return;

  const token = ++state.renderToken;
  const me = currentUser()?.id;

  if (container.dataset.remoteRendered !== thread.remoteId) {
    container.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'msg-thread__hint';
    loading.textContent = 'Loading messages…';
    container.append(loading);
  }

  let rows;
  try {
    rows = await listMessages(thread.remoteId);
  } catch (error) {
    if (token !== state.renderToken) return;
    container.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'msg-thread__hint dm-error';
    failed.textContent = describeError(error);
    container.append(failed);
    return;
  }

  if (token !== state.renderToken) return;

  container.replaceChildren();
  container.dataset.remoteRendered = thread.remoteId;

  if (!rows.length) {
    const hint = document.createElement('p');
    hint.className = 'msg-thread__hint';
    hint.textContent = 'No messages yet — say hello below.';
    container.append(hint);
    return;
  }

  let lastDay = '';
  for (const row of rows) {
    const label = dayLabel(row.created_at);
    if (label !== lastDay) {
      lastDay = label;
      const divider = document.createElement('div');
      divider.className = 'msg-daysep';
      divider.textContent = label;
      container.append(divider);
    }

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble msg-bubble--${row.sender_id === me ? 'out' : 'in'}`;

    const text = document.createElement('span');
    text.className = 'msg-bubble__text';
    // textContent, never innerHTML: a peer cannot inject markup.
    text.textContent = row.body;
    bubble.append(text);

    const meta = document.createElement('time');
    meta.className = 'msg-bubble__time';
    meta.textContent = clockLabel(row.created_at);
    meta.dateTime = new Date(row.created_at).toISOString();
    bubble.append(meta);

    container.append(bubble);
  }

  container.scrollTop = container.scrollHeight;
}

/** Send a message for a server-backed thread. Returns the stored row or null. */
export async function sendToRemoteThread(thread, text) {
  if (!isRemoteThread(thread)) return null;
  return sendRemoteMessageApi(thread.remoteId, text);
}

/**
 * Refresh an open remote thread every few seconds so incoming replies appear.
 * Safe to call repeatedly; only one timer lives at a time.
 */
export function startPolling(thread, container) {
  if (!isRemoteThread(thread)) {
    stopPolling();
    return;
  }
  if (state.pollThreadId === thread.remoteId && state.pollTimer) return;

  stopPolling();
  state.pollThreadId = thread.remoteId;

  const tick = async () => {
    state.pollTimer = null;
    if (state.pollThreadId !== thread.remoteId) return;
    if (typeof document !== 'undefined' && document.hidden) {
      state.pollTimer = setTimeout(tick, 15_000);
      return;
    }
    await renderRemoteThread(thread, container);
    if (state.pollThreadId === thread.remoteId) state.pollTimer = setTimeout(tick, 10_000);
  };

  state.pollTimer = setTimeout(tick, 10_000);
}

export function stopRemotePolling() {
  stopPolling();
}

/* --------------------------------- wiring -------------------------------- */

/** Wire the account panel once. `nextHooks.openRemoteThread(conversationId, person)`. */
export function initAccountUI(nextHooks = {}) {
  hooks = { ...hooks, ...nextHooks };

  el.account = document.getElementById('dmAccount');
  if (!el.account) return;

  el.signedOut = document.getElementById('dmSignedOut');
  el.email = document.getElementById('dmEmail');
  el.password = document.getElementById('dmPassword');
  el.signInBtn = document.getElementById('dmSignIn');
  el.signUpBtn = document.getElementById('dmSignUp');
  el.signedIn = document.getElementById('dmSignedIn');
  el.whoami = document.getElementById('dmWhoami');
  el.whoamiEmail = document.getElementById('dmWhoamiEmail');
  el.signOutBtn = document.getElementById('dmSignOut');
  el.usernameForm = document.getElementById('dmUsernameForm');
  el.usernameInput = document.getElementById('dmUsername');
  el.usernameSave = document.getElementById('dmUsernameSave');
  el.usernameHelp = document.getElementById('dmUsernameHelp');
  el.find = document.getElementById('dmFind');
  el.searchInput = document.getElementById('dmUserSearch');
  el.results = document.getElementById('dmResults');
  el.notice = document.getElementById('dmNotice');
  el.signupFields = document.getElementById('dmSignupFields');
  el.displayName = document.getElementById('dmDisplayName');
  el.usernameNew = document.getElementById('dmUsernameNew');
  el.signupHelp = document.getElementById('dmSignupHelp');

  if (state.ready) return;
  state.ready = true;

  el.signInBtn?.addEventListener('click', submitSignIn);
  el.signUpBtn?.addEventListener('click', submitSignUp);
  el.signOutBtn?.addEventListener('click', doSignOut);
  el.usernameForm?.addEventListener('submit', submitUsername);

  const findForm = document.getElementById('dmFindForm');
  findForm?.addEventListener('submit', submitSearch);

  el.password?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Enter follows whichever action the form is currently showing.
      if (state.signupOpen) submitSignUp();
      else submitSignIn();
    }
  });

  // Picking a username at signup uses exactly the rules the database enforces.
  el.usernameNew?.addEventListener('input', () => {
    if (!el.signupHelp) return;
    const check = validateUsername(el.usernameNew.value);
    if (!el.usernameNew.value.trim()) {
      el.signupHelp.textContent = '3–20 letters, numbers or _ — this is how people find you.';
      el.signupHelp.dataset.kind = '';
      return;
    }
    el.signupHelp.textContent = check.ok ? `You will be reachable as ${displayUsername(check.value)}` : check.error;
    el.signupHelp.dataset.kind = check.ok ? 'ok' : 'error';
  });

  el.usernameNew?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitSignUp();
    }
  });

  el.usernameInput?.addEventListener('input', () => {
    const check = validateUsername(el.usernameInput.value);
    if (!el.usernameHelp) return;
    if (!el.usernameInput.value.trim()) {
      el.usernameHelp.textContent = 'Pick a username so people can find you. 3–20 letters, numbers or _';
      el.usernameHelp.dataset.kind = '';
      return;
    }
    el.usernameHelp.textContent = check.ok ? `You will be reachable as ${displayUsername(check.value)}` : check.error;
    el.usernameHelp.dataset.kind = check.ok ? 'ok' : 'error';
  });

  bootstrap().catch(() => {});
}

/** Called by messages.js when the Messages section becomes visible. */
export function refreshAccount() {
  if (!state.ready && !state.profileReady) return;
  bootstrap().catch(() => {});
}

/* ------------------------- nav chip + profile dialog ---------------------- */

function openProfile() {
  if (!el.profileDialog) return;

  // Opening the dialog is the user's chance to recover from a check that never
  // finished (or never started). It only kicks a new request when nothing is in
  // flight, so tapping twice cannot duplicate the profile request.
  if (!profileRequest && (state.status === 'loading' || state.status === 'unknown')) {
    bootstrap().catch(() => {});
  }

  el.profileDialog.hidden = false;
  renderProfile();
  el.profileClose?.focus();
}

function closeProfile() {
  if (!el.profileDialog) return;
  el.profileDialog.hidden = true;
  el.navAccount?.focus();
}

/**
 * Wire the always-visible account chip and its profile dialog.
 *
 * Called once from app.js at page load — that is what makes the signed-in state
 * visible (and restored) without the user having to open Messages first.
 */
export function initProfileUI(nextHooks = {}) {
  hooks = { ...hooks, ...nextHooks };

  el.navAccount = document.getElementById('navAccount');
  el.navAvatar = document.getElementById('navAvatar');
  el.navAccountLabel = document.getElementById('navAccountLabel');
  el.profileDialog = document.getElementById('profileDialog');
  el.profileClose = document.getElementById('profileClose');
  el.profileAvatar = document.getElementById('profileAvatar');
  el.profileHandle = document.getElementById('profileHandle');
  el.profileMeta = document.getElementById('profileMeta');
  el.profileUsername = document.getElementById('profileUsername');
  el.profileEmail = document.getElementById('profileEmail');
  el.profileState = document.getElementById('profileState');
  el.profileActions = document.getElementById('profileActions');

  if (!el.navAccount) return;

  if (!state.profileReady) {
    state.profileReady = true;

    el.navAccount.addEventListener('click', openProfile);
    el.profileClose?.addEventListener('click', closeProfile);
    el.profileDialog?.addEventListener('click', (event) => {
      if (event.target === el.profileDialog || event.target.id === 'profileBackdrop') closeProfile();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && el.profileDialog && !el.profileDialog.hidden) closeProfile();
    });
  }

  // Paint the unknown state immediately, then validate any stored session.
  renderChip();
  renderProfile();
  bootstrap().catch(() => {});
}
