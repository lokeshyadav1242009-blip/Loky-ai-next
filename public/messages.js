/**
 * LOKY AI Next — Messages section (WhatsApp-style messenger).
 *
 * This is an ADD-ON section: it never touches the AI assistant (app.js keeps
 * owning the assistant shell, streaming and chat history). The only shared
 * piece is the top navigation switch.
 *
 * Data model (see messages-utils.js):
 *   thread = { id, name, avatarSeed, demo, unread, createdAt, updatedAt, messages[] }
 *   message = { id, direction: 'in' | 'out', text, at, attachment }
 *
 * Persistence: localStorage on this device only, under a key that is separate
 * from the assistant history.
 *
 * Real multi-user chat is opt-in and lives in direct-messages.js: a thread with
 * a `remoteId` is backed by a Supabase conversation and rendered/sent through
 * the hooks below. Everything network-related stays in that module, so local
 * conversations keep working exactly as before and this file still makes no
 * network calls of its own.
 */

import {
  DEFAULT_THREAD_NAME,
  EMOJI_PALETTE,
  MESSAGES_STORAGE_KEY,
  MAX_MESSAGE_LENGTH,
  avatarColorFor,
  createThread,
  createThreadId,
  filterThreads,
  formatClockTime,
  formatFileSize,
  initialsFor,
  normalizeThreads,
  sampleThreads,
  serializeThreads,
  threadPreview,
} from './messages-utils.js';
import { formatRelativeTime, sanitizeTitle } from './chat-utils.js';
import {
  describeError,
  initAccountUI,
  isRemoteThread,
  refreshAccount,
  renderRemoteThread,
  sendToRemoteThread,
  startPolling,
  stopRemotePolling,
} from './direct-messages.js';

const state = {
  threads: [],
  activeId: null,
  query: '',
  view: 'list',
  attachment: null,
};

let el = null;
let wired = false;

function byId(id) {
  return document.getElementById(id);
}

function cacheElements() {
  el = {
    messenger: byId('messenger'),
    list: byId('msgList'),
    empty: byId('msgEmpty'),
    emptyTitle: byId('msgEmptyTitle'),
    emptyText: byId('msgEmptyText'),
    emptyActions: byId('msgEmptyActions'),
    emptyStart: byId('msgEmptyStart'),
    emptySamples: byId('msgEmptySamples'),
    search: byId('msgSearch'),
    searchClear: byId('msgSearchClear'),
    newBtn: byId('msgNew'),
    newRow: byId('msgNewRow'),
    newInput: byId('msgNewInput'),
    newCancel: byId('msgNewCancel'),
    back: byId('msgBack'),
    threadAvatar: byId('msgThreadAvatar'),
    threadName: byId('msgThreadName'),
    threadSub: byId('msgThreadSub'),
    rename: byId('msgRename'),
    remove: byId('msgDelete'),
    body: byId('msgBody'),
    placeholder: byId('msgThreadPlaceholder'),
    chip: byId('msgChip'),
    chipName: byId('msgChipName'),
    chipRemove: byId('msgChipRemove'),
    composer: byId('msgComposer'),
    input: byId('msgInput'),
    attach: byId('msgAttach'),
    emoji: byId('msgEmoji'),
    emojiPanel: byId('msgEmojiPanel'),
    send: byId('msgSend'),
    file: byId('msgFile'),
  };
}

/* ------------------------------ persistence ------------------------------ */

function save() {
  try {
    localStorage.setItem(MESSAGES_STORAGE_KEY, serializeThreads(state.threads, state.activeId));
  } catch {
    /* Storage blocked or full — the app keeps working in memory. */
  }
}

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(MESSAGES_STORAGE_KEY);
  } catch {
    raw = null;
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      state.threads = normalizeThreads(parsed && parsed.threads);
      state.activeId = parsed && typeof parsed.activeId === 'string' ? parsed.activeId : null;
    } catch {
      state.threads = [];
      state.activeId = null;
    }
  } else {
    // First run: seed clearly-labelled demo conversations.
    state.threads = sampleThreads();
    state.activeId = null;
    save();
  }

  if (state.activeId && !state.threads.some((t) => t.id === state.activeId)) {
    state.activeId = null;
  }
}

function activeThread() {
  return state.threads.find((t) => t.id === state.activeId) || null;
}

/* -------------------------------- helpers -------------------------------- */

function avatarNode(seed, name, small) {
  const span = document.createElement('span');
  span.className = small ? 'msg-avatar msg-avatar--sm' : 'msg-avatar';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = initialsFor(name);
  span.style.background = avatarColorFor(seed || name);
  return span;
}

function setView(view) {
  state.view = view;
  if (el.messenger) el.messenger.dataset.view = view;
}

/* -------------------------------- rendering ------------------------------- */

function renderList() {
  if (!el.list) return;

  const visible = filterThreads(state.threads, state.query);
  el.list.replaceChildren();

  for (const thread of visible) {
    const li = document.createElement('li');
    li.className = 'msg-row';
    li.dataset.id = thread.id;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-row__btn';

    const avatar = avatarNode(thread.avatarSeed, thread.name, false);

    const main = document.createElement('span');
    main.className = 'msg-row__main';

    const top = document.createElement('span');
    top.className = 'msg-row__top';

    const name = document.createElement('span');
    name.className = 'msg-row__name';
    name.textContent = thread.name;

    if (thread.demo) {
      const chip = document.createElement('span');
      chip.className = 'msg-chip-demo';
      chip.textContent = 'Sample';
      chip.title = 'Sample conversation — demo content, not a real chat';
      top.append(name, chip);
    } else {
      top.append(name);
    }

    const time = document.createElement('span');
    time.className = 'msg-row__time';
    time.textContent = formatRelativeTime(thread.updatedAt);
    top.append(time);

    const preview = document.createElement('span');
    preview.className = 'msg-row__preview';
    preview.textContent = threadPreview(thread);

    main.append(top, preview);
    btn.append(avatar, main);

    if (thread.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'msg-badge';
      badge.textContent = thread.unread > 99 ? '99+' : String(thread.unread);
      btn.append(badge);
    }

    btn.addEventListener('click', () => openThread(thread.id));
    li.append(btn);
    el.list.append(li);
  }

  renderEmpty(visible.length);
}

function renderEmpty(visibleCount) {
  if (!el.empty) return;

  if (visibleCount > 0) {
    el.empty.hidden = true;
    return;
  }

  el.empty.hidden = false;

  if (state.threads.length === 0) {
    el.emptyTitle.textContent = 'No conversations yet';
    el.emptyText.textContent =
      'Start a conversation and it will show up here. Chats are stored on this device only.';
    if (el.emptyActions) el.emptyActions.hidden = false;
    if (el.emptyStart) el.emptyStart.textContent = 'New conversation';
  } else {
    el.emptyTitle.textContent = 'No chats match your search';
    el.emptyText.textContent = `Nothing found for “${state.query.trim()}”. Try another name or keyword.`;
    if (el.emptyActions) el.emptyActions.hidden = true;
  }
}

function renderThread() {
  const thread = activeThread();

  if (!thread) {
    if (el.body) el.body.replaceChildren();
    if (el.placeholder) el.placeholder.hidden = false;
    if (el.threadName) el.threadName.textContent = 'LOKY AI Messages';
    if (el.threadSub) el.threadSub.textContent = 'Pick a conversation to start reading';
    if (el.threadAvatar) {
      el.threadAvatar.textContent = 'L';
      el.threadAvatar.style.background = avatarColorFor('LOKY AI');
    }
    if (el.rename) el.rename.disabled = true;
    if (el.remove) el.remove.disabled = true;
    return;
  }

  if (el.placeholder) el.placeholder.hidden = true;
  if (el.rename) el.rename.disabled = false;
  if (el.remove) el.remove.disabled = false;

  if (el.threadAvatar) {
    el.threadAvatar.textContent = initialsFor(thread.name);
    el.threadAvatar.style.background = avatarColorFor(thread.avatarSeed || thread.name);
  }
  if (el.threadName) el.threadName.textContent = thread.name;
  if (el.threadSub) {
    el.threadSub.textContent = thread.demo
      ? 'Sample conversation · demo content'
      : isRemoteThread(thread)
        ? `Mini Chat · real chat${thread.remoteUsername ? ` · @${thread.remoteUsername}` : ''}`
        : `${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'} · on this device`;
  }

  if (!el.body) return;

  // Server-backed conversation: direct-messages.js owns fetch + painting.
  if (isRemoteThread(thread)) {
    renderRemoteThread(thread, el.body);
    startPolling(thread, el.body);
    return;
  }

  stopRemotePolling();
  el.body.replaceChildren();

  if (!thread.messages.length) {
    const hint = document.createElement('p');
    hint.className = 'msg-thread__hint';
    hint.textContent = 'No messages yet — say hello below.';
    el.body.append(hint);
    return;
  }

  let lastDay = '';
  for (const message of thread.messages) {
    const day = new Date(message.at).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const divider = document.createElement('div');
      divider.className = 'msg-daysep';
      divider.textContent = formatDayLabel(message.at);
      el.body.append(divider);
    }

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble msg-bubble--${message.direction === 'out' ? 'out' : 'in'}`;

    if (message.attachment) {
      const att = document.createElement('span');
      att.className = 'msg-attachment';
      att.textContent = `📎 ${message.attachment.name}${
        formatFileSize(message.attachment.size) ? ` · ${formatFileSize(message.attachment.size)}` : ''
      }`;
      bubble.append(att);
    }

    if (message.text) {
      const text = document.createElement('span');
      text.className = 'msg-bubble__text';
      text.textContent = message.text;
      bubble.append(text);
    }

    const time = document.createElement('time');
    time.className = 'msg-bubble__time';
    time.textContent = formatClockTime(message.at);
    time.dateTime = new Date(message.at).toISOString();
    bubble.append(time);

    el.body.append(bubble);
  }

  el.body.scrollTop = el.body.scrollHeight;
}

function formatDayLabel(value) {
  const date = new Date(Number(value) || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderAttachmentChip() {
  if (!el.chip || !el.chipName) return;
  if (!state.attachment) {
    el.chip.hidden = true;
    el.chipName.textContent = '';
    return;
  }
  const size = formatFileSize(state.attachment.size);
  el.chipName.textContent = `${state.attachment.name}${size ? ` · ${size}` : ''}`;
  el.chip.hidden = false;
}

function render() {
  renderList();
  renderThread();
  renderAttachmentChip();
}

/* ------------------------------- interactions ----------------------------- */

function openThread(id) {
  const thread = state.threads.find((t) => t.id === id);
  if (!thread) return;

  state.activeId = id;
  thread.unread = 0;
  setView('thread');
  save();
  render();
}

function backToList() {
  setView('list');
  render();
}

function startNewConversation(name) {
  const thread = createThread(name);
  state.threads.unshift(thread);
  state.activeId = thread.id;
  setView('thread');
  save();
  render();
  if (el.input) el.input.focus();
}

/**
 * Open (or create once) the local wrapper for a real Supabase conversation.
 * Called by direct-messages.js after "Chat" is pressed on a search result.
 */
function openRemoteThread(conversationId, person) {
  if (!conversationId) return;

  let thread = state.threads.find((t) => t.remoteId === conversationId);
  const now = Date.now();

  if (!thread) {
    const name =
      (person && (person.display_name || (person.username ? `@${person.username}` : ''))) || 'Mini Chat';
    thread = {
      id: `remote_${conversationId}`,
      name,
      avatarSeed: (person && (person.avatar_seed || person.username)) || name,
      demo: false,
      unread: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
      remoteId: conversationId,
      remoteUserId: (person && person.id) || null,
      remoteUsername: (person && person.username) || null,
    };
    state.threads.unshift(thread);
    save();
  } else if (person && person.username && thread.remoteUsername !== person.username) {
    thread.remoteUsername = person.username;
    save();
  }

  state.activeId = thread.id;
  setView('thread');
  render();
  if (el.input) el.input.focus();
}

function renameActiveThread(nextName) {
  const thread = activeThread();
  if (!thread) return;

  const clean = sanitizeTitle(nextName, thread.name);
  if (!clean || clean === thread.name) {
    renderThread();
    return;
  }

  thread.name = clean;
  thread.avatarSeed = clean;
  save();
  render();
}

function deleteActiveThread() {
  const thread = activeThread();
  if (!thread) return;

  const ok =
    typeof window.confirm === 'function'
      ? window.confirm(
          isRemoteThread(thread)
            ? `Remove the chat with “${thread.name}” from this device? The other person keeps their copy.`
            : `Delete “${thread.name}”? This cannot be undone.`
        )
      : true;
  if (!ok) return;

  state.threads = state.threads.filter((t) => t.id !== thread.id);
  state.activeId = null;
  state.attachment = null;
  setView('list');
  stopRemotePolling();
  save();
  render();
}

async function sendMessage() {
  const thread = activeThread();
  if (!thread) return;

  const text = el.input ? el.input.value.trim().slice(0, MAX_MESSAGE_LENGTH) : '';
  const attachment = state.attachment;
  if (!text && !attachment) return;

  // Real conversation: persist through direct-messages.js, then repaint.
  if (isRemoteThread(thread)) {
    if (!text) return; // attachments are a local-only convenience for now
    const typed = el.input ? el.input.value : '';
    if (el.input) el.input.value = '';
    state.attachment = null;
    renderAttachmentChip();
    try {
      await sendToRemoteThread(thread, text);
      thread.updatedAt = Date.now();
      save();
      render();
    } catch (error) {
      if (el.input) el.input.value = typed; // never lose what was typed
      if (el.threadSub) el.threadSub.textContent = describeError(error);
    }
    if (el.input) el.input.focus();
    return;
  }

  const now = Date.now();
  thread.messages.push({
    id: `msg_${createThreadId()}`,
    direction: 'out',
    text,
    at: now,
    attachment: attachment ? { name: attachment.name, size: attachment.size } : null,
  });
  thread.updatedAt = now;
  thread.unread = 0;

  state.attachment = null;
  if (el.input) el.input.value = '';
  save();
  render();
  if (el.input) el.input.focus();
}

function insertEmoji(emoji) {
  if (!el.input) return;
  const start = el.input.selectionStart ?? el.input.value.length;
  const end = el.input.selectionEnd ?? el.input.value.length;
  el.input.value = `${el.input.value.slice(0, start)}${emoji}${el.input.value.slice(end)}`;
  const caret = start + emoji.length;
  el.input.setSelectionRange(caret, caret);
  el.input.focus();
}

function toggleEmojiPanel(force) {
  if (!el.emojiPanel) return;
  const open = force === undefined ? el.emojiPanel.hidden : force;
  el.emojiPanel.hidden = !open;
  if (open) {
    el.emoji.classList.add('is-active');
  } else {
    el.emoji.classList.remove('is-active');
  }
}

function showNewRow(show) {
  if (!el.newRow) return;
  el.newRow.hidden = !show;
  if (show && el.newInput) {
    el.newInput.value = '';
    el.newInput.focus();
  }
}

function beginRename() {
  const thread = activeThread();
  if (!thread || !el.threadName) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'msg-thread__input';
  input.value = thread.name;
  input.maxLength = 60;
  input.setAttribute('aria-label', 'Conversation name');

  el.threadName.replaceChildren(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = (commit) => {
    if (settled) return;
    settled = true;
    if (commit) renameActiveThread(input.value);
    else renderThread();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

/* --------------------------------- wiring --------------------------------- */

function wire() {
  if (wired) return;
  wired = true;

  if (el.search) {
    el.search.addEventListener('input', () => {
      state.query = el.search.value;
      if (el.searchClear) el.searchClear.hidden = !state.query;
      renderList();
    });
  }

  if (el.searchClear) {
    el.searchClear.addEventListener('click', () => {
      state.query = '';
      if (el.search) {
        el.search.value = '';
        el.search.focus();
      }
      el.searchClear.hidden = true;
      renderList();
    });
  }

  if (el.newBtn) el.newBtn.addEventListener('click', () => showNewRow(true));
  if (el.newCancel) el.newCancel.addEventListener('click', () => showNewRow(false));

  if (el.newRow) {
    el.newRow.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = el.newInput ? el.newInput.value.trim() : '';
      if (!name) return;
      showNewRow(false);
      startNewConversation(name);
    });
  }

  if (el.emptyStart) {
    el.emptyStart.addEventListener('click', () => {
      if (state.threads.length === 0) {
        showNewRow(true);
      } else {
        showNewRow(true);
      }
    });
  }

  if (el.emptySamples) {
    el.emptySamples.addEventListener('click', () => {
      const samples = sampleThreads();
      const existing = new Set(state.threads.map((t) => t.id));
      for (const sample of samples) {
        if (!existing.has(sample.id)) state.threads.push(sample);
      }
      save();
      render();
    });
  }

  if (el.back) el.back.addEventListener('click', backToList);
  if (el.rename) el.rename.addEventListener('click', beginRename);
  if (el.remove) el.remove.addEventListener('click', deleteActiveThread);

  if (el.composer) {
    el.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      sendMessage();
    });
  }

  if (el.input) {
    el.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    el.input.addEventListener('focus', () => toggleEmojiPanel(false));
  }

  if (el.attach) {
    el.attach.addEventListener('click', () => el.file && el.file.click());
  }

  if (el.file) {
    el.file.addEventListener('change', () => {
      const file = el.file.files && el.file.files[0];
      if (!file) return;
      state.attachment = { name: file.name, size: file.size };
      renderAttachmentChip();
      el.file.value = '';
    });
  }

  if (el.chipRemove) {
    el.chipRemove.addEventListener('click', () => {
      state.attachment = null;
      renderAttachmentChip();
    });
  }

  if (el.emoji) {
    el.emoji.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleEmojiPanel();
    });
  }

  if (el.emojiPanel) {
    el.emojiPanel.replaceChildren();
    for (const emoji of EMOJI_PALETTE) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'msg-emoji';
      button.textContent = emoji;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        insertEmoji(emoji);
      });
      el.emojiPanel.append(button);
    }
  }

  document.addEventListener('click', (event) => {
    if (!el.emojiPanel || el.emojiPanel.hidden) return;
    if (el.emojiPanel.contains(event.target) || (el.emoji && el.emoji.contains(event.target))) return;
    toggleEmojiPanel(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (el.emojiPanel && !el.emojiPanel.hidden) {
      toggleEmojiPanel(false);
      return;
    }
    if (state.view === 'thread' && el.messenger && !el.messenger.hidden) {
      backToList();
    }
  });
}

/**
 * Initialise the Messages section. Safe to call repeatedly — it only wires
 * the listeners once.
 */
export function initMessages() {
  if (!el) {
    cacheElements();
    load();
    wire();
  }
  render();
}

/**
 * Called by app.js when the user switches away from Messages.
 */
export function leaveMessages() {
  toggleEmojiPanel(false);
}
