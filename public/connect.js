/**
 * LOKY CONNECT — social messaging surface.
 *
 * All data comes from authenticated Supabase RPCs (see supabase-client.js).
 * There is no demo data and no localStorage message store: if a row is on
 * screen it came from the database for the signed-in user.
 *
 * Degradation is explicit. When migration 0003 has not been applied, the pane
 * says so and falls back to the read-only conversation list from 0001 rather
 * than pretending media, reactions or receipts work.
 */

import {
  currentUser,
  getMyProfile,
  searchUsers,
  startConversation,
  listConversations,
  friends,
  friendRequests,
  sendFriendRequest,
  respondFriendRequest,
  cancelFriendRequest,
  friendStatus,
  touchLastSeen,
  connectThreads,
  connectMessages,
  connectSend,
  connectMarkRead,
  connectReact,
  connectUnreact,
  connectDeleteMessage,
  connectSetTyping,
  connectTypingStatus,
  connectSetProfile,
  connectNotifications,
  connectMarkNotificationsRead,
  uploadConnectMedia,
  signedConnectMediaUrl,
} from './supabase-client.js';

import {
  removeFriend,
  blockUser,
  unblockUser,
  listBlockedUsers,
  friendErrorCode,
} from './friends-client.js';

import {
  friendMenuModel,
  removeFriendConfirmText,
  blockUserConfirmText,
  withoutPerson,
  blockedListModel,
  describeFriendError,
} from './friends-utils.js';

import {
  normalizeSearchTerm,
  isSearchable,
  describeSearchState,
  friendStateLabel,
  excludeSelf,
} from './search-utils.js';

import {
  buildContacts,
  contactKindLabel,
  contactSummary,
  isFriendContact,
} from './social-contacts.js';

import {
  CONNECT_TABS,
  REACTIONS,
  normalizeTab,
  validateAttachment,
  initials,
  avatarHue,
  unreadLabel,
  previewText,
  clockLabel,
  dayLabel,
  listTime,
  presenceLabel,
  groupReactions,
  sortThreads,
  filterThreads,
  totalUnread,
  pendingIncoming,
  splitPendingRequests,
  notificationText,
  draftIsSendable,
  buildSendPayload,
  friendAction,
} from './connect-model.js';

import { openLayer, closeLayer } from './back-nav.js';
import { threadMenuModel, threadBlockedNotice, isPersonBlocked } from './connect-model.js';
import { unblockConfirmText } from './friends-utils.js';

const TAB_CHATS = CONNECT_TABS[0].id;
const TAB_FRIENDS = CONNECT_TABS[1].id;
const TAB_REQUESTS = CONNECT_TABS[2].id;
const TAB_DISCOVER = CONNECT_TABS[3].id;

const POLL_THREADS_MS = 15000;
const POLL_THREAD_MS = 4000;
const TYPING_THROTTLE_MS = 1200;

const state = {
  built: false,
  open: false,
  tab: TAB_CHATS,
  me: null,
  profile: null,
  threads: [],
  friendRows: [],
  requestRows: [],
  notifications: [],
  results: [],
  search: '',
  searchTerm: '',
  searching: false,
  searchError: '',
  active: null,
  messages: [],
  attachment: null,
  replyTo: null,
  busy: false,
  threadsTimer: null,
  threadTimer: null,
  avatarCache: new Map(),
  mediaCache: new Map(),
  lastTypingAt: 0,
  friendsLoading: false,
  friendsError: '',
  friendsInflight: null,
  blocked: [],
  blockedError: '',
};

const dom = {};

/* --------------------------------- helpers -------------------------------- */

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function avatarNode(name, seed, urlOrPath, size) {
  const node = h('span', `connect-avatar${size ? ` connect-avatar--${size}` : ''}`);
  node.style.setProperty('--hue', String(avatarHue(seed || name)));

  const resolved = urlOrPath ? resolveAvatarSync(urlOrPath) : null;
  if (resolved) {
    const img = document.createElement('img');
    img.src = resolved;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove());
    node.append(img);
  } else {
    node.textContent = initials(name);
    if (urlOrPath) queueAvatarResolve(urlOrPath);
  }
  return node;
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function resolveAvatarSync(pathOrUrl) {
  if (!pathOrUrl) return null;
  if (isHttpUrl(pathOrUrl)) return pathOrUrl;
  return state.avatarCache.get(pathOrUrl) || null;
}

function queueAvatarResolve(pathOrUrl) {
  if (!pathOrUrl || isHttpUrl(pathOrUrl) || state.avatarCache.has(pathOrUrl)) return;
  state.avatarCache.set(pathOrUrl, null); // claim it so we resolve once
  signedConnectMediaUrl(pathOrUrl)
    .then((url) => {
      if (!url) return;
      state.avatarCache.set(pathOrUrl, url);
      scheduleAvatarRepaint();
    })
    .catch(() => {});
}

let avatarRepaintTimer = null;
function scheduleAvatarRepaint() {
  if (avatarRepaintTimer) return;
  avatarRepaintTimer = setTimeout(() => {
    avatarRepaintTimer = null;
    repaintActive();
  }, 60);
}

function repaintActive() {
  if (!state.built) return;
  if (state.active && !dom.thread.hidden) renderMessages();
  else if (state.tab === TAB_CHATS) renderThreads();
  else if (state.tab === TAB_FRIENDS) renderFriends();
  else if (state.tab === TAB_REQUESTS) renderRequests();
  else renderResults();
  renderMeAvatar();
}

function say(message, kind) {
  if (!dom.notice) return;
  dom.notice.textContent = message || '';
  dom.notice.dataset.kind = kind || 'info';
  dom.notice.hidden = !message;
  if (dom.noticeTimer) clearTimeout(dom.noticeTimer);
  dom.noticeTimer = message ? setTimeout(() => { dom.notice.hidden = true; }, 7000) : null;
}

/* ---------------------------------- build --------------------------------- */

function build() {
  if (state.built) return;
  const section = dom.section;

  const header = h('header', 'connect__top');
  const brand = h('div', 'connect__brand');
  brand.append(h('span', 'connect__mark', 'LC'));
  const titleWrap = h('div');
  titleWrap.append(h('h1', 'connect__title', 'LOKY CONNECT'));
  dom.subtitle = h('p', 'connect__subtitle', 'Chats');
  titleWrap.append(dom.subtitle);
  brand.append(titleWrap);

  const tools = h('div', 'connect__tools');
  dom.notifBtn = h('button', 'connect-icon');
  dom.notifBtn.type = 'button';
  dom.notifBtn.setAttribute('aria-label', 'Notifications');
  dom.notifBtn.append(document.createTextNode('🔔'));
  dom.notifBadge = h('span', 'connect-icon__badge');
  dom.notifBadge.hidden = true;
  dom.notifBtn.append(dom.notifBadge);
  dom.notifBtn.addEventListener('click', openNotifications);

  dom.profileBtn = h('button', 'connect-icon connect-icon--avatar');
  dom.profileBtn.type = 'button';
  dom.profileBtn.setAttribute('aria-label', 'Your profile');
  dom.profileAvatar = avatarNode('?', 'me', null, 'sm');
  dom.profileBtn.append(dom.profileAvatar);
  dom.profileBtn.addEventListener('click', openProfile);

  tools.append(dom.notifBtn, dom.profileBtn);
  header.append(brand, tools);

  const tabs = h('nav', 'connect__tabs');
  tabs.setAttribute('role', 'tablist');
  dom.tabButtons = new Map();
  for (const tab of CONNECT_TABS) {
    const btn = h('button', 'connect-tab', tab.label);
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => setTab(tab.id));
    dom.tabButtons.set(tab.id, btn);
    tabs.append(btn);
  }

  dom.notice = h('p', 'connect__notice');
  dom.notice.hidden = true;
  dom.notice.setAttribute('role', 'status');
  dom.notice.setAttribute('aria-live', 'polite');

  dom.panes = h('div', 'connect__panes');
  dom.pane = new Map();
  for (const tab of CONNECT_TABS) {
    const pane = h('section', 'connect-pane');
    dom.pane.set(tab.id, pane);
    dom.panes.append(pane);
  }
  buildChatsPane(dom.pane.get(TAB_CHATS));
  buildFriendsPane(dom.pane.get(TAB_FRIENDS));
  buildRequestsPane(dom.pane.get(TAB_REQUESTS));
  buildDiscoverPane(dom.pane.get(TAB_DISCOVER));

  dom.thread = buildThread();
  dom.sheet = h('div', 'connect-sheet');
  dom.sheet.hidden = true;
  dom.sheetPanel = h('div', 'connect-sheet__panel');
  dom.sheet.append(dom.sheetPanel);

  section.append(header, tabs, dom.notice, dom.panes, dom.thread, dom.sheet);
  // Any click outside an open three-dot menu closes it.
  document.addEventListener('click', closeMenus);
  state.built = true;
  setTab(state.tab);
}

function buildChatsPane(pane) {
  const search = h('div', 'connect-search');
  dom.chatSearch = h('input', 'connect-search__input');
  dom.chatSearch.type = 'search';
  dom.chatSearch.placeholder = 'Search chats';
  dom.chatSearch.setAttribute('aria-label', 'Search chats');
  dom.chatSearch.addEventListener('input', () => {
    state.search = dom.chatSearch.value;
    renderThreads();
  });
  search.append(dom.chatSearch);

  dom.chatList = h('ul', 'connect-list');
  dom.chatEmpty = h('p', 'connect-empty', 'No chats yet. Find someone in Discover and start talking.');
  pane.append(search, dom.chatList, dom.chatEmpty);
}

function buildFriendsPane(pane) {
  pane.append(h('h2', 'connect-pane__title', 'Friends'));
  dom.friendSummary = h('p', 'connect-pane__sub', 'Friends and chat contacts appear here.');
  pane.append(dom.friendSummary);
  dom.friendList = h('ul', 'connect-list');
  dom.friendEmpty = h('p', 'connect-empty', 'No friends yet.');
  pane.append(dom.friendList, dom.friendEmpty);

  dom.blockedSection = h('section', 'connect-blocked');
  dom.blockedSection.append(h('h3', 'connect-group', 'Blocked users'));
  dom.blockedList = h('ul', 'connect-list');
  dom.blockedEmpty = h('p', 'connect-empty', 'You have not blocked anyone.');
  dom.blockedSection.append(dom.blockedList, dom.blockedEmpty);
  pane.append(dom.blockedSection);
}

function buildRequestsPane(pane) {
  pane.append(h('h2', 'connect-pane__title', 'Requests'));
  pane.append(h('h3', 'connect-group', 'Incoming'));
  dom.reqIncoming = h('ul', 'connect-list');
  dom.reqIncomingEmpty = h('p', 'connect-empty', 'No incoming requests.');
  pane.append(dom.reqIncoming, dom.reqIncomingEmpty);
  pane.append(h('h3', 'connect-group', 'Sent'));
  dom.reqOutgoing = h('ul', 'connect-list');
  dom.reqOutgoingEmpty = h('p', 'connect-empty', 'No sent requests.');
  pane.append(dom.reqOutgoing, dom.reqOutgoingEmpty);
}

function buildDiscoverPane(pane) {
  pane.append(h('h2', 'connect-pane__title', 'Discover people'));
  const form = h('form', 'connect-search');
  dom.discoInput = h('input', 'connect-search__input');
  dom.discoInput.type = 'text';
  dom.discoInput.maxLength = 20;
  dom.discoInput.placeholder = 'Search by username';
  dom.discoInput.setAttribute('aria-label', 'Search people by username');
  const go = h('button', 'connect-search__go', 'Search');
  go.type = 'submit';
  form.append(dom.discoInput, go);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch();
  });

  dom.discoList = h('ul', 'connect-list');
  dom.discoEmpty = h('p', 'connect-empty', 'Search a username to find people.');
  pane.append(form, dom.discoList, dom.discoEmpty);
}

function buildThread() {
  const wrap = h('section', 'connect-thread');
  wrap.hidden = true;

  const top = h('header', 'connect-thread__top');
  // Back to the chat list. The arrow is always present and the label appears
  // from 720px up, because an unlabelled 36px arrow was the only way out of a
  // conversation on a desktop browser.
  dom.backBtn = h('button', 'connect-icon connect-icon--back');
  dom.backBtn.type = 'button';
  dom.backBtn.setAttribute('aria-label', 'Back to chats');
  dom.backBtn.append(
    h('span', 'connect-back__arrow', '←'),
    h('span', 'connect-back__label', 'Back to chats')
  );
  dom.backBtn.addEventListener('click', () => closeThread());

  dom.threadAvatar = avatarNode('?', 'thread', null, 'sm');
  const who = h('div', 'connect-thread__who');
  dom.threadName = h('strong', 'connect-thread__name', 'Chat');
  dom.threadPresence = h('small', 'connect-thread__presence', '');
  who.append(dom.threadName, dom.threadPresence);

  // Header menu (View profile / Remove friend / Block / Unblock). Filled by
  // renderThreadHead() because the available actions depend on the
  // relationship with this specific peer.
  dom.threadMore = h('div', 'connect-friend__more connect-thread__more');
  top.append(dom.backBtn, dom.threadAvatar, who, dom.threadMore);

  dom.scroll = h('div', 'connect-thread__scroll');

  dom.typing = h('p', 'connect-typing', 'typing…');
  dom.typing.hidden = true;

  dom.attachPreview = h('div', 'connect-attach');
  dom.attachPreview.hidden = true;

  const form = h('form', 'connect-composer');
  dom.attachBtn = h('button', 'connect-icon', '📎');
  dom.attachBtn.type = 'button';
  dom.attachBtn.setAttribute('aria-label', 'Attach photo or video');
  dom.attachBtn.addEventListener('click', () => dom.fileInput.click());

  dom.fileInput = h('input', 'connect-file');
  dom.fileInput.type = 'file';
  dom.fileInput.accept = 'image/*,video/*';
  dom.fileInput.hidden = true;
  dom.fileInput.addEventListener('change', onPickFile);

  dom.input = h('textarea', 'connect-composer__input');
  dom.input.rows = 1;
  dom.input.placeholder = 'Message…';
  dom.input.setAttribute('aria-label', 'Message');
  dom.input.addEventListener('input', onType);
  dom.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  dom.sendBtn = h('button', 'connect-send', '➤');
  dom.sendBtn.type = 'submit';
  dom.sendBtn.setAttribute('aria-label', 'Send message');

  form.append(dom.attachBtn, dom.fileInput, dom.input, dom.sendBtn);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  wrap.append(top, dom.scroll, dom.typing, dom.attachPreview, form);
  return wrap;
}

/* -------------------------------- rendering ------------------------------- */

/** Highlights the conversation currently open in the thread pane. */
function markActiveChat(li) {
  if (!dom.chatList) return;
  for (const row of dom.chatList.querySelectorAll('.connect-chat--active')) {
    row.classList.remove('connect-chat--active');
  }
  if (li) li.classList.add('connect-chat--active');
}

/* --------------------------- conversation header -------------------------- */

/**
 * Paints the conversation header menu, the blocked banner and the composer.
 *
 * Blocking is enforced in the database (BEFORE INSERT triggers raise
 * 'user_blocked'); this only mirrors that state so the user sees why a chat is
 * read-only instead of typing a message that cannot be delivered.
 */
function renderThreadHead() {
  if (!dom.threadMore || !state.active) return;

  // Created on first use so buildThread() stays unaware of the banner.
  if (!dom.threadBlocked) {
    dom.threadBlocked = h('div', 'connect-thread__blocked');
    dom.threadBlocked.hidden = true;
    dom.scroll.before(dom.threadBlocked);
  }

  const peerId = state.active.peerId || null;
  const isBlocked = isPersonBlocked(state.blocked, peerId);
  state.active.blocked = isBlocked;

  const friendRow = peerId
    ? state.friendRows.find((row) => row && row.user_id === peerId) || null
    : null;

  clear(dom.threadMore);
  const menu = threadMenuModel({
    isFriend: Boolean(friendRow),
    isBlocked,
    isSelf: Boolean(peerId && state.me && peerId === state.me.id),
  });

  if (menu.visible) {
    const toggle = h('button', 'connect-friend__dots', '⋮');
    toggle.type = 'button';
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', `Manage ${state.active.username || 'this chat'}`);

    const panel = h('div', 'connect-friend__menu');
    panel.setAttribute('role', 'menu');
    panel.hidden = true;

    for (const item of menu.items) {
      const action = h(
        'button',
        `connect-friend__item${item.danger ? ' connect-friend__item--danger' : ''}`,
        item.label
      );
      action.type = 'button';
      action.setAttribute('role', 'menuitem');
      action.addEventListener('click', async (event) => {
        event.stopPropagation();
        closeMenus();
        const target = friendRow || { user_id: peerId, username: state.active.username };
        if (item.id === 'profile') openPeerProfile();
        else if (item.id === 'remove') await runRemoveFriend(target, action);
        else if (item.id === 'block') await runBlockUser(target, action);
        else if (item.id === 'unblock') {
          await runUnblock({ id: peerId, username: state.active.username }, action);
        }
        renderThreadHead();
      });
      panel.append(action);
    }

    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const wasHidden = panel.hidden;
      closeMenus();
      panel.hidden = !wasHidden;
      toggle.setAttribute('aria-expanded', String(wasHidden));
    });

    dom.threadMore.append(toggle, panel);
  }

  clear(dom.threadBlocked);
  dom.threadBlocked.hidden = !isBlocked;
  if (isBlocked) {
    dom.threadBlocked.append(
      h('span', 'connect-thread__blocked-text', threadBlockedNotice(state.active.username))
    );
    const unblock = h('button', 'connect-btn', 'Unblock');
    unblock.type = 'button';
    unblock.addEventListener('click', async () => {
      await runUnblock({ id: peerId, username: state.active.username }, unblock);
      renderThreadHead();
    });
    dom.threadBlocked.append(unblock);
  }

  dom.input.disabled = isBlocked;
  dom.sendBtn.disabled = isBlocked;
  dom.attachBtn.disabled = isBlocked;
}

/** Read-only profile card for the conversation peer. No email, no private data. */
function openPeerProfile() {
  const active = state.active;
  if (!active) return;
  const peerId = active.peerId || null;
  const isBlocked = isPersonBlocked(state.blocked, peerId);
  const friendRow = peerId
    ? state.friendRows.find((row) => row && row.user_id === peerId) || null
    : null;

  const head = h('div', 'connect-profile__head');
  head.append(avatarNode(active.name, active.username, active.avatar, 'lg'));
  const who = h('div');
  who.append(h('strong', null, active.name || 'Profile'));
  who.append(
    h('span', 'connect-profile__username', active.username ? `@${active.username}` : 'No username')
  );
  head.append(who);

  const relation = isBlocked ? 'Blocked' : friendRow ? 'Friend' : 'Chat contact';
  openSheet('Profile', [head, h('p', 'connect-empty', `Relationship: ${relation}`)]);
}

function renderThreads() {
  if (!dom.chatList) return;
  clear(dom.chatList);
  const rows = filterThreads(sortThreads(state.threads), state.search);
  dom.chatEmpty.hidden = rows.length > 0;
  dom.chatEmpty.textContent = state.search
    ? 'No chats match that search.'
    : 'No chats yet. Find someone in Discover and start talking.';

  const activeId = state.active && state.active.id;
  for (const row of rows) {
    const li = h('li', 'connect-chat');
    if (activeId && row.conversation_id === activeId) li.classList.add('connect-chat--active');
    const btn = h('button', 'connect-chat__btn');
    btn.type = 'button';
    btn.append(avatarNode(row.peer_username, row.peer_username, row.peer_avatar_url, 'md'));

    const body = h('div', 'connect-chat__body');
    body.append(h('strong', 'connect-chat__name', row.peer_display_name || (row.peer_username ? `@${row.peer_username}` : 'Unknown')));
    const preview = previewText({ body: row.last_body, media_type: row.last_media_type });
    const mine = state.me && row.last_sender_id === state.me.id;
    body.append(h('span', 'connect-chat__preview', mine ? `You: ${preview}` : preview));

    const meta = h('div', 'connect-chat__meta');
    meta.append(h('time', 'connect-chat__time', listTime(row.last_at)));
    const badge = unreadLabel(row.unread_count);
    if (badge) meta.append(h('span', 'connect-badge', badge));

    btn.append(body, meta);
    btn.addEventListener('click', () => {
      markActiveChat(li);
      openThread(row);
    });
    li.append(btn);
    dom.chatList.append(li);
  }

  renderBadges();
}

function renderBadges() {
  const unread = totalUnread(state.threads);
  const pending = pendingIncoming(state.requestRows);
  const notif = state.notifications.filter((n) => !n.read_at).length;

  if (dom.notifBadge) {
    dom.notifBadge.textContent = unreadLabel(notif);
    dom.notifBadge.hidden = notif === 0;
  }

  const navBadge = document.getElementById('navMessagesBadge');
  if (navBadge) {
    navBadge.textContent = unreadLabel(unread);
    navBadge.hidden = unread === 0;
  }
  const reqBadge = document.getElementById('dmRequestsBadge');
  if (reqBadge) {
    reqBadge.textContent = unreadLabel(pending);
    reqBadge.hidden = pending === 0;
  }
}

function renderFriends() {
  if (!dom.friendList) return;
  clear(dom.friendList);

  // Everybody you can talk to, not just accepted friendships: a chat contact
  // shows up here too, labelled so the two are never confused.
  const contacts = buildContacts({
    friends: state.friendRows,
    threads: state.threads,
    meId: state.me && state.me.id,
  });
  const loading = state.friendsLoading;
  const error = state.friendsError;
  const empty = !loading && !error && contacts.length === 0;

  // The empty state must never claim "no friends" when the load actually
  // failed: that is what made a failed RPC look like an empty Friends list.
  dom.friendEmpty.hidden = !(loading || Boolean(error) || empty);

  if (loading) {
    dom.friendEmpty.textContent = 'Loading your contacts…';
  } else if (error) {
    dom.friendEmpty.textContent = `${describeFriendError(error)} Your friends could not be loaded.`;
  } else if (empty) {
    dom.friendEmpty.textContent =
      'Nobody here yet. Search a username in Discover to send a friend request, or start a chat and the person will appear here as a chat contact.';
  }

  if (error) {
    const retry = h('button', 'connect-btn connect-btn--primary', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      refreshFriendRows();
      refreshBlocked();
    });
    dom.friendEmpty.append(document.createElement('br'), retry);
  }

  for (const contact of contacts) dom.friendList.append(friendRow(contact));
  if (dom.friendSummary) {
    dom.friendSummary.textContent = contacts.length
      ? contactSummary(contacts)
      : 'Friends and chat contacts appear here.';
  }

  renderBlocked();
}

function friendRow(contact) {
  const li = h('li', 'connect-friend');

  const btn = h('button', 'connect-friend__btn');
  btn.type = 'button';
  btn.append(avatarNode(contact.username, contact.username, contact.avatarSeed, 'md'));

  const body = h('div', 'connect-friend__body');
  const head = h('div', 'connect-friend__head');
  head.append(h('strong', 'connect-friend__name', contact.displayName || `@${contact.username}`));
  head.append(h('span', `connect-tag connect-tag--${contact.kind}`, contactKindLabel(contact.kind)));
  body.append(head);
  body.append(
    h(
      'span',
      'connect-friend__meta',
      isFriendContact(contact) ? `@${contact.username}` : `@${contact.username} · chat only`
    )
  );
  btn.append(body, h('span', 'connect-friend__cta', 'Message'));

  // A friend is messaged through start_conversation; a chat contact opens the
  // conversation it already has instead of creating a second one.
  btn.addEventListener('click', () => {
    if (contact.conversationId) {
      openThread(
        contact.threadRow || {
          conversation_id: contact.conversationId,
          peer_username: contact.username,
          peer_display_name: contact.displayName,
        }
      );
      return;
    }
    startChatWith({
      id: contact.userId,
      username: contact.username,
      display_name: contact.displayName,
      avatar_seed: contact.avatarSeed,
    });
  });

  const wrap = h('div', 'connect-friend__more');
  // Remove/Block only make sense for an accepted friendship.
  const menu = isFriendContact(contact) ? friendMenuModel('friends') : { visible: false, items: [] };
  if (menu.visible) {
    const toggle = h('button', 'connect-friend__dots', '⋮');
    toggle.type = 'button';
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', `Manage ${contact.username}`);

    const panel = h('div', 'connect-friend__menu');
    panel.setAttribute('role', 'menu');
    panel.hidden = true;

    for (const item of menu.items) {
      const action = h(
        'button',
        `connect-friend__item${item.danger ? ' connect-friend__item--danger' : ''}`,
        item.label
      );
      action.type = 'button';
      action.setAttribute('role', 'menuitem');
      action.addEventListener('click', (event) => {
        event.stopPropagation();
        closeMenus();
        if (item.id === 'remove') runRemoveFriend(contact.friendRow, action);
        else if (item.id === 'block') runBlockUser(contact.friendRow, action);
      });
      panel.append(action);
    }

    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const wasHidden = panel.hidden;
      closeMenus();
      panel.hidden = !wasHidden;
      toggle.setAttribute('aria-expanded', String(wasHidden));
    });

    wrap.append(toggle, panel);
  }

  li.append(btn, wrap);
  return li;
}

function renderBlocked() {
  if (!dom.blockedSection) return;
  const rows = Array.isArray(state.blocked) ? state.blocked : [];
  clear(dom.blockedList);
  dom.blockedSection.hidden = rows.length === 0 && !state.blockedError;
  dom.blockedEmpty.hidden = rows.length > 0;
  dom.blockedEmpty.textContent = state.blockedError
    ? describeFriendError(state.blockedError)
    : 'You have not blocked anyone.';

  for (const person of rows) {
    const li = h('li', 'connect-friend connect-friend--blocked');
    li.append(avatarNode(person.username, person.username, person.avatar_seed, 'md'));
    const body = h('div', 'connect-friend__body');
    body.append(h('strong', 'connect-friend__name', person.display_name || `@${person.username}`));
    body.append(h('span', 'connect-friend__meta', `@${person.username}`));
    const btn = h('button', 'connect-btn', 'Unblock');
    btn.type = 'button';
    btn.addEventListener('click', () => runUnblock(person, btn));
    li.append(body, btn);
    dom.blockedList.append(li);
  }
}

const isIncoming = (row) => Boolean(row) && (row.direction === 'incoming' || row.direction === 'in');
const isOutgoing = (row) => Boolean(row) && (row.direction === 'outgoing' || row.direction === 'out');

function renderRequests() {
  if (!dom.reqIncoming) return;
  // my_friend_requests() reports 'incoming'/'outgoing'; the short forms are
  // tolerated so a changed payload can never silently empty this tab.
  // It also returns every status, so only still-pending rows may be listed:
  // accepted/declined/cancelled requests would otherwise stay on screen.
  const { incoming, outgoing } = splitPendingRequests(state.requestRows);

  clear(dom.reqIncoming);
  dom.reqIncomingEmpty.hidden = incoming.length > 0;
  for (const req of incoming) {
    dom.reqIncoming.append(requestRow(req, [
      { label: 'Accept', cls: 'connect-btn connect-btn--primary', run: (b) => respond(req, 'accepted', b) },
      { label: 'Decline', cls: 'connect-btn', run: (b) => respond(req, 'rejected', b) },
    ]));
  }

  clear(dom.reqOutgoing);
  dom.reqOutgoingEmpty.hidden = outgoing.length > 0;
  for (const req of outgoing) {
    dom.reqOutgoing.append(requestRow(req, [
      { label: 'Cancel', cls: 'connect-btn connect-btn--danger', run: (b) => cancelRequest(req, b) },
    ]));
  }

  renderBadges();
}

function requestRow(req, actions) {
  const li = h('li', 'connect-req');
  const body = h('div', 'connect-req__body');
  body.append(avatarNode(req.other_username, req.other_username, req.other_avatar_seed, 'sm'));
  const text = h('div', 'connect-req__text');
  text.append(h('strong', null, req.other_display_name || `@${req.other_username}`));
  const statusText = isIncoming(req) ? 'wants to connect' : 'Request Sent';
  text.append(h('span', 'connect-req__note', req.note ? `${statusText} · ${req.note}` : statusText));
  body.append(text);

  const wrap = h('div', 'connect-req__actions');
  for (const action of actions) {
    const btn = h('button', action.cls, action.label);
    btn.type = 'button';
    btn.addEventListener('click', () => action.run(btn));
    wrap.append(btn);
  }

  li.append(body, wrap);
  return li;
}

function renderResults() {
  if (!dom.discoList) return;
  clear(dom.discoList);
  const view = describeSearchState({
    term: state.searchTerm,
    count: state.results.length,
    searching: state.searching,
    error: state.searchError,
  });
  dom.discoEmpty.hidden = view.kind === 'results';
  dom.discoEmpty.textContent = view.message;

  for (const person of state.results) {
    const li = h('li', 'connect-result');
    const body = h('div', 'connect-req__body');
    body.append(avatarNode(person.username, person.username, person.avatar_seed, 'md'));
    const text = h('div', 'connect-req__text');
    text.append(h('strong', null, person.display_name || `@${person.username}`));
    const stateLabel = friendStateLabel(person.friend_state);
    text.append(
      h('span', 'connect-req__note', stateLabel ? `@${person.username} · ${stateLabel}` : `@${person.username}`)
    );
    body.append(text);

    const view = friendAction(person.friend_state, Boolean(state.me && person.id === state.me.id));
    const btn = h('button', `connect-btn${view.action === 'request' ? ' connect-btn--primary' : ''}`, view.label);
    btn.type = 'button';
    btn.disabled = view.disabled;
    btn.addEventListener('click', () => {
      if (view.action === 'request') sendRequest(person, btn);
      else if (view.action === 'message') startChatWith(person);
      else if (view.action === 'requests') setTab(TAB_REQUESTS);
    });

    const wrap = h('div', 'connect-req__actions');
    wrap.append(btn);
    li.append(body, wrap);
    dom.discoList.append(li);
  }
}

/* --------------------------------- data ---------------------------------- */

async function refreshThreads() {
  try {
    const rows = await connectThreads();
    state.threads = Array.isArray(rows) ? rows : [];
    renderThreads();
  } catch (error) {
    state.threads = [];
    say(
      'The LOKY CONNECT database upgrade (supabase/migrations/0003_loky_connect.sql) has not been applied yet, so media, reactions and receipts are off. Showing your existing conversations read-only.',
      'warn'
    );
    try {
      const rows = await listConversations();
      state.threads = (Array.isArray(rows) ? rows : []).map((row) => ({
        conversation_id: row.conversation_id || row.id,
        peer_username: row.peer_username,
        peer_display_name: row.peer_display_name,
        last_body: row.last_body,
        last_at: row.last_at,
        last_sender_id: null,
        unread_count: 0,
      }));
      renderThreads();
    } catch (inner) {
      dom.chatEmpty.hidden = false;
      dom.chatEmpty.textContent = inner && inner.message
        ? `Chats are unavailable: ${inner.message}`
        : 'Chats are unavailable right now.';
    }
  }
}

async function refreshFriendRows() {
  // One shared request, so a poll and a user action cannot race into a stale paint.
  if (state.friendsInflight) return state.friendsInflight;

  state.friendsLoading = true;
  state.friendsError = '';
  renderFriends();

  state.friendsInflight = (async () => {
    try {
      const rows = await friends();
      state.friendRows = Array.isArray(rows) ? rows : [];
      state.friendsError = '';
    } catch (error) {
      // Keep the reason: an empty array alone cannot be told apart from failure.
      state.friendRows = [];
      state.friendsError = friendErrorCode(error);
    } finally {
      state.friendsLoading = false;
      state.friendsInflight = null;
      renderFriends();
    }
  })();

  return state.friendsInflight;
}

async function refreshBlocked() {
  if (!state.me) {
    state.blocked = [];
    state.blockedError = '';
    renderBlocked();
    return;
  }
  try {
    const rows = await listBlockedUsers();
    state.blocked = blockedListModel(rows, state.me && state.me.id);
    state.blockedError = '';
  } catch (error) {
    state.blocked = [];
    state.blockedError = friendErrorCode(error);
  }
  renderBlocked();
}

/* ------------------------------ friend actions ---------------------------- */

function closeMenus() {
  for (const panel of document.querySelectorAll('.connect-friend__menu')) panel.hidden = true;
  for (const btn of document.querySelectorAll('.connect-friend__dots')) {
    btn.setAttribute('aria-expanded', 'false');
  }
}

/** Confirm step for the two destructive actions; resolves true only on confirm. */
function confirmDialog(model) {
  return new Promise((resolve) => {
    const overlay = h('div', 'connect-confirm');
    const card = h('div', 'connect-confirm__card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.append(h('h3', 'connect-confirm__title', model.title));
    card.append(h('p', 'connect-confirm__body', model.body));

    const actions = h('div', 'connect-confirm__actions');
    const cancel = h('button', 'connect-btn', 'Cancel');
    cancel.type = 'button';
    const ok = h(
      'button',
      `connect-btn ${model.danger ? 'connect-btn--danger' : 'connect-btn--primary'}`,
      model.confirmLabel
    );
    ok.type = 'button';

    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') done(false);
    };

    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    document.addEventListener('keydown', onKey);

    actions.append(cancel, ok);
    card.append(actions);
    overlay.append(card);
    dom.section.append(overlay);
    ok.focus();
  });
}

async function runRemoveFriend(friend, trigger) {
  if (!friend || !friend.user_id) return;
  if (!(await confirmDialog(removeFriendConfirmText(friend.username)))) return;

  trigger.disabled = true;
  try {
    await removeFriend(friend.user_id);
    state.friendRows = withoutPerson(state.friendRows, friend.user_id);
    renderFriends();
    say(`@${friend.username} removed from your friends.`, 'ok');
    await refreshFriendRows();
  } catch (error) {
    say(describeFriendError(friendErrorCode(error)), 'bad');
    await refreshFriendRows();
  } finally {
    trigger.disabled = false;
  }
}

async function runBlockUser(friend, trigger) {
  if (!friend || !friend.user_id) return;
  if (!(await confirmDialog(blockUserConfirmText(friend.username)))) return;

  trigger.disabled = true;
  try {
    await blockUser(friend.user_id);
    state.friendRows = withoutPerson(state.friendRows, friend.user_id);
    renderFriends();
    say(`@${friend.username} is blocked.`, 'ok');
    await Promise.all([refreshFriendRows(), refreshBlocked()]);
  } catch (error) {
    say(describeFriendError(friendErrorCode(error)), 'bad');
  } finally {
    trigger.disabled = false;
  }
}

async function runUnblock(person, trigger) {
  if (!person || !person.id) return;
  if (!(await confirmDialog(unblockConfirmText(person.username)))) return;
  trigger.disabled = true;
  try {
    await unblockUser(person.id);
    state.blocked = withoutPerson(state.blocked, person.id);
    renderBlocked();
    say(`@${person.username} is unblocked.`, 'ok');
    await refreshBlocked();
  } catch (error) {
    say(describeFriendError(friendErrorCode(error)), 'bad');
    await refreshBlocked();
  } finally {
    trigger.disabled = false;
  }
}

async function refreshRequestRows() {
  try {
    state.requestRows = await friendRequests();
  } catch (error) {
    state.requestRows = [];
  }
  renderRequests();
  renderBadges();
}

async function refreshNotifications() {
  try {
    state.notifications = await connectNotifications(30);
  } catch (error) {
    state.notifications = [];
  }
  renderBadges();
}

/* -------------------------------- actions -------------------------------- */

async function sendRequest(person, button) {
  button.disabled = true;
  try {
    await sendFriendRequest(person.id, null);
    person.friend_state = 'pending_out';
    say(`Friend request sent to @${person.username}.`, 'ok');
    await refreshRequestRows();
    renderResults();
  } catch (error) {
    say(error && error.message ? error.message : 'The request could not be sent.', 'bad');
  } finally {
    button.disabled = false;
  }
}

async function respond(req, decision, button) {
  button.disabled = true;
  try {
    await respondFriendRequest(req.request_id, decision);
    say(decision === 'accepted' ? 'Friend request accepted.' : 'Friend request rejected.', 'ok');
    await Promise.all([refreshRequestRows(), refreshFriendRows()]);
  } catch (error) {
    say(error && error.message ? error.message : 'That request could not be answered.', 'bad');
  } finally {
    button.disabled = false;
  }
}

async function cancelRequest(req, button) {
  button.disabled = true;
  try {
    await cancelFriendRequest(req.request_id);
    // cancel_friend_request() keeps the row with status 'cancelled', and
    // refreshRequestRows() re-reads it, so remove it here as well. Without
    // this the same person reappears in Sent right after a successful cancel.
    state.requestRows = state.requestRows.filter((row) => row && row.request_id !== req.request_id);
    // Discover must offer 'Add friend' again, otherwise the button stays on
    // 'Request Sent' and the request can never be re-sent from this screen.
    for (const person of state.results) {
      if (person && person.id === req.other_id && person.friend_state === 'pending_out') {
        person.friend_state = 'none';
      }
    }
    renderRequests();
    renderResults();
    say('Friend request cancelled.', 'ok');
    await refreshRequestRows();
    renderResults();
  } catch (error) {
    say(error && error.message ? error.message : 'That request could not be cancelled.', 'bad');
    // Restore the real server state instead of leaving the list half-updated.
    await refreshRequestRows();
  } finally {
    button.disabled = false;
  }
}

async function runSearch() {
  const term = normalizeSearchTerm(dom.discoInput.value || '');
  // Discover search is kept separate from the chat-list filter (state.search),
  // otherwise searching a person also silently filters the conversation list.
  state.searchTerm = term;
  state.searchError = '';

  if (!isSearchable(term)) {
    state.results = [];
    state.searching = false;
    renderResults();
    say('Type at least two characters of a username.', 'warn');
    return;
  }

  state.results = [];
  state.searching = true;
  renderResults();
  clear(dom.discoList);

  try {
    const people = excludeSelf(await searchUsers(term), state.me && state.me.id);
    const withState = [];
    for (const person of people) {
      if (!person || !person.id) continue;
      // The RPC returns friend_state once migration 0006 is applied; until
      // then fall back to the per-user lookup so behaviour never regresses.
      let status = person.friend_state || 'none';
      if (!person.friend_state) {
        try {
          status = await friendStatus(person.id);
        } catch (error) {
          status = 'none';
        }
      }
      withState.push({ ...person, friend_state: status });
    }
    state.results = withState;
  } catch (error) {
    state.results = [];
    state.searchError = error && error.message ? error.message : 'Search failed.';
  } finally {
    state.searching = false;
    renderResults();
  }
}

async function startChatWith(person) {
  try {
    const id = await startConversation(person.id || person.user_id);
    if (!id) throw new Error('The conversation could not be opened.');
    await refreshThreads();
    const row = state.threads.find((t) => t.conversation_id === id) || {
      conversation_id: id,
      peer_username: person.username,
      peer_display_name: person.display_name,
      peer_avatar_url: person.avatar_seed,
    };
    openThread(row);
  } catch (error) {
    say(error && error.message ? error.message : 'That chat could not be opened.', 'bad');
  }
}

/* --------------------------------- thread -------------------------------- */

async function openThread(row) {
  state.active = {
    id: row.conversation_id,
    name: row.peer_display_name || (row.peer_username ? `@${row.peer_username}` : 'Chat'),
    username: row.peer_username,
    avatar: row.peer_avatar_url,
    peerId: row.peer_id || null,
    blocked: false,
  };
  state.messages = [];
  state.attachment = null;
  state.replyTo = null;

  dom.threadName.textContent = state.active.name;
  dom.threadPresence.textContent = '';
  const nextAvatar = avatarNode(state.active.name, state.active.username, state.active.avatar, 'sm');
  dom.threadAvatar.replaceWith(nextAvatar);
  dom.threadAvatar = nextAvatar;

  dom.thread.hidden = false;
  dom.panes.hidden = true;
  dom.attachPreview.hidden = true;
  dom.input.value = '';
  dom.scroll.className = 'connect-thread__scroll';
  dom.scroll.textContent = 'Loading messages…';

  renderThreadHead();
  // state.blocked is only filled by the Friends pane, so refresh it here to make
  // the blocked banner and the disabled composer correct on the first open.
  refreshBlocked().then(renderThreadHead).catch(() => {});

  openLayer('connect-thread', () => closeThread());
  await refreshThread();
  startThreadPolling();
}

function closeThread() {
  stopThreadPolling();
  dom.thread.hidden = true;
  dom.panes.hidden = false;
  state.active = null;
  state.messages = [];
  state.attachment = null;
  state.replyTo = null;
  closeLayer('connect-thread');
  refreshThreads();
}

async function refreshThread() {
  if (!state.active || state.busy) return;
  state.busy = true;
  const conversationId = state.active.id;
  try {
    const rows = await connectMessages(conversationId, 80);
    const list = Array.isArray(rows) ? rows.slice().reverse() : [];
    state.messages = list;
    renderMessages();
    connectMarkRead(conversationId).catch(() => {});
    const typers = await connectTypingStatus(conversationId).catch(() => []);
    const others = (Array.isArray(typers) ? typers : []).filter(
      (row) => !state.me || row.user_id !== state.me.id
    );
    dom.typing.hidden = others.length === 0;
    if (others.length) {
      const names = others.map((row) => (row.username ? `@${row.username}` : 'Someone'));
      dom.typing.textContent = `${names.join(', ')} typing…`;
    }
  } catch (error) {
    if (state.messages.length === 0) {
      dom.scroll.className = 'connect-thread__scroll connect-thread__scroll--error';
      dom.scroll.textContent = error && error.message
        ? error.message
        : 'Messages could not be loaded.';
    }
  } finally {
    state.busy = false;
  }
}

function renderMessages() {
  if (!dom.scroll) return;
  clear(dom.scroll);
  dom.scroll.className = 'connect-thread__scroll';
  if (!state.messages.length) {
    dom.scroll.textContent = 'No messages yet — say hello.';
    return;
  }

  let lastDay = '';
  for (const row of state.messages) {
    const label = dayLabel(row.created_at);
    if (label !== lastDay) {
      lastDay = label;
      dom.scroll.append(h('div', 'connect-daysep', label));
    }
    dom.scroll.append(buildBubble(row));
  }
  dom.scroll.scrollTop = dom.scroll.scrollHeight;
}

function buildBubble(row) {
  const mine = Boolean(state.me && row.sender_id === state.me.id);
  const bubble = h('div', `connect-bubble connect-bubble--${mine ? 'out' : 'in'}`);

  if (row.deleted_at) {
    bubble.append(h('em', 'connect-bubble__deleted', 'Message deleted'));
  } else {
    if (row.reply_to_id) {
      const reply = h('div', 'connect-bubble__reply');
      const who = state.me && row.reply_sender === state.me.id ? 'You' : 'Reply';
      reply.append(h('span', 'connect-bubble__reply-who', who));
      reply.append(h('span', 'connect-bubble__reply-body', row.reply_body || 'Message'));
      bubble.append(reply);
    }

    if (row.media_path) bubble.append(buildMedia(row));

    const text = typeof row.body === 'string' ? row.body.trim() : '';
    if (text) bubble.append(h('span', 'connect-bubble__text', text));
  }

  const meta = h('div', 'connect-bubble__meta');
  const time = h('time', 'connect-bubble__time', clockLabel(row.created_at));
  meta.append(time);
  if (mine && !row.deleted_at) {
    const tick = h('span', 'connect-bubble__tick', '✓');
    tick.setAttribute('aria-label', 'Sent');
    meta.append(tick);
  }
  bubble.append(meta);

  const chips = groupReactions(row.reactions, state.me && state.me.id);
  if (chips.length) {
    const bar = h('div', 'connect-bubble__reacts');
    for (const chip of chips) {
      const btn = h('button', `connect-react${chip.mine ? ' connect-react--mine' : ''}`, `${chip.emoji} ${chip.count}`);
      btn.type = 'button';
      btn.addEventListener('click', () => toggleReaction(row, chip.emoji, chip.mine));
      bar.append(btn);
    }
    bubble.append(bar);
  }

  const menu = h('div', 'connect-bubble__menu');
  for (const emoji of REACTIONS) {
    const btn = h('button', 'connect-react-pick', emoji);
    btn.type = 'button';
    btn.setAttribute('aria-label', `React ${emoji}`);
    btn.addEventListener('click', () => toggleReaction(row, emoji, false));
    menu.append(btn);
  }

  const replyBtn = h('button', 'connect-react-pick', '↩');
  replyBtn.type = 'button';
  replyBtn.setAttribute('aria-label', 'Reply');
  replyBtn.addEventListener('click', () => {
    state.replyTo = row;
    renderAttachPreview();
    dom.input.focus();
  });
  menu.append(replyBtn);

  if (mine && !row.deleted_at) {
    const del = h('button', 'connect-react-pick connect-react-pick--danger', '🗑');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete message');
    del.addEventListener('click', () => removeMessage(row));
    menu.append(del);
  }

  bubble.append(menu);
  return bubble;
}

function buildMedia(row) {
  const wrap = h('div', 'connect-bubble__media');
  const cached = state.mediaCache.get(row.media_path);
  if (!cached) {
    wrap.textContent = row.media_type === 'video' ? '🎬 Video' : '📷 Photo';
    if (!state.mediaCache.has(row.media_path)) {
      state.mediaCache.set(row.media_path, null);
      signedConnectMediaUrl(row.media_path)
        .then((url) => {
          if (!url) return;
          state.mediaCache.set(row.media_path, url);
          scheduleAvatarRepaint();
        })
        .catch(() => {});
    }
    return wrap;
  }

  if (row.media_type === 'video') {
    const video = document.createElement('video');
    video.src = cached;
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    wrap.append(video);
  } else {
    const img = document.createElement('img');
    img.src = cached;
    img.alt = 'Attached photo';
    img.loading = 'lazy';
    wrap.append(img);
  }
  return wrap;
}

async function toggleReaction(row, emoji, mine) {
  try {
    if (mine) await connectUnreact(row.id, emoji);
    else await connectReact(row.id, emoji);
    await refreshThread();
  } catch (error) {
    say(error && error.message ? error.message : 'That reaction could not be saved.', 'bad');
  }
}

async function removeMessage(row) {
  try {
    await connectDeleteMessage(row.id);
    say('Message deleted.', 'ok');
    await refreshThread();
    await refreshThreads();
  } catch (error) {
    say(error && error.message ? error.message : 'That message could not be deleted.', 'bad');
  }
}

function onPickFile() {
  const file = dom.fileInput.files && dom.fileInput.files[0];
  dom.fileInput.value = '';
  if (!file) return;
  const check = validateAttachment(file);
  if (!check.ok) {
    say(check.error, 'bad');
    return;
  }
  state.attachment = { file, kind: check.kind, name: file.name, path: null };
  renderAttachPreview();
}

function renderAttachPreview() {
  if (!dom.attachPreview) return;
  clear(dom.attachPreview);
  const parts = [];

  if (state.replyTo) {
    const chip = h('div', 'connect-attach__chip');
    chip.append(h('span', null, `Reply: ${previewText(state.replyTo)}`));
    const x = h('button', 'connect-attach__x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Cancel reply');
    x.addEventListener('click', () => {
      state.replyTo = null;
      renderAttachPreview();
    });
    chip.append(x);
    parts.push(chip);
  }

  if (state.attachment) {
    const chip = h('div', 'connect-attach__chip');
    const icon = state.attachment.kind === 'image' ? '📷' : '🎬';
    chip.append(h('span', null, `${icon} ${state.attachment.name}`));
    const x = h('button', 'connect-attach__x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Remove attachment');
    x.addEventListener('click', () => {
      state.attachment = null;
      renderAttachPreview();
    });
    chip.append(x);
    parts.push(chip);
  }

  for (const part of parts) dom.attachPreview.append(part);
  dom.attachPreview.hidden = parts.length === 0;
}

function onType() {
  if (!state.active) return;
  const now = Date.now();
  if (now - state.lastTypingAt < TYPING_THROTTLE_MS) return;
  state.lastTypingAt = now;
  connectSetTyping(state.active.id).catch(() => {});
}

async function submit() {
  // A blocked pair cannot insert messages (the DB trigger raises 'user_blocked'),
  // so never start a send that is guaranteed to fail.
  if (!state.active || state.active.blocked) return;
  const text = dom.input.value;
  if (!draftIsSendable({ text, attachment: state.attachment })) return;

  dom.sendBtn.disabled = true;
  try {
    let attachment = state.attachment;
    if (attachment && !attachment.path) {
      const path = await uploadConnectMedia(attachment.file, state.active.id);
      attachment = { ...attachment, path };
      state.attachment = attachment;
    }

    await connectSend(
      state.active.id,
      buildSendPayload({ text, attachment, replyTo: state.replyTo ? state.replyTo.id : null })
    );

    dom.input.value = '';
    state.attachment = null;
    state.replyTo = null;
    renderAttachPreview();
    await refreshThread();
    await refreshThreads();
  } catch (error) {
    say(error && error.message ? error.message : 'The message could not be sent.', 'bad');
  } finally {
    dom.sendBtn.disabled = false;
    // Deliberately no refocus: on Android that reopens the keyboard after every
    // send, which was a reported bug. The user taps the field to type.
  }
}

/* ---------------------------------- sheet -------------------------------- */

function openSheet(title, nodes) {
  clear(dom.sheetPanel);
  const top = h('header', 'connect-sheet__top');
  top.append(h('h2', 'connect-sheet__title', title));
  const close = h('button', 'connect-icon', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeSheet);
  top.append(close);
  dom.sheetPanel.append(top);
  for (const node of nodes) dom.sheetPanel.append(node);
  dom.sheet.hidden = false;
  openLayer('connect-sheet', closeSheet);
}

function closeSheet() {
  dom.sheet.hidden = true;
  closeLayer('connect-sheet');
}

function field(label, input) {
  const wrap = h('label', 'connect-field');
  wrap.append(h('span', 'connect-field__label', label), input);
  return wrap;
}

function checkbox(label, checked) {
  const wrap = h('label', 'connect-check');
  const input = h('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  wrap.append(input, h('span', null, label));
  return { node: wrap, input };
}

async function openProfile() {
  let profile = state.profile;
  if (!profile) profile = await getMyProfile().catch(() => null);

  const head = h('div', 'connect-profile__head');
  head.append(avatarNode(profile && profile.username, profile && profile.username, profile && profile.avatar_url, 'lg'));
  const who = h('div');
  who.append(h('strong', null, (profile && profile.display_name) || (profile && profile.username ? `@${profile.username}` : 'Your profile')));
  who.append(h('span', 'connect-profile__username', profile && profile.username ? `@${profile.username}` : 'No username yet'));
  head.append(who);

  const form = h('form', 'connect-form');

  const nameInput = h('input', 'connect-input');
  nameInput.value = (profile && profile.display_name) || '';
  nameInput.placeholder = 'Display name';
  nameInput.maxLength = 60;
  form.append(field('Display name', nameInput));

  const bioInput = h('textarea', 'connect-input');
  bioInput.rows = 3;
  bioInput.maxLength = 160;
  bioInput.value = (profile && profile.bio) || '';
  bioInput.placeholder = 'A short bio';
  form.append(field('Bio', bioInput));

  const avatarFile = h('input', 'connect-file');
  avatarFile.type = 'file';
  avatarFile.accept = 'image/*';
  const avatarLabel = h('label', 'connect-file__label', 'Change profile picture');
  avatarLabel.append(avatarFile);
  form.append(avatarLabel);

  const lastSeen = checkbox('Show when I was last online', !profile || profile.privacy_last_seen !== false);
  const discoverable = checkbox('Let people find me in Discover', !profile || profile.privacy_discoverable !== false);
  form.append(lastSeen.node, discoverable.node);

  const save = h('button', 'connect-btn connect-btn--primary', 'Save profile');
  save.type = 'submit';
  form.append(save);

  let avatarPath = (profile && profile.avatar_url) || null;

  avatarFile.addEventListener('change', async () => {
    const file = avatarFile.files && avatarFile.files[0];
    avatarFile.value = '';
    if (!file) return;
    const check = validateAttachment(file);
    if (!check.ok || check.kind !== 'image') {
      say('Pick a PNG, JPG, WEBP or GIF under 8 MB.', 'bad');
      return;
    }
    save.disabled = true;
    try {
      avatarPath = await uploadConnectMedia(file, null);
      say('Profile picture uploaded. Press Save profile to keep it.', 'ok');
    } catch (error) {
      say(error && error.message ? error.message : 'That picture could not be uploaded.', 'bad');
    } finally {
      save.disabled = false;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await connectSetProfile({
        display_name: nameInput.value.trim() || null,
        bio: bioInput.value.trim() || null,
        avatar_url: avatarPath,
        privacy_last_seen: lastSeen.input.checked,
        privacy_discoverable: discoverable.input.checked,
      });
      state.profile = await getMyProfile().catch(() => state.profile);
      if (state.profile && state.profile.avatar_url) {
        state.avatarCache.delete(state.profile.avatar_url);
      }
      renderMeAvatar();
      say('Profile saved.', 'ok');
      closeSheet();
      await refreshThreads();
    } catch (error) {
      say(error && error.message ? error.message : 'The profile could not be saved.', 'bad');
    } finally {
      save.disabled = false;
    }
  });

  openSheet('Your profile', [head, form]);
}

async function openNotifications() {
  await refreshNotifications();
  const nodes = [];
  if (!state.notifications.length) {
    nodes.push(h('p', 'connect-empty', 'No notifications yet.'));
  } else {
    const list = h('ul', 'connect-list');
    for (const item of state.notifications) {
      const li = h('li', `connect-notif${item.read_at ? '' : ' connect-notif--unread'}`);
      li.append(avatarNode(item.actor_username, item.actor_username, item.actor_avatar, 'sm'));
      const body = h('div', 'connect-notif__body');
      body.append(h('span', null, notificationText(item)));
      body.append(h('time', 'connect-notif__time', listTime(item.created_at)));
      li.append(body);
      list.append(li);
    }
    nodes.push(list);
  }

  const mark = h('button', 'connect-btn', 'Mark all as read');
  mark.type = 'button';
  mark.addEventListener('click', async () => {
    try {
      await connectMarkNotificationsRead();
      await refreshNotifications();
      closeSheet();
      say('Notifications marked as read.', 'ok');
    } catch (error) {
      say(error && error.message ? error.message : 'Could not update notifications.', 'bad');
    }
  });
  nodes.push(mark);

  openSheet('Notifications', nodes);
  connectMarkNotificationsRead().catch(() => {});
}

/* --------------------------------- shell --------------------------------- */

function setTab(tab) {
  const next = normalizeTab(tab);
  state.tab = next;
  for (const [id, btn] of dom.tabButtons) btn.setAttribute('aria-selected', String(id === next));
  for (const [id, pane] of dom.pane) pane.hidden = id !== next;

  const meta = CONNECT_TABS.find((t) => t.id === next);
  dom.subtitle.textContent = meta ? meta.label : '';
  dom.panes.hidden = false;
  dom.thread.hidden = true;

  if (next === TAB_FRIENDS) {
    refreshFriendRows();
    refreshBlocked();
  }
  if (next === TAB_REQUESTS) refreshRequestRows();
  if (next === TAB_DISCOVER) renderResults();
  if (next === TAB_CHATS) renderThreads();
  dom.notice.hidden = true;
}

function startPolling() {
  stopPolling();
  state.threadsTimer = setInterval(() => {
    if (document.hidden || !state.open) return;
    refreshThreads();
    refreshRequestRows();
  }, POLL_THREADS_MS);
}

function stopPolling() {
  if (state.threadsTimer) clearInterval(state.threadsTimer);
  state.threadsTimer = null;
}

function startThreadPolling() {
  stopThreadPolling();
  state.threadTimer = setInterval(() => {
    if (document.hidden || !state.open || !state.active) return;
    refreshThread();
  }, POLL_THREAD_MS);
}

function stopThreadPolling() {
  if (state.threadTimer) clearInterval(state.threadTimer);
  state.threadTimer = null;
  if (dom.typing) dom.typing.hidden = true;
}

function renderMeAvatar() {
  if (!dom.profileBtn) return;
  const profile = state.profile;
  const next = avatarNode(
    (profile && profile.username) || 'me',
    (profile && profile.username) || 'me',
    profile && profile.avatar_url,
    'sm'
  );
  dom.profileAvatar.replaceWith(next);
  dom.profileAvatar = next;
}

export async function open() {
  dom.section = document.getElementById('connect');
  if (!dom.section) return;

  build();

  if (!state.me) {
    const user = currentUser();
    state.me = user ? { id: user.id } : null;
  }

  dom.section.hidden = false;
  state.open = true;

  if (!state.me) {
    say('Sign in to use LOKY CONNECT.', 'bad');
    return;
  }

  state.profile = await getMyProfile().catch(() => null);
  renderMeAvatar();

  await Promise.all([refreshThreads(), refreshRequestRows(), refreshNotifications()]);
  if (state.tab === TAB_FRIENDS) await Promise.all([refreshFriendRows(), refreshBlocked()]);

  touchLastSeen().catch(() => {});
  startPolling();
}

export function close() {
  state.open = false;
  stopPolling();
  stopThreadPolling();
  closeSheet();
  if (dom.section) dom.section.hidden = true;
}

export function isOpen() {
  return state.open;
}
