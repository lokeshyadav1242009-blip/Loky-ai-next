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
  notificationText,
  draftIsSendable,
  buildSendPayload,
  friendAction,
} from './connect-model.js';

import { openLayer, closeLayer } from './back-nav.js';

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
  dom.friendList = h('ul', 'connect-list');
  dom.friendEmpty = h('p', 'connect-empty', 'No friends yet. Send a request from Discover.');
  pane.append(dom.friendList, dom.friendEmpty);
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
  dom.backBtn = h('button', 'connect-icon', '←');
  dom.backBtn.type = 'button';
  dom.backBtn.setAttribute('aria-label', 'Back to chats');
  dom.backBtn.addEventListener('click', () => closeThread());

  dom.threadAvatar = avatarNode('?', 'thread', null, 'sm');
  const who = h('div', 'connect-thread__who');
  dom.threadName = h('strong', 'connect-thread__name', 'Chat');
  dom.threadPresence = h('small', 'connect-thread__presence', '');
  who.append(dom.threadName, dom.threadPresence);
  top.append(dom.backBtn, dom.threadAvatar, who);

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

function renderThreads() {
  if (!dom.chatList) return;
  clear(dom.chatList);
  const rows = filterThreads(sortThreads(state.threads), state.search);
  dom.chatEmpty.hidden = rows.length > 0;
  dom.chatEmpty.textContent = state.search
    ? 'No chats match that search.'
    : 'No chats yet. Find someone in Discover and start talking.';

  for (const row of rows) {
    const li = h('li', 'connect-chat');
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
    btn.addEventListener('click', () => openThread(row));
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
  dom.friendEmpty.hidden = state.friendRows.length > 0;
  for (const friend of state.friendRows) {
    const li = h('li', 'connect-friend');
    const btn = h('button', 'connect-friend__btn');
    btn.type = 'button';
    btn.append(avatarNode(friend.username, friend.username, friend.avatar_seed, 'md'));
    const body = h('div', 'connect-friend__body');
    body.append(h('strong', 'connect-friend__name', friend.display_name || `@${friend.username}`));
    body.append(h('span', 'connect-friend__meta', `@${friend.username}`));
    btn.append(body, h('span', 'connect-friend__cta', 'Message'));
    btn.addEventListener('click', () => startChatWith(friend));
    li.append(btn);
    dom.friendList.append(li);
  }
}

function renderRequests() {
  if (!dom.reqIncoming) return;
  const incoming = state.requestRows.filter((r) => r.direction === 'in');
  const outgoing = state.requestRows.filter((r) => r.direction === 'out');

  clear(dom.reqIncoming);
  dom.reqIncomingEmpty.hidden = incoming.length > 0;
  for (const req of incoming) {
    dom.reqIncoming.append(requestRow(req, [
      { label: 'Accept', cls: 'connect-btn connect-btn--primary', run: (b) => respond(req, 'accepted', b) },
      { label: 'Reject', cls: 'connect-btn', run: (b) => respond(req, 'rejected', b) },
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
  text.append(h('span', 'connect-req__note', req.note || (req.direction === 'in' ? 'wants to connect' : 'request pending')));
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
  dom.discoEmpty.hidden = state.results.length > 0;
  if (!state.results.length) {
    dom.discoEmpty.textContent = state.search
      ? 'Nobody matched that username.'
      : 'Search a username to find people.';
  }

  for (const person of state.results) {
    const li = h('li', 'connect-result');
    const body = h('div', 'connect-req__body');
    body.append(avatarNode(person.username, person.username, person.avatar_seed, 'md'));
    const text = h('div', 'connect-req__text');
    text.append(h('strong', null, person.display_name || `@${person.username}`));
    text.append(h('span', 'connect-req__note', `@${person.username}`));
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
  try {
    state.friendRows = await friends();
  } catch (error) {
    state.friendRows = [];
  }
  renderFriends();
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
    say('Friend request cancelled.', 'ok');
    await refreshRequestRows();
  } catch (error) {
    say(error && error.message ? error.message : 'That request could not be cancelled.', 'bad');
  } finally {
    button.disabled = false;
  }
}

async function runSearch() {
  const term = (dom.discoInput.value || '').trim().replace(/^@/, '');
  state.search = term;
  if (term.length < 2) {
    say('Type at least two characters of a username.', 'warn');
    return;
  }
  dom.discoEmpty.hidden = false;
  dom.discoEmpty.textContent = 'Searching…';
  clear(dom.discoList);
  try {
    const people = await searchUsers(term);
    const withState = [];
    for (const person of people) {
      let status = 'none';
      try {
        status = await friendStatus(person.id);
      } catch (error) {
        status = 'none';
      }
      withState.push({ ...person, friend_state: status });
    }
    state.results = withState;
    renderResults();
  } catch (error) {
    state.results = [];
    renderResults();
    dom.discoEmpty.textContent = error && error.message ? error.message : 'Search failed.';
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
  if (!state.active) return;
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

  if (next === TAB_FRIENDS) refreshFriendRows();
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
  if (state.tab === TAB_FRIENDS) await refreshFriendRows();

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
