/**
 * LOKY AI Next — browser client.
 *
 * Responsibilities:
 *  - stream answers from POST /api/chat (Server-Sent Events over fetch)
 *  - render Markdown + code blocks safely (marked + DOMPurify, vendored locally)
 *  - keep conversation history in localStorage
 *  - surface friendly, specific errors for auth / rate limit / outage
 *
 * The AI API key never reaches this file: the browser only talks to our own
 * server, which attaches the key server-side.
 */

import { marked } from './vendor/marked.esm.js';
import {
  DEFAULT_TITLE,
  MAX_STORED_CONVERSATIONS,
  STORAGE_KEY,
  formatRelativeTime,
  formatTimestampLabel,
  newId,
  normalizeConversations,
  sanitizeTitle,
  serializeConversations,
  titleFrom,
} from './chat-utils.js';

const HEALTH_REFRESH_MS = 60000;
const HISTORY_REFRESH_MS = 60000;

/* -------------------------------------------------------------------------- */
/* DOM references                                                             */
/* -------------------------------------------------------------------------- */

const el = {
  sidebar: document.getElementById('sidebar'),
  scrim: document.getElementById('scrim'),
  openSidebar: document.getElementById('openSidebar'),
  closeSidebar: document.getElementById('closeSidebar'),
  newChat: document.getElementById('newChat'),
  newChatTop: document.getElementById('newChatTop'),
  exportAll: document.getElementById('exportAll'),
  clearAll: document.getElementById('clearAll'),
  historyList: document.getElementById('historyList'),
  historyEmpty: document.getElementById('historyEmpty'),
  chatTitle: document.getElementById('chatTitle'),
  statusDot: document.getElementById('statusDot'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  stopBtn: document.getElementById('stopBtn'),
  modelChip: document.getElementById('modelChip'),
  template: document.getElementById('messageTemplate'),
  intro: document.getElementById('intro'),
  aboutBtn: document.getElementById('aboutBtn'),
  aboutDialog: document.getElementById('aboutDialog'),
  aboutClose: document.getElementById('aboutClose'),
};

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

const state = {
  conversations: [],
  activeId: null,
  streaming: false,
  abortController: null,
  health: null,
  bannerDismissedFor: null,
  renamingId: null,
};

/* -------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* -------------------------------------------------------------------------- */

let purifier = null;
try {
  // Optional: if the vendor bundle is missing we fall back to escaped text.
  const mod = await import('./vendor/purify.esm.js');
  purifier = mod.default ?? mod.DOMPurify ?? null;
} catch {
  purifier = null;
}

marked.setOptions({
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false,
});

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 'del', 'ins', 'u', 'sub', 'sup', 'mark', 'small',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'span', 'div',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'a', 'img',
];

/** Escape text so it is safe to drop into innerHTML. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Markdown -> sanitised HTML string. */
export function renderMarkdown(source) {
  const text = typeof source === 'string' ? source : '';
  if (!purifier) {
    // Graceful degradation: readable plain text instead of raw HTML.
    return `<p>${escapeHtml(text).replace(/\n/g, '<br />')}</p>`;
  }
  try {
    const html = marked.parse(text);
    return purifier.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR: ['href', 'title', 'lang', 'class', 'target', 'rel'],
      ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input'],
      FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
    });
  } catch {
    return `<p>${escapeHtml(text)}</p>`;
  }
}

/** Replace `pre > code` blocks with a labelled block that has a copy button. */
function decorateCodeBlocks(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    if (!code || pre.closest('.code-block')) return;

    const lang =
      (code.className.match(/language-([\w+-]+)/)?.[1] || code.dataset.lang || 'code').toLowerCase();

    const block = document.createElement('div');
    block.className = 'code-block';

    const bar = document.createElement('div');
    bar.className = 'code-block__bar';

    const label = document.createElement('span');
    label.className = 'code-block__lang';
    label.textContent = lang;

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'code-block__copy';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      const ok = await copyText(code.innerText);
      copy.textContent = ok ? 'Copied' : 'Failed';
      copy.classList.toggle('is-done', ok);
      setTimeout(() => {
        copy.textContent = 'Copy';
        copy.classList.remove('is-done');
      }, 1600);
    });

    bar.append(label, copy);
    pre.replaceWith(block);
    block.append(bar, pre);
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts / older browsers.
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    state.conversations = normalizeConversations(parsed.conversations);
    state.activeId = typeof parsed.activeId === 'string' ? parsed.activeId : null;
  } catch {
    // Corrupt or unavailable storage: start clean rather than break the app.
    state.conversations = [];
    state.activeId = null;
  }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, serializeConversations(state.conversations, state.activeId));
    } catch {
      // Quota exceeded (very long history) - trim oldest and retry once.
      try {
        state.conversations = state.conversations.slice(0, 10);
        localStorage.setItem(
          STORAGE_KEY,
          serializeConversations(state.conversations, state.activeId),
        );
        toast('Storage was full — older chats were trimmed.');
      } catch {
        /* give up silently */
      }
    }
  }, 180);
}

/* -------------------------------------------------------------------------- */
/* Conversation helpers                                                       */
/* -------------------------------------------------------------------------- */

function activeConversation() {
  return state.conversations.find((c) => c.id === state.activeId) ?? null;
}

function createConversation() {
  const conversation = {
    id: newId(),
    title: DEFAULT_TITLE,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  if (state.conversations.length > MAX_STORED_CONVERSATIONS) {
    state.conversations.length = MAX_STORED_CONVERSATIONS;
  }
  return conversation;
}

function sortConversations() {
  state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
}

/* -------------------------------------------------------------------------- */
/* Rendering — sidebar                                                        */
/* -------------------------------------------------------------------------- */

function renderHistory() {
  el.historyList.replaceChildren();
  sortConversations();

  const conversations = state.conversations.filter((c) => c.messages.length > 0);
  el.historyEmpty.hidden = conversations.length > 0;

  for (const conversation of conversations) {
    const li = document.createElement('li');
    li.className = 'history__item';
    li.dataset.id = conversation.id;
    if (conversation.id === state.activeId) li.classList.add('is-active');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history__btn';
    btn.title = `${conversation.title} — ${formatTimestampLabel(conversation.updatedAt)}`;
    btn.innerHTML = `<svg class="history__icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M20 15.5A2.5 2.5 0 0 1 17.5 18H8l-4 3V6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v9Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

    const text = document.createElement('span');
    text.className = 'history__text';

    const title = document.createElement('span');
    title.className = 'history__title';
    title.textContent = conversation.title;

    const time = document.createElement('span');
    time.className = 'history__time';
    time.textContent = formatRelativeTime(conversation.updatedAt);
    const stamp = Number(conversation.updatedAt);
    if (Number.isFinite(stamp) && stamp > 0) {
      time.dateTime = new Date(stamp).toISOString();
    }

    text.append(title, time);
    btn.append(text);
    btn.addEventListener('click', () => selectConversation(conversation.id));

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'history__rename';
    rename.setAttribute('aria-label', `Rename "${conversation.title}"`);
    rename.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4.5 19.5h3.2L19 8.2a2.26 2.26 0 0 0-3.2-3.2L4.5 16.3v3.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    rename.addEventListener('click', (event) => {
      event.stopPropagation();
      beginRename(conversation.id);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history__del';
    del.setAttribute('aria-label', `Delete "${conversation.title}"`);
    del.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 7h12M9 7V5h6v2m-7 0 .7 12h6.6L16 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteConversation(conversation.id);
    });

    li.append(btn, rename, del);
    el.historyList.append(li);
  }
}

/** Find a history row by conversation id without relying on CSS.escape. */
function findHistoryItem(id) {
  const rows = el.historyList.querySelectorAll('li[data-id]');
  for (const row of rows) {
    if (row.dataset.id === id) return row;
  }
  return null;
}

/**
 * Turn a history row into an inline editor.
 * Enter / blur commits, Escape cancels.
 */
function beginRename(id) {
  if (state.renamingId) return;
  const conversation = state.conversations.find((c) => c.id === id);
  if (!conversation) return;

  const row = findHistoryItem(id);
  if (!row) return;
  const textWrap = row.querySelector('.history__text');
  if (!textWrap) return;

  state.renamingId = id;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'history__input';
  input.value = conversation.title;
  input.maxLength = 80;
  input.setAttribute('aria-label', `Rename "${conversation.title}"`);

  textWrap.replaceChildren(input);
  row.classList.add('is-editing');

  let settled = false;
  const finish = (commit) => {
    if (settled) return;
    settled = true;
    state.renamingId = null;

    if (commit) {
      const next = sanitizeTitle(input.value, conversation.title);
      if (next !== conversation.title) {
        conversation.title = next;
        // Renaming deliberately leaves updatedAt alone so the list does not
        // reorder while the user is editing it.
        saveState();
        if (conversation.id === state.activeId) el.chatTitle.textContent = next;
      }
    }

    renderHistory();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));

  input.focus();
  input.select();
}

/** Update only the relative timestamps, leaving the DOM (and any rename) alone. */
function refreshHistoryTimes() {
  for (const row of el.historyList.querySelectorAll('li[data-id]')) {
    const conversation = state.conversations.find((c) => c.id === row.dataset.id);
    if (!conversation) continue;
    const time = row.querySelector('.history__time');
    if (time) time.textContent = formatRelativeTime(conversation.updatedAt);
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering — messages                                                       */
/* -------------------------------------------------------------------------- */

function buildHero() {
  const hero = document.createElement('div');
  hero.className = 'hero';
  hero.innerHTML = `
    <div class="hero__mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none">
        <path d="M12 2.5 4 7v10l8 4.5 8-4.5V7l-8-4.5Z" stroke="url(#hg)" stroke-width="1.5" stroke-linejoin="round" />
        <path d="M12 8.2v7.6M8.4 10.2v3.6M15.6 10.2v3.6" stroke="url(#hg)" stroke-width="1.5" stroke-linecap="round" />
        <defs><linearGradient id="hg" x1="4" y1="3" x2="20" y2="21">
          <stop stop-color="#8b7bff" /><stop offset="1" stop-color="#22d3ee" />
        </linearGradient></defs>
      </svg>
    </div>
    <h1 class="hero__title">How can I help you today?</h1>
    <p class="hero__sub">
      LOKY AI Next streams answers in real time, understands Markdown and code, and keeps your
      conversations in this browser.
    </p>
    <div class="starters" role="list"></div>
  `;

  const starters = [
    { emoji: '✦', text: 'Explain async/await in JavaScript with an example' },
    { emoji: '⌘', text: 'Write a SQL query to find the top 5 customers by revenue' },
    { emoji: '◈', text: 'Draft a short product announcement for a new feature' },
    { emoji: '☰', text: 'Compare REST and GraphQL for a mobile app' },
  ];

  const wrap = hero.querySelector('.starters');
  for (const starter of starters) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'starter';
    btn.setAttribute('role', 'listitem');
    btn.innerHTML = `<span class="starter__emoji" aria-hidden="true">${starter.emoji}</span><span>${escapeHtml(
      starter.text,
    )}</span>`;
    btn.addEventListener('click', () => {
      el.input.value = starter.text;
      autoGrow();
      submit();
    });
    wrap.append(btn);
  }
  return hero;
}

function buildMessageElement(message, index) {
  const fragment = el.template.content.cloneNode(true);
  const article = fragment.querySelector('.msg');
  const isUser = message.role === 'user';

  article.classList.add(isUser ? 'msg--user' : 'msg--assistant');
  if (message.error) article.classList.add('msg--error');
  article.dataset.index = String(index);

  article.querySelector('.msg__avatar').textContent = isUser ? 'You' : 'AI';
  article.querySelector('.msg__author').textContent = isUser ? 'You' : 'LOKY AI Next';

  const content = article.querySelector('.msg__content');
  const body = document.createElement('div');

  if (isUser) {
    body.textContent = message.content;
  } else if (message.error) {
    body.textContent = message.content;
  } else {
    body.className = 'md';
    body.innerHTML = renderMarkdown(message.content);
    decorateCodeBlocks(body);
  }
  content.append(body);

  const copyBtn = article.querySelector('.msg__copy');
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(message.content);
    copyBtn.textContent = ok ? 'Copied' : 'Failed';
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
    }, 1500);
  });

  return { article, content, body };
}

function renderMessages() {
  el.messages.replaceChildren();
  const inner = document.createElement('div');
  inner.className = 'messages__inner';

  const conversation = activeConversation();
  const messages = conversation?.messages ?? [];

  el.chatTitle.textContent = conversation?.title ?? 'New chat';

  if (messages.length === 0) {
    inner.append(buildHero());
  } else {
    messages.forEach((message, index) => {
      const { article } = buildMessageElement(message, index);
      inner.append(article);
    });
  }

  el.messages.append(inner);
  scrollToBottom(true);
}

function scrollToBottom(force = false) {
  const nearBottom =
    el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 140;
  if (force || nearBottom) {
    el.messages.scrollTop = el.messages.scrollHeight;
  }
}

/* -------------------------------------------------------------------------- */
/* Banner + toast                                                             */
/* -------------------------------------------------------------------------- */

function showBanner({ tone = 'warn', text, hint = '' }, { sticky = false } = {}) {
  if (!sticky && state.bannerDismissedFor === text) return;
  el.banner.hidden = false;
  el.banner.dataset.tone = tone;
  el.bannerText.textContent = text;
  el.bannerHint.hidden = !hint;
  el.bannerHint.textContent = hint;
}

function hideBanner() {
  el.banner.hidden = true;
}

let toastTimer = null;
function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('role', 'status');
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 2400);
}

/* -------------------------------------------------------------------------- */
/* Health / status                                                            */
/* -------------------------------------------------------------------------- */

function setStatus(status) {
  el.statusDot.classList.remove('is-ready', 'is-busy', 'is-error');
  if (status === 'ready') el.statusDot.classList.add('is-ready');
  if (status === 'busy') el.statusDot.classList.add('is-busy');
  if (status === 'error') el.statusDot.classList.add('is-error');
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health', { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => null);
    state.health = data;

    if (data?.configured) {
      el.modelChip.textContent = `${data.provider} · ${data.model}`;
      el.modelChip.classList.remove('is-error');
      setStatus(state.streaming ? 'busy' : 'ready');
      hideBanner();
    } else {
      el.modelChip.textContent = 'AI not configured';
      el.modelChip.classList.add('is-error');
      setStatus('error');
      showBanner(
        {
          tone: 'error',
          text: 'The AI service is not configured on this server yet.',
          hint: data?.missing?.length
            ? `Add ${data.missing.join(' and ')} to the server environment, then restart. See README.md.`
            : 'Set the provider environment variables and restart the server. See README.md.',
        },
        { sticky: true },
      );
    }
    return data;
  } catch {
    state.health = null;
    el.modelChip.textContent = 'Offline';
    el.modelChip.classList.add('is-error');
    setStatus('error');
    showBanner(
      {
        tone: 'error',
        text: 'Cannot reach the LOKY AI Next server.',
        hint: 'Check your connection, then reload the page.',
      },
      { sticky: true },
    );
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Chat transport                                                             */
/* -------------------------------------------------------------------------- */

function normalizeError(payload, status) {
  const base = payload?.error ?? payload ?? {};
  return {
    code: base.code ?? `http_${status}`,
    message:
      typeof base.message === 'string' && base.message
        ? base.message
        : `The server responded with status ${status}.`,
    hint: typeof base.hint === 'string' ? base.hint : '',
    retryAfter: Number(base.retryAfter) || null,
    retryable: base.retryable !== false,
  };
}

/**
 * POST the conversation and stream the reply.
 * @returns {Promise<{text: string, aborted: boolean}>}
 */
async function streamChat(messages, { onDelta, onMeta, signal }) {
  let response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ messages }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) return { text: '', aborted: true };
    throw {
      code: 'network_error',
      message: 'Could not reach the server. Check your internet connection and try again.',
      hint: 'If you are running locally, make sure `npm start` is still running.',
      retryable: true,
    };
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw normalizeError(payload, response.status);
  }

  if (!response.body) {
    throw {
      code: 'no_stream',
      message: 'Your browser could not open a streaming connection.',
      hint: 'Try a different browser, or disable extensions that block streaming responses.',
      retryable: true,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let streamError = null;
  let meta = null;

  const handleFrame = (frame) => {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue; // ignores ": ping" heartbeats
      const raw = line.slice(5).trim();
      if (!raw) continue;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      if (event.type === 'delta' && typeof event.text === 'string') {
        text += event.text;
        onDelta?.(text);
      } else if (event.type === 'meta') {
        meta = event;
        onMeta?.(event);
      } else if (event.type === 'error') {
        streamError = event;
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handleFrame(frame);
        index = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    if (signal?.aborted) return { text, aborted: true };
    throw {
      code: 'stream_interrupted',
      message: 'The connection dropped while the answer was streaming.',
      hint: 'Check your network and try again.',
      retryable: true,
    };
  }

  if (streamError) {
    throw normalizeError({ error: streamError }, 500);
  }

  return { text, aborted: false, meta };
}

/* -------------------------------------------------------------------------- */
/* Sending a message                                                          */
/* -------------------------------------------------------------------------- */

function buildPayloadMessages(conversation) {
  return conversation.messages
    .filter((m) => !m.error && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
}

function setStreamingUI(streaming) {
  state.streaming = streaming;
  els_setDisabled(streaming);
  el.send.classList.toggle('is-streaming', streaming);
  el.send.setAttribute('aria-label', streaming ? 'Stop generating' : 'Send message');
  el.stopBtn.hidden = !streaming;
  setStatus(streaming ? 'busy' : state.health?.configured ? 'ready' : 'error');
}

function els_setDisabled(streaming) {
  el.send.disabled = false; // the button turns into "stop" while streaming
  el.send.title = streaming ? 'Stop generating' : 'Send';
}

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 190)}px`;
}

async function submit() {
  if (state.streaming) return;

  const text = el.input.value.trim();
  if (!text) return;

  const limit = state.health?.limits?.maxInputChars ?? 24000;
  if (text.length > limit) {
    showBanner(
      {
        tone: 'error',
        text: `That message is too long (${text.length.toLocaleString()} characters, limit ${limit.toLocaleString()}).`,
        hint: 'Shorten your message, or split it into several questions.',
      },
      { sticky: true },
    );
    return;
  }

  hideBanner();

  let conversation = activeConversation();
  if (!conversation) conversation = createConversation();

  conversation.messages.push({ role: 'user', content: text });
  if (conversation.title === 'New chat') conversation.title = titleFrom(text);
  conversation.updatedAt = Date.now();

  el.input.value = '';
  autoGrow();
  renderHistory();
  renderMessages();
  saveState();

  await requestReply(conversation);
}

async function requestReply(conversation) {
  const messages = buildPayloadMessages(conversation);
  if (messages.length === 0) return;

  // Placeholder assistant bubble with typing indicator.
  const inner = el.messages.querySelector('.messages__inner') ?? el.messages;
  const placeholder = el.template.content.cloneNode(true);
  const article = placeholder.querySelector('.msg');
  article.classList.add('msg--assistant');
  article.querySelector('.msg__avatar').textContent = 'AI';
  article.querySelector('.msg__author').textContent = 'LOKY AI Next';
  const copyBtn = article.querySelector('.msg__copy');
  copyBtn.hidden = true;

  const content = article.querySelector('.msg__content');
  const md = document.createElement('div');
  md.className = 'md';
  md.innerHTML = '<span class="typing" aria-label="Generating answer"><i></i><i></i><i></i></span>';
  content.append(md);
  inner.append(article);
  scrollToBottom(true);

  const controller = new AbortController();
  state.abortController = controller;
  setStreamingUI(true);

  let renderQueued = false;
  let latest = '';

  const paint = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      md.innerHTML = renderMarkdown(latest);
      decorateCodeBlocks(md);
      const caret = document.createElement('span');
      caret.className = 'caret';
      md.append(caret);
      scrollToBottom();
    });
  };

  try {
    const result = await streamChat(messages, {
      signal: controller.signal,
      onDelta: (text) => {
        latest = text;
        paint();
      },
    });

    latest = result.text;

    if (result.aborted && !latest) {
      article.remove();
      return;
    }

    if (!latest) {
      throw {
        code: 'empty_answer',
        message: 'The AI returned an empty answer.',
        hint: 'Try asking again, or rephrase your question.',
        retryable: true,
      };
    }

    conversation.messages.push({ role: 'assistant', content: latest });
    conversation.updatedAt = Date.now();
    copyBtn.hidden = false;

    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(latest);
      copyBtn.textContent = ok ? 'Copied' : 'Failed';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 1500);
    });

    md.innerHTML = renderMarkdown(latest);
    decorateCodeBlocks(md);
    if (result.aborted) {
      const note = document.createElement('p');
      note.style.cssText = 'margin:6px 0 0;font-size:.72rem;color:var(--text-faint);';
      note.textContent = '(stopped)';
      content.append(note);
    }
    renderHistory();
    saveState();
  } catch (error) {
    const info = error?.code
      ? error
      : {
          code: 'internal_error',
          message: 'Something went wrong. Please try again.',
          hint: '',
          retryable: true,
        };

    if (info.code === 'aborted') {
      article.remove();
      return;
    }

    // Show the failure inline where the answer would be, plus a retry action.
    article.classList.add('msg--error');
    md.replaceChildren();
    const title = document.createElement('p');
    title.style.cssText = 'margin:0;font-weight:600;';
    title.textContent = errorTitle(info.code);
    const detail = document.createElement('p');
    detail.style.cssText = 'margin:6px 0 0;font-size:.86rem;';
    detail.textContent = info.message;
    md.append(title, detail);

    if (info.hint) {
      const hint = document.createElement('p');
      hint.style.cssText = 'margin:6px 0 0;font-size:.78rem;opacity:.8;';
      hint.textContent = info.hint;
      md.append(hint);
    }

    if (info.retryable !== false) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn--ghost msg__retry';
      retry.style.marginTop = '10px';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => {
        article.remove();
        requestReply(conversation);
      });
      content.append(retry);
    }

    // The inline bubble carries the detail; the banner mirrors it for clarity.
    showBanner(
      { tone: 'error', text: errorTitle(info.code), hint: info.message },
      { sticky: true },
    );
    setStatus('error');
  } finally {
    state.abortController = null;
    setStreamingUI(false);
    el.input.focus();
  }
}

function errorTitle(code) {
  switch (code) {
    case 'rate_limited':
      return 'Too many requests';
    case 'upstream_rate_limited':
      return 'The AI provider is rate-limiting requests';
    case 'ai_not_configured':
      return 'AI service not configured';
    case 'upstream_auth_failed':
      return 'AI service rejected the API key';
    case 'upstream_unavailable':
      return 'AI service unavailable';
    case 'upstream_timeout':
      return 'AI service timed out';
    case 'payload_too_large':
      return 'Conversation too long';
    case 'bad_request':
      return 'Invalid request';
    case 'network_error':
      return 'Connection problem';
    default:
      return 'Something went wrong';
  }
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

function selectConversation(id) {
  if (state.streaming) {
    state.abortController?.abort();
  }
  state.activeId = id;
  renderHistory();
  renderMessages();
  saveState();
  closeSidebar();
}

function deleteConversation(id) {
  const index = state.conversations.findIndex((c) => c.id === id);
  if (index === -1) return;
  const [removed] = state.conversations.splice(index, 1);
  if (state.activeId === id) {
    state.activeId = state.conversations[0]?.id ?? null;
    renderMessages();
  }
  renderHistory();
  saveState();
  toast(`Deleted "${removed.title}"`);
}

function startNewChat() {
  if (state.streaming) {
    state.abortController?.abort();
  }
 overNext: {
    // Reuse an existing empty conversation instead of piling up blanks.
    const empty = state.conversations.find((c) => c.messages.length === 0);
    if (empty) {
      state.activeId = empty.id;
      break overNext;
    }
    createConversation();
  }
  renderHistory();
  renderMessages();
  saveState();
  closeSidebar();
  el.input.value = '';
  autoGrow();
  el.input.focus();
}

function exportAll() {
  const conversations = state.conversations.filter((c) => c.messages.length > 0);
  if (conversations.length === 0) {
    toast('Nothing to export yet.');
    return;
  }
  const parts = [`# LOKY AI Next — chat export`, `Exported ${new Date().toLocaleString()}`, ''];
  for (const conversation of conversations) {
    parts.push(`## ${conversation.title}`, `_${new Date(conversation.createdAt).toLocaleString()}_`, '');
    for (const message of conversation.messages) {
      parts.push(`**${message.role === 'user' ? 'You' : 'LOKY AI Next'}:**`, '', message.content, '');
    }
    parts.push('---', '');
  }
  const blob = new Blob([parts.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `loky-ai-next-${new Date().toISOString().slice(0, 10)}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Exported as Markdown.');
}

function clearAll() {
  if (state.conversations.length === 0) {
    toast('History is already empty.');
    return;
  }
  const ok = window.confirm('Delete all conversations stored in this browser? This cannot be undone.');
  if (!ok) return;
  state.conversations = [];
  state.activeId = null;
  renderHistory();
  renderMessages();
  saveState();
  toast('All conversations deleted.');
}

/* -------------------------------------------------------------------------- */
/* Sidebar (mobile)                                                           */
/* -------------------------------------------------------------------------- */

function openSidebar() {
  el.sidebar.classList.add('is-open');
  el.scrim.hidden = false;
}

function closeSidebar() {
  el.sidebar.classList.remove('is-open');
  el.scrim.hidden = true;
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

el.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.streaming) {
    state.abortController?.abort();
    return;
  }
  submit();
});

el.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (state.streaming) {
      state.abortController?.abort();
      return;
    }
    submit();
  }
});

el.input.addEventListener('input', autoGrow);

el.stopBtn.addEventListener('click', () => {
  state.abortController?.abort();
});

el.send.addEventListener('click', (event) => {
  if (state.streaming) {
    event.preventDefault();
    state.abortController?.abort();
  }
});

el.newChat.addEventListener('click', startNewChat);
el.newChatTop.addEventListener('click', startNewChat);
el.exportAll.addEventListener('click', exportAll);
el.clearAll.addEventListener('click', clearAll);
el.openSidebar.addEventListener('click', openSidebar);
el.closeSidebar.addEventListener('click', closeSidebar);
el.scrim.addEventListener('click', closeSidebar);

el.bannerClose.addEventListener('click', () => {
  state.bannerDismissedFor = el.bannerText.textContent;
  hideBanner();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (el.sidebar.classList.contains('is-open')) closeSidebar();
    if (state.streaming) state.abortController?.abort();
  }
  // Cmd/Ctrl+K -> new chat, like most chat apps.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    startNewChat();
  }
});

// Keep history in sync when the server configuration changes.
setInterval(() => {
  if (!state.streaming) checkHealth();
}, HEALTH_REFRESH_MS);

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

loadState();

if (state.activeId && !activeConversation()) {
  state.activeId = state.conversations[0]?.id ?? null;
}

if (!state.activeId && state.conversations.length > 0) {
  state.activeId = state.conversations[0].id;
}

renderHistory();
renderMessages();
autoGrow();
await checkHealth();
el.input.focus();
