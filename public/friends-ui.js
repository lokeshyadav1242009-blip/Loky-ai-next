/**
 * LOKY AI Next — Friend Requests UI.
 *
 * Lives inside the existing Messages screen. It never touches the AI assistant,
 * the local conversation history or the Mini Chat thread view.
 *
 * The database decides everything (duplicates, self-requests, who may accept);
 * this module only paints the result and keeps the badge fresh.
 *
 * Row shape from public.my_friend_requests():
 *   request_id, direction, other_id, other_username, other_display_name,
 *   other_avatar_seed, status, note, created_at, responded_at
 */

import {
  listFriendRequests,
  listFriends,
  getFriendStatus,
  sendFriendRequest,
  respondToFriendRequest,
  cancelFriendRequest,
  friendErrorCode,
  currentUserId,
} from './friends-client.js';
import { closeLayer, openLayer } from './back-nav.js';
import {
  statusLabel,
  describeFriendError,
  groupRequests,
  pendingIncomingCount,
  friendButtonModel,
} from './friends-utils.js';

const POLL_MS = 7000;

const state = {
  incoming: [],
  outgoing: [],
  friends: [],
  notice: '',
  open: false,
  timer: null,
  inflight: null,
  busy: new Set(),
  hooks: {},
  lastSignature: '',
};

const el = {};

/* ------------------------------- small utils ------------------------------ */

function initialsFor(handle) {
  const clean = String(handle || '?').replace(/^@/, '').trim();
  if (!clean) return '?';
  const parts = clean.split(/[\s_.-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

function avatarColorFor(seed) {
  let hash = 0;
  const text = String(seed || 'loky');
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return `hsl(${hash} 62% 34%)`;
}

function handleOf(name) {
  const clean = String(name || '').trim();
  if (!clean) return '';
  return clean.startsWith('@') ? clean : `@${clean}`;
}

function setNotice(message, tone = 'info') {
  state.notice = message || '';
  if (!el.notice) return;
  el.notice.textContent = state.notice;
  el.notice.dataset.tone = tone;
  el.notice.hidden = !state.notice;
}

function personRow(person, { meta = '', actions = [] } = {}) {
  const li = document.createElement('li');
  li.className = 'friend-row';

  const avatar = document.createElement('span');
  avatar.className = 'msg-avatar msg-avatar--sm';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = initialsFor(person.username);
  avatar.style.background = avatarColorFor(person.avatar_seed || person.username);

  const main = document.createElement('span');
  main.className = 'friend-row__main';

  const name = document.createElement('span');
  name.className = 'friend-row__name';
  name.textContent = person.display_name || handleOf(person.username);

  const handle = document.createElement('span');
  handle.className = 'friend-row__handle';
  handle.textContent = handleOf(person.username);

  main.append(name, handle);
  if (meta) {
    const note = document.createElement('span');
    note.className = 'friend-row__meta';
    note.textContent = meta;
    main.append(note);
  }

  const actionWrap = document.createElement('span');
  actionWrap.className = 'friend-row__actions';
  actionWrap.append(...actions);

  li.append(avatar, main, actionWrap);
  return li;
}

function actionButton(label, { tone = 'ghost', onClick, key } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn btn--${tone} btn--sm friend-action`;
  button.textContent = label;
  if (key) button.dataset.action = key;
  button.addEventListener('click', async () => {
    if (state.busy.has(key)) return;
    state.busy.add(key);
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '…';
    try {
      await onClick();
    } finally {
      state.busy.delete(key);
      button.disabled = false;
      button.textContent = original;
    }
  });
  return button;
}

/* --------------------------------- badges --------------------------------- */

export function pendingCount() {
  return state.incoming.filter((r) => r.status === 'pending').length;
}

function updateBadges() {
  const count = pendingCount();
  const text = count > 99 ? '99+' : String(count);

  if (el.badge) {
    el.badge.textContent = text;
    el.badge.hidden = count === 0;
  }
  if (el.navBadge) {
    el.navBadge.textContent = text;
    el.navBadge.hidden = count === 0;
  }
  if (el.requestsButton) {
    el.requestsButton.dataset.count = count ? text : '';
    el.requestsButton.setAttribute(
      'aria-label',
      count ? `Friend requests, ${count} pending` : 'Friend requests'
    );
  }
  window.dispatchEvent(new CustomEvent('loky:friend-requests', { detail: { pending: count } }));
}

/* -------------------------------- rendering -------------------------------- */

function renderRequests() {
  if (!el.incoming || !el.outgoing) return;

  el.incoming.replaceChildren();
  el.outgoing.replaceChildren();
  el.friends?.replaceChildren();

  for (const request of state.incoming) {
    if (request.status !== 'pending') continue;
    const person = {
      id: request.other_id,
      username: request.other_username,
      display_name: request.other_display_name,
      avatar_seed: request.other_avatar_seed,
    };
    el.incoming.append(
      personRow(person, {
        meta: `Wants to be friends · ${statusLabel('pending')}`,
        actions: [
          actionButton('Accept', {
            tone: 'primary',
            key: `accept:${request.request_id}`,
            onClick: () => respond(request, 'accept'),
          }),
          actionButton('Reject', {
            tone: 'ghost',
            key: `reject:${request.request_id}`,
            onClick: () => respond(request, 'reject'),
          }),
        ],
      })
    );
  }

  for (const request of state.outgoing) {
    if (request.status !== 'pending') continue;
    const person = {
      id: request.other_id,
      username: request.other_username,
      display_name: request.other_display_name,
      avatar_seed: request.other_avatar_seed,
    };
    el.outgoing.append(
      personRow(person, {
        meta: `Request sent · ${statusLabel('pending')}`,
        actions: [
          actionButton('Cancel', {
            tone: 'ghost',
            key: `cancel:${request.request_id}`,
            onClick: () => cancel(request),
          }),
        ],
      })
    );
  }

  for (const friend of state.friends) {
    const person = {
      id: friend.user_id,
      username: friend.username,
      display_name: friend.display_name,
      avatar_seed: friend.avatar_seed,
    };
    el.friends?.append(
      personRow(person, {
        meta: statusLabel('accepted'),
        actions: [
          actionButton('Message', {
            tone: 'primary',
            key: `msg:${friend.user_id}`,
            onClick: () => state.hooks.openChatWith?.(person),
          }),
        ],
      })
    );
  }

  if (el.incomingEmpty) el.incomingEmpty.hidden = el.incoming.children.length > 0;
  if (el.outgoingEmpty) el.outgoingEmpty.hidden = el.outgoing.children.length > 0;
  if (el.friendsEmpty) el.friendsEmpty.hidden = (el.friends?.children.length || 0) > 0;
}

/* --------------------------------- actions -------------------------------- */

async function respond(request, decision) {
  setNotice('');
  const handle = handleOf(request.other_username);
  try {
    const result = await respondToFriendRequest(request.request_id, decision);
    state.incoming = state.incoming.filter((r) => r.request_id !== request.request_id);
    renderRequests();
    updateBadges();
    setNotice(
      result?.status === 'accepted'
        ? `You and ${handle} are now friends.`
        : `Request from ${handle} rejected.`,
      result?.status === 'accepted' ? 'ok' : 'info'
    );
    await refresh({ silent: true });
  } catch (error) {
    setNotice(describeFriendError(friendErrorCode(error)), 'error');
    await refresh({ silent: true });
  }
}

async function cancel(request) {
  setNotice('');
  const handle = handleOf(request.other_username);
  try {
    await cancelFriendRequest(request.request_id);
    state.outgoing = state.outgoing.filter((r) => r.request_id !== request.request_id);
    renderRequests();
    setNotice(`Request to ${handle} cancelled.`, 'info');
    await refresh({ silent: true });
  } catch (error) {
    setNotice(describeFriendError(friendErrorCode(error)), 'error');
    await refresh({ silent: true });
  }
}

/**
 * The add-friend control used by the Messages search results. It never adds
 * anyone directly: it sends a request, then shows the resulting status.
 */
export async function mountFriendAction(container, person, hooks = {}) {
  if (!container || !person || !person.id) return;
  const meId = currentUserId();
  if (!meId || person.id === meId) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--ghost btn--sm friend-action';
  button.textContent = 'Add friend';
  button.disabled = true;
  container.append(button);

  let status = 'none';
  try {
    status = await getFriendStatus(person.id);
  } catch {
    status = 'none';
  }
  paint(status);

  function paint(next) {
    status = next;
    const model = friendButtonModel(next);
    button.dataset.status = next;
    button.textContent = model.label;
    button.disabled = model.disabled || model.action === 'cancel';
    button.dataset.action = model.action || '';
  }

  button.addEventListener('click', async () => {
    if (button.disabled) return;

    if (status === 'friends') {
      hooks.onMessage?.();
      return;
    }
    if (status === 'pending_in') {
      openRequests();
      return;
    }

    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      await sendFriendRequest(person.id);
      paint('pending_out');
      setNotice(`Friend request sent to ${handleOf(person.username)}.`, 'ok');
      await refresh({ silent: true });
    } catch (error) {
      const code = friendErrorCode(error);
      if (code === 'request_pending') paint('pending_out');
      else if (code === 'already_friends') paint('friends');
      else {
        button.disabled = false;
        button.textContent = 'Add friend';
      }
      setNotice(describeFriendError(code), code === 'request_pending' ? 'info' : 'error');
    }
  });
}

/* --------------------------------- refresh -------------------------------- */

function signatureOf() {
  return [
    state.incoming.map((r) => `${r.request_id}:${r.status}`).join(','),
    state.outgoing.map((r) => `${r.request_id}:${r.status}`).join(','),
    state.friends.map((f) => f.user_id).join(','),
  ].join('|');
}

/**
 * Reload requests + friends. Concurrent calls share one request so a poll and a
 * user action can never race each other into a stale paint.
 */
export async function refresh({ silent = false } = {}) {
  if (!currentUserId()) {
    state.incoming = [];
    state.outgoing = [];
    state.friends = [];
    renderRequests();
    updateBadges();
    return;
  }
  if (state.inflight) return state.inflight;

  state.inflight = (async () => {
    if (el.refresh) el.refresh.disabled = true;
    try {
      const [requests, friends] = await Promise.all([listFriendRequests(), listFriends()]);
      const grouped = groupRequests(requests, currentUserId());
      state.incoming = grouped.incoming;
      state.outgoing = grouped.outgoing;
      state.friends = Array.isArray(friends) ? friends : [];

      const signature = signatureOf();
      if (signature !== state.lastSignature) {
        state.lastSignature = signature;
        renderRequests();
      }
      updateBadges();
    } catch (error) {
      if (!silent) setNotice(describeFriendError(friendErrorCode(error)), 'error');
    } finally {
      state.inflight = null;
      if (el.refresh) el.refresh.disabled = false;
    }
  })();

  return state.inflight;
}

function startPolling() {
  stopPolling();
  state.timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!currentUserId()) return;
    // Real-time-ish: a request accepted or rejected on another device lands here.
    refresh({ silent: true });
  }, POLL_MS);
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/* ---------------------------------- panel --------------------------------- */

export function openRequests() {
  openLayer('friend-requests', closeRequests);
  state.open = true;
  if (el.panel) el.panel.hidden = false;
  refresh();
}

export function closeRequests() {
  closeLayer('friend-requests');
  state.open = false;
  if (el.panel) el.panel.hidden = true;
}

export function toggleRequests() {
  if (state.open) closeRequests();
  else openRequests();
}

/* ---------------------------------- init ---------------------------------- */

export function initFriendsUI(hooks = {}) {
  state.hooks = hooks || {};

  el.requestsButton = document.getElementById('dmRequestsBtn');
  el.badge = document.getElementById('dmRequestsBadge');
  el.navBadge = document.getElementById('navMessagesBadge');
  el.panel = document.getElementById('dmRequests');
  el.incoming = document.getElementById('dmReqIncoming');
  el.outgoing = document.getElementById('dmReqOutgoing');
  el.friends = document.getElementById('dmReqFriends');
  el.incomingEmpty = document.getElementById('dmReqIncomingEmpty');
  el.outgoingEmpty = document.getElementById('dmReqOutgoingEmpty');
  el.friendsEmpty = document.getElementById('dmReqFriendsEmpty');
  el.notice = document.getElementById('dmReqNotice');
  el.refresh = document.getElementById('dmReqRefresh');
  el.close = document.getElementById('dmReqClose');

  el.requestsButton?.addEventListener('click', toggleRequests);
  el.close?.addEventListener('click', closeRequests);
  el.refresh?.addEventListener('click', () => refresh());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUserId()) refresh({ silent: true });
  });

  window.addEventListener('loky:auth-changed', (event) => {
    if (event?.detail?.signedIn) {
      startPolling();
      refresh({ silent: true });
      return;
    }
    stopPolling();
    state.incoming = [];
    state.outgoing = [];
    state.friends = [];
    state.lastSignature = '';
    renderRequests();
    updateBadges();
    closeRequests();
  });

  if (currentUserId()) {
    refresh({ silent: true });
    startPolling();
  }

  return { refresh, pendingCount, openRequests, closeRequests, pendingIncomingCount };
}
