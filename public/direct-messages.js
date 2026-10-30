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
  SupabaseError,
  currentUser,
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
  pollTimer: null,
  pollThreadId: null,
  renderToken: 0,
};

let hooks = { openRemoteThread: () => {}, rerender: () => {}, openMessages: () => {} };

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

function renderAccount() {
  const signedIn = Boolean(state.user);

  if (el.signedOut) el.signedOut.hidden = signedIn;
  if (el.find) el.find.hidden = !signedIn || !state.profile;
  if (el.signedIn) el.signedIn.hidden = !signedIn;

  if (!signedIn) {
    if (el.whoami) el.whoami.textContent = '';
    return;
  }

  if (el.whoami) {
    el.whoami.textContent = state.profile
      ? displayUsername(state.profile.username)
      : state.user.email || 'Signed in';
  }

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
    await bootstrap();
    setStatus(state.profile ? `Signed in as ${displayUsername(state.profile.username)}.` : 'Signed in. Now pick a username.', 'ok');
  } catch (error) {
    setStatus(describeError(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function submitSignUp() {
  const email = el.email?.value.trim() || '';
  const password = el.password?.value || '';
  if (!email || !password) {
    setStatus('Enter an email and a password (at least 6 characters).', 'error');
    return;
  }

  setBusy(true);
  setStatus('');
  try {
    const result = await apiSignUp(email, password);
    if (result.needsEmailConfirmation) {
      setStatus('Check your email to confirm the account, then sign in.', 'ok');
      if (el.password) el.password.value = '';
      return;
    }
    if (el.password) el.password.value = '';
    await bootstrap();
    setStatus('Account created. Now pick your username.', 'ok');
  } catch (error) {
    setStatus(describeError(error), 'error');
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
  stopPolling();
  renderAccount();
  renderResults();
  setStatus('Signed out.', 'info');
  hooks.rerender();
}

/* --------------------------------- bootstrap ------------------------------ */

/** Load (or reload) the session + profile and repaint the panel. */
export async function bootstrap() {
  state.user = currentUser();

  if (!state.user) {
    state.profile = null;
    renderAccount();
    return;
  }

  try {
    state.profile = await getMyProfile();
  } catch (error) {
    state.profile = null;
    setStatus(describeError(error), 'error');
  }
  renderAccount();
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
  el.signOutBtn = document.getElementById('dmSignOut');
  el.usernameForm = document.getElementById('dmUsernameForm');
  el.usernameInput = document.getElementById('dmUsername');
  el.usernameSave = document.getElementById('dmUsernameSave');
  el.usernameHelp = document.getElementById('dmUsernameHelp');
  el.find = document.getElementById('dmFind');
  el.searchInput = document.getElementById('dmUserSearch');
  el.results = document.getElementById('dmResults');
  el.notice = document.getElementById('dmNotice');

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
      submitSignIn();
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
  if (!state.ready) return;
  bootstrap().catch(() => {});
}
