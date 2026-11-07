/**
 * LOKY AI Next — Friend Requests UI.
 *
 * Lives inside the existing Messages screen. Nothing here touches the AI
 * assistant, the local conversation history or the Mini Chat thread view.
 *
 * The database decides everything (duplicate requests, self-requests, who may
 * accept). This module only paints the result and keeps the badge fresh.
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
import { statusLabel, describeFriendError } from './friends-utils.js';

const POLL_MS = 7000;

const state = {
  incoming: [],
  outgoing: [],
  friends: [],
  notice: '',
  noticeTone: 'info',
  loading: false,
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
  state.noticeTone = tone;
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

/* --------------------------------- counts --------------------------------- */

export function pendingCount() {
  return state.incoming.length;
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
  // Surface new requests to the rest of the app (e.g. the nav) without polling.
  window.dispatchEvent(
    new CustomEvent('loky:friend-requests', { detail: { pending: count } })
  );
}

/* -------------------------------- rendering -------------------------------- */

function renderRequests() {
  if (!el.incoming || !el.outgoing) return;

  el.incoming.replaceChildren();
  el.outgoing.replaceChildren();

  for (const request of state.incoming) {
    const sender = {
      id: request.requester_id,
      username: request.requester_username,
      display_name: request.requester_display_name,
      avatar_seed: request.requester_avatar_seed,
    };

    const accept = actionButton('Accept', {
      tone: 'primary',
      key: `accept:${request.id}`,
      onClick: () => respond(request, 'accepted'),
    });
    const reject = actionButton('Reject', {
      tone: 'ghost',
      key: `reject:${request.id}`,
      onClick: () => respond(request, 'rejected'),
    });

    el.incoming.append(
      personRow(sender, {
        meta: `Wants to be friends · ${statusLabel('pending')}`,
        actions: [accept, reject],
      })
    );
  }

  for (const request of state.outgoing) {
    const target = {
      id: request.recipient_id,
      username: request.recipient_username,
      display_name: request.recipient_display_name,
      avatar_seed: request.recipient_avatar_seed,
    };

    const cancel = actionButton('Cancel', {
      tone: 'ghost',
      key: `cancel:${request.id}`,
      onClick: () => cancel(request),
    });

    el.outgoing.append(
      personRow(target, {
        meta: `Request sent · ${statusLabel('pending')}`,
        actions: [cancel],
      })
    );
  }

  if (el.incomingEmpty) el.incomingEmpty.hidden = state.incoming.length > 0;
  if (el.outgoingEmpty) el.outgoingEmpty.hidden = state.outgoing.length > 0;
}

/* --------------------------------- actions -------------------------------- */

async function respond(request, decision) {
  setNotice('');
  try {
    await respondToFriendRequest(request.id, decision);
    state.incoming = state.incoming.filter((r) => r.id !== request.id);
    renderRequests();
    updateBadges();
    setNotice(
      decision === 'accepted'
        ? `You and ${handleOf(request.requester_username)} are now friends.`
        : `Request from ${handleOf(request.requester_username)} rejected.`,
      decision === 'accepted' ? 'ok' : 'info'
    );
    await refresh({ silent: true });
  } catch (error) {
    setNotice(describeFriendError(friendErrorCode(error)), 'error');
    await refresh({ silent: true });
  }
}

async function cancel(request) {
  setNotice('');
  try {
    await cancelFriendRequest(request.id);
    state.outgoing = state.outgoing.filter((r) => r.id !== request.id);
    renderRequests();
    setNotice(`Request to ${handleOf(request.recipient_username)} cancelled.`, 'info');
    await refresh({ silent: true });
  } catch (error) {
    setNotice(describeFriendError(friendErrorCode(error)), 'error');
    await refresh({ silent: true });
  }
}

/**
 * Add-friend control used by the Messages search results. It never adds anyone
 * directly: it sends a request and then shows the resulting status.
 */
export async function mountFriendAction(container, person) {
  if (!container || !person || !person.id) return;
  if (person.id === currentUserId()) return;

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
    status = 'unknown';
  }
  paint(status);

  function paint(next) {
    status = next;
    button.dataset.status = next;
    button.disabled = next === 'pending' || next === 'accepted' || next === 'unknown';
    if (next === 'accepted') button.textContent = 'Friends';
    else if (next === 'pending') button.textContent = 'Request sent';
    else if (next === 'incoming') button.textContent = 'Respond in requests';
    else if (next === 'unknown') button.textContent = 'Add friend';
    else button.textContent = 'Add friend';
  }

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      const result = await sendFriendRequest(person.id);
      paint(result === 'accepted' ? 'accepted' : 'pending');
      setNotice(`Friend request sent to ${handleOf(person.username)}.`, 'ok');
      await refresh({ silent: true });
    } catch (error) {
      const code = friendErrorCode(error);
      if (code === 'request_pending') paint('pending');
      else if (code === 'already_friends') paint('accepted');
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
    state.incoming.map((r) => r.id).join(','),
    state.outgoing.map((r) => r.id).join(','),
    state.friends.map((f) => f.id).join(','),
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
    if (!silent) {
      state.loading = true;
      if (el.refresh) el.refresh.disabled = true;
    }
    try {
      const [requests, friends] = await Promise.all([listFriendRequests(), listFriends()]);
      const incoming = Array.isArray(requests?.incoming) ? requests.incoming : [];
      const outgoing = Array.isArray(requests?.outgoing) ? requests.outgoing : [];
      const friendList = Array.isArray(friends) ? friends : [];

      const changed =
        incoming.length !== state.incoming.length ||
        outgoing.length !== state.outgoing.length ||
        friendList.length !== state.friends.length;

      state.incoming = incoming;
      state.outgoing = outgoing;
      state.friends = friendList;

      const signature = signatureOf();
      if (signature !== state.lastSignature) {
        state.lastSignature = signature;
        renderRequests();
      }
      updateBadges();

      // Someone accepted or rejected while this tab was open.
      if (changed && state.open) {
        const accepted = friendList.length > 0 && state.notice === '';
        if (accepted) setNotice('Friend list updated.', 'info');
      }
    } catch (error) {
      const code = friendErrorCode(error);
      if (!silent) setNotice(describeFriendError(code), 'error');
    } finally {
      state.inflight = null;
      state.loading = false;
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
    refresh({ silent: true });
  }, POLL_MS);
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/* ---------------------------------- panel --------------------------------- */

export function openRequests() {
  state.open = true;
  if (el.panel) el.panel.hidden = false;
  refresh();
}

export function closeRequests() {
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
  el.incomingEmpty = document.getElementById('dmReqIncomingEmpty');
  el.outgoingEmpty = document.getElementById('dmReqOutgoingEmpty');
  el.notice = document.getElementById('dmReqNotice');
  el.refresh = document.getElementById('dmReqRefresh');
  el.close = document.getElementById('dmReqClose');

  if (el.requestsButton) el.requestsButton.addEventListener('click', toggleRequests);
  if (el.close) el.close.addEventListener('click', closeRequests);
  if (el.refresh) el.refresh.addEventListener('click', () => refresh());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUserId()) refresh({ silent: true });
  });

  window.addEventListener('loky:auth-changed', (event) => {
    const signedIn = event?.detail?.signedIn;
    if (signedIn) {
      startPolling();
      refresh({ silent: true });
    } else {
      stopPolling();
      state.incoming = [];
      state.outgoing = [];
      state.friends = [];
      state.lastSignature = '';
      renderRequests();
      updateBadges();
      closeRequests();
    }
  });

  if (currentUserId()) {
    refresh({ silent: true });
    startPolling();
  }

  return { refresh, pendingCount, openRequests, closeRequests };
}
