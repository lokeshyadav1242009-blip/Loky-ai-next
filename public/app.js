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
import { leaveMessages } from './messages.js';
import { open as openConnect, close as closeConnect } from './connect.js';
import { initProfileUI } from './direct-messages.js';
import { initAuthGate, isUnlocked, openAuthGate } from './auth-gate.js';
import { initFriendsUI } from './friends-ui.js';
import { initAdminUI } from './admin-ui.js';
import { EXIT_HINT, closeLayer, initBackNav, openLayer, resetLayers } from './back-nav.js';
import { clearLocalSession, getAccessToken, refreshAccessToken } from './supabase-client.js';
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_PAYLOAD_CHARS,
  buildImagePayload,
  dataUrlToInline,
  hasImages,
  mimeLabel,
  planDownscale,
  selectImages,
} from './chat-images.js';
import { extractMath, isLongAnswer, mathTokenPattern } from './rich-text.js';
import {
  CONTINUED_NOTICE,
  DEFAULT_CONTEXT_BUDGET,
  buildSummaryPayload,
  continuationLabel,
  continuationRecord,
  planContext,
} from './chat-context.js';
import { initMemoryUI, openMemory, resetMemory } from './memory-ui.js';
import { sectionVisibility } from './section-visibility.js';


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
  previews: document.getElementById('composerPreviews'),
  attach: document.getElementById('composerAttach'),
  file: document.getElementById('composerFile'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  stopBtn: document.getElementById('stopBtn'),
  modelChip: document.getElementById('modelChip'),
  template: document.getElementById('messageTemplate'),
  intro: document.getElementById('intro'),
  aboutBtn: document.getElementById('aboutBtn'),
  aboutDialog: document.getElementById('aboutDialog'),
  aboutClose: document.getElementById('aboutClose'),
  navAssistant: document.getElementById('navAssistant'),
  navMessages: document.getElementById('navMessages'),
  appShell: document.getElementById('appShell'),
  messenger: document.getElementById('messenger'),
  memory: document.getElementById('memory'),
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
  notice: null,
  noticeDismissedFor: null,
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

/* -------------------------------------------------------------------------- */
/* Rich response rendering                                                    */
/* -------------------------------------------------------------------------- */
/* KaTeX is loaded lazily so a missing vendor build degrades to plain TeX
   instead of breaking the whole module graph. */

let katexPromise = null;

function loadKatex() {
  if (!katexPromise) {
    katexPromise = (async () => {
      for (const spec of ['./vendor/katex/katex.mjs', './vendor/katex/katex.min.js']) {
        try {
          const mod = await import(spec);
          const lib = mod.default ?? mod;
          if (typeof lib?.renderToString === 'function') return lib;
        } catch {
          /* try the next build */
        }
      }
      return null;
    })();
  }
  return katexPromise;
}

/**
 * Replace maths placeholders with rendered maths.
 *
 * Runs *after* Markdown and DOMPurify: KaTeX's own markup never passes through
 * the purifier (which would strip its inline styles), and the surrounding text
 * is already sanitised.
 */
function paintMath(container, math) {
  if (!math || math.length === 0) return;
  const pattern = mathTokenPattern();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    pattern.lastIndex = 0;
    if (node.nodeValue && pattern.test(node.nodeValue)) targets.push(node);
  }
  if (targets.length === 0) return;

  const build = (tex, display) => {
    const wrap = document.createElement(display ? 'div' : 'span');
    wrap.className = display ? 'math math--block' : 'math math--inline';
    wrap.dataset.tex = tex;

    const lib = katexLib;
    let rendered = false;
    if (lib) {
      try {
        const html = lib.renderToString(tex, {
          displayMode: display,
          throwOnError: false,
          strict: false,
          trust: false,
          output: 'html',
        });
        wrap.innerHTML = html;
        rendered = true;
      } catch {
        rendered = false;
      }
    }
    if (!rendered) {
      const fallback = document.createElement('code');
      fallback.className = 'math__fallback';
      fallback.textContent = tex;
      wrap.append(fallback);
    }

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'math__copy';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy this equation');
    copy.addEventListener('click', async (event) => {
      event.stopPropagation();
      const ok = await copyText(display ? `$$${tex}$$` : `$${tex}$`);
      copy.textContent = ok ? 'Copied' : 'Failed';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });

    const holder = document.createElement(display ? 'div' : 'span');
    holder.className = display ? 'math__holder math__holder--block' : 'math__holder';
    holder.append(wrap, copy);
    return holder;
  };

  for (const node of targets) {
    const fragment = document.createDocumentFragment();
    const text = node.nodeValue;
    let cursor = 0;
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > cursor) fragment.append(document.createTextNode(text.slice(cursor, match.index)));
      const entry = math[Number(match[1])];
      if (entry) fragment.append(build(entry.tex, entry.display));
      else fragment.append(document.createTextNode(match[0]));
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }
}

/** Collapse very long answers behind an explicit expand control. */
function decorateLongAnswer(container) {
  const text = container.textContent || '';
  if (!isLongAnswer(text)) return;
  container.classList.add('rich--long');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rich__expand';
  btn.textContent = 'Show full answer';
  btn.addEventListener('click', () => {
    const expanded = container.classList.toggle('rich--expanded');
    btn.textContent = expanded ? 'Show less' : 'Show full answer';
  });
  container.append(btn);
}

/** One entry point for every assistant answer, live or replayed from history. */
function renderRich(element, markdown) {
  const { text, math } = extractMath(markdown || '');
  element.innerHTML = renderMarkdown(text);
  decorateCodeBlocks(element);
  decorateLongAnswer(element);
  if (math.length) {
    if (katexLib) {
      paintMath(element, math);
    } else {
      loadKatex().then((lib) => {
        katexLib = lib;
        paintMath(element, math);
      });
    }
  }
}

let katexLib = null;

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
    <div class="hero__lockup">
      <div class="hero__mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none">
          <path d="M12 2.5 4 7v10l8 4.5 8-4.5V7l-8-4.5Z" stroke="url(#hg)" stroke-width="1.5" stroke-linejoin="round" />
          <path d="M12 8.2v7.6M8.4 10.2v3.6M15.6 10.2v3.6" stroke="url(#hg)" stroke-width="1.5" stroke-linecap="round" />
          <defs><linearGradient id="hg" x1="4" y1="3" x2="20" y2="21">
            <stop stop-color="#19e68c" /><stop offset="1" stop-color="#34d399" />
          </linearGradient></defs>
        </svg>
      </div>
      <div class="hero__brand">
        <span class="hero__wordmark">LOKY AI</span>
        <span class="hero__credit">Created by <strong>Lokesh Yadav</strong></span>
      </div>
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

/**
 * Pictures attached to a user message, rendered inside its bubble.
 * Only validated inline data URLs reach here (see chat-utils.normalizeImages),
 * so `src` can never be arbitrary markup.
 */
function buildMessageImages(images) {
  const wrap = document.createElement('div');
  wrap.className = 'msg__images';
  for (const image of images) {
    const inline = dataUrlToInline(image?.dataUrl);
    if (!inline) continue;
    const figure = document.createElement('figure');
    figure.className = 'msg__image';
    const img = document.createElement('img');
    img.src = image.dataUrl;
    img.alt = image.name ? `Attached image: ${image.name}` : 'Attached image';
    img.loading = 'lazy';
    img.decoding = 'async';
    figure.append(img);
    const caption = document.createElement('figcaption');
    caption.textContent = `${mimeLabel(inline.mimeType)} · ${image.name || 'image'}`;
    figure.append(caption);
    wrap.append(figure);
  }
  return wrap;
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
    // Pictures first, then the question about them. An image-only message has no
    // text at all, so the empty body is dropped rather than left as a blank line.
    const images = Array.isArray(message.images) ? message.images : [];
    if (images.length) content.append(buildMessageImages(images));
    if (message.content) body.textContent = message.content;
    else body.hidden = true;
  } else if (message.error) {
    body.textContent = message.content;
  } else {
    body.className = 'md';
    renderRich(body, message.content);
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

function renderMessages({ animateLastIndex = -1 } = {}) {
  el.messages.replaceChildren();
  const inner = document.createElement('div');
  inner.className = 'messages__inner';

  const conversation = activeConversation();
  const messages = conversation?.messages ?? [];

  el.chatTitle.textContent = conversation?.title ?? 'New chat';

  // A split conversation must never be silent: show where it came from (or
  // where it continued) with a link straight to the other half.
  const continuation = buildContinuationBanner(conversation);
  if (continuation) inner.append(continuation);

  if (messages.length === 0) {
    inner.append(buildHero());
  } else {
    messages.forEach((message, index) => {
      const { article } = buildMessageElement(message, index);
      // Only the message that just arrived animates in - replayed history
      // must not re-run the entry animation.
      if (index === animateLastIndex) article.classList.add('msg--enter');
      inner.append(article);
    });
  }

  el.messages.append(inner);
  renderNotice();
  scrollToBottom(true);
}

/* -------------------------------------------------------------------------- */
/* Infinite chat: rolling summary + continuation                              */
/* -------------------------------------------------------------------------- */

/** Token budget the server advertises, so both sides agree on the limit. */
function contextBudget() {
  const limit = Number(state.health?.limits?.contextTokens);
  return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_CONTEXT_BUDGET;
}

/**
 * Banner at the top of a conversation that was split, linking the two halves.
 * Returns null when the chat has no continuation relationship.
 */
function buildContinuationBanner(conversation) {
  const label = continuationLabel(conversation);
  if (!label) return null;

  const wrap = document.createElement('div');
  wrap.className = 'chat-continuation';
  wrap.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.textContent = label;
  wrap.append(text);

  const targetId = conversation.continuedFrom || conversation.continuedTo;
  const target = state.conversations.find((item) => item.id === targetId);
  if (target) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'chat-continuation__link';
    link.textContent = conversation.continuedFrom ? 'Open original chat' : 'Open continuation';
    link.addEventListener('click', () => selectConversation(target.id));
    wrap.append(link);
  }
  return wrap;
}

/**
 * Move the user into the continuation chat when they next write, so messages
 * are never appended to the older, over-budget half.
 */
function followContinuation() {
  const current = activeConversation();
  if (!current?.continuedTo) return;
  const next = state.conversations.find((item) => item.id === current.continuedTo);
  if (!next) return;
  state.activeId = next.id;
  if (typeof renderHistory === 'function') renderHistory();
  renderMessages();
}

/** Fold the due turns into a rolling summary (server-side, key stays server-side). */
async function refreshSummary(conversation) {
  const payload = buildSummaryPayload(conversation);
  if (!payload) return false;

  const headers = { 'Content-Type': 'application/json' };
  const token = await currentAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch('/api/summarize', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload.body),
  });
  if (!response.ok) return false;

  const data = await response.json().catch(() => null);
  if (!data || typeof data.summary !== 'string' || !data.summary.trim()) return false;

  conversation.summary = data.summary.trim();
  conversation.summaryUpTo = payload.upTo;
  conversation.updatedAt = Date.now();
  saveState();
  return true;
}

/**
 * Keep a long conversation usable: summarise older turns, then continue in a
 * new chat that inherits that summary. Best-effort by design — a failure here
 * must never break the reply the user just received.
 */
async function maintainContext(conversation) {
  try {
    let plan = planContext(conversation, contextBudget());

    if (plan.needsSummary) {
      const saved = await refreshSummary(conversation);
      if (!saved) return;
      plan = planContext(conversation, contextBudget());
    }

    if (!plan.needsContinuation) return;

    const record = continuationRecord({
      previous: conversation,
      id: newId(),
      summary: conversation.summary,
    });
    conversation.continuedTo = record.id;
    conversation.updatedAt = Date.now();
    state.conversations.unshift(record);
    saveState();
    if (typeof renderHistory === 'function') renderHistory();
    toast(CONTINUED_NOTICE);
  } catch {
    /* context upkeep is best-effort: never surface as a chat failure */
  }
}

function scrollToBottom(force = false) {
  const nearBottom =
    el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 140;
  if (force || nearBottom) {
    el.messages.scrollTop = el.messages.scrollHeight;
  }
}

/* -------------------------------------------------------------------------- */
/* In-chat notice (used to be a banner box above the composer)                */
/* -------------------------------------------------------------------------- */

/**
 * Show a notice inside the conversation area (above the messages, below the
 * top bar) so the composer area stays clean.
 */
function showNotice({ tone = 'warn', text, hint = '' }, { sticky = false } = {}) {
  if (!sticky && state.noticeDismissedFor === text) return;
  const same =
    state.notice &&
    state.notice.text === text &&
    state.notice.hint === hint &&
    state.notice.tone === tone;
  state.notice = { tone, text, hint };
  if (!same) renderNotice();
}

/** Remove the notice from the conversation area. */
function hideNotice() {
  state.notice = null;
  renderNotice();
}

/** Render (or clear) the current notice inside the messages column. */
function renderNotice() {
  for (const node of el.messages.querySelectorAll('.notice')) node.remove();
  if (!state.notice) return;

  const inner = el.messages.querySelector('.messages__inner') ?? el.messages;
  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.dataset.tone = state.notice.tone;
  notice.setAttribute('role', 'status');

  const body = document.createElement('div');
  body.className = 'notice__body';

  const text = document.createElement('p');
  text.className = 'notice__text';
  text.textContent = state.notice.text;
  body.append(text);

  if (state.notice.hint) {
    const hint = document.createElement('p');
    hint.className = 'notice__hint';
    hint.textContent = state.notice.hint;
    body.append(hint);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn icon-btn--sm notice__close';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>';
  close.addEventListener('click', () => {
    state.noticeDismissedFor = state.notice?.text ?? null;
    hideNotice();
  });

  notice.append(body, close);
  inner.prepend(notice);
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
      hideNotice();
    } else {
      el.modelChip.textContent = 'AI not configured';
      el.modelChip.classList.add('is-error');
      setStatus('error');
      showNotice(
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
    showNotice(
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
 * The signed-in user's access token, or '' when there is none.
 *
 * The token — not the browser's "I look logged in" state — is what the server
 * verifies. A deployment without Supabase configured has no session to read
 * and requireAuth lets it through, so an empty token is legitimate there.
 */
async function currentAccessToken() {
  try {
    return await getAccessToken();
  } catch {
    return '';
  }
}

function chatRequest(token, messages, signal, summary) {
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  // Without this header the server sees an anonymous caller and answers
  // auth_required, which is the "Sign in to use this feature." failure.
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch('/api/chat', {
    method: 'POST',
    headers,
    // The rolling summary rides BESIDE `messages`: it is context for the
    // model, never a turn the user actually wrote.
    body: JSON.stringify(summary ? { messages, summary } : { messages }),
    signal,
  });
}

function networkFailure(signal) {
  return {
    code: 'network_error',
    message: 'Could not reach the server. Check your internet connection and try again.',
    hint: 'If you are running locally, make sure `npm start` is still running.',
    retryable: true,
  };
}

/**
 * POST the conversation and stream the reply.
 * @returns {Promise<{text: string, aborted: boolean}>}
 */
async function streamChat(messages, { onDelta, onMeta, signal, summary }) {
  let response;
  try {
    response = await chatRequest(await currentAccessToken(), messages, signal, summary);
  } catch (error) {
    if (signal?.aborted) return { text: '', aborted: true };
    throw networkFailure(signal);
  }

  // A stored session can look valid in the browser after the server has
  // already expired or revoked it. Refresh exactly once and retry, instead of
  // bouncing the user to the login screen on the first 401.
  if (response.status === 401) {
    let refreshed = '';
    try {
      refreshed = await refreshAccessToken();
    } catch {
      refreshed = '';
    }

    if (refreshed) {
      try {
        response = await chatRequest(refreshed, messages, signal, summary);
      } catch (error) {
        if (signal?.aborted) return { text: '', aborted: true };
        throw networkFailure(signal);
      }
    }

    // Still rejected after a fresh token: the session really is gone, so drop
    // it and show the login screen. This is the only path that gates the UI.
    if (response.status === 401) {
      clearLocalSession();
      openAuthGate();
      throw {
        code: 'auth_required',
        message: 'Your session has expired. Please sign in again.',
        hint: '',
        retryable: false,
      };
    }
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
    .filter((m) => !m.error && (m.content.trim() || hasImages(m)))
    .map((m) => {
      // Real bytes, never a filename: the server forwards these as inlineData.
      const images = buildImagePayload(m.images);
      return images.length
        ? { role: m.role, content: m.content, images }
        : { role: m.role, content: m.content };
    });
}

/** Drop the typing indicator as soon as a reply settles (done or failed). */
function clearTyping() {
  document.querySelectorAll('#messages .typing').forEach((node) => node.remove());
}

function setStreamingUI(streaming) {
  state.streaming = streaming;
  if (!streaming) clearTyping();
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

/* -------------------------------------------------------------------------- */
/* Image attachments (AI Assistant composer)                                   */
/* -------------------------------------------------------------------------- */

/** Images staged in the composer but not sent yet. Cleared on every send. */
let pendingImages = [];

function updateAttachState() {
  if (!el.attach) return;
  const full = pendingImages.length >= MAX_IMAGES_PER_MESSAGE;
  el.attach.disabled = full;
  el.attach.classList.toggle('is-full', full);
  el.attach.title = full
    ? `Up to ${MAX_IMAGES_PER_MESSAGE} images per message`
    : 'Attach images (JPG, PNG, WEBP)';
}

/** Paint the staged previews; the strip is hidden when nothing is attached. */
function renderImagePreviews() {
  if (!el.previews) return;
  el.previews.replaceChildren();
  el.previews.hidden = pendingImages.length === 0;
  if (pendingImages.length === 0) return;

  pendingImages.forEach((image, index) => {
    const card = document.createElement('div');
    card.className = 'preview';
    card.dataset.state = image.state;

    const thumb = document.createElement('img');
    thumb.className = 'preview__img';
    thumb.src = image.dataUrl || image.previewUrl || '';
    thumb.alt = image.name ? `Attached image ${image.name}` : 'Attached image';
    card.append(thumb);

    if (image.state !== 'ready') {
      const state = document.createElement('span');
      state.className = 'preview__state';
      state.textContent = image.state === 'error' ? 'Failed' : 'Preparing…';
      card.append(state);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'preview__remove';
    remove.setAttribute('aria-label', `Remove ${image.name || 'image'}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => removeImage(index));
    card.append(remove);

    el.previews.append(card);
  });
}

function removeImage(index) {
  const [removed] = pendingImages.splice(index, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  renderImagePreviews();
  updateAttachState();
}

function clearPendingImages() {
  for (const image of pendingImages) {
    if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
  }
  pendingImages = [];
  renderImagePreviews();
  updateAttachState();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}

/**
 * Downscale + re-encode so a 12 MP phone photo still fits the payload cap.
 * Falls back to the raw data URL when the browser cannot decode bitmaps.
 */
async function shrinkImage(file, mimeType) {
  if (typeof createImageBitmap !== 'function') return readAsDataUrl(file);
  const bitmap = await createImageBitmap(file);
  try {
    const plan = planDownscale(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return readAsDataUrl(file);
    ctx.drawImage(bitmap, 0, 0, plan.width, plan.height);

    // PNG keeps crisp screenshots/text; photos re-encode smaller as JPEG.
    let dataUrl = canvas.toDataURL(mimeType === 'image/png' ? 'image/png' : 'image/jpeg', 0.9);
    if (dataUrl.length > MAX_PAYLOAD_CHARS) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    }
    if (dataUrl.length > MAX_PAYLOAD_CHARS) throw new Error('too_large');
    return dataUrl;
  } finally {
    bitmap.close?.();
  }
}

/** Validate, stage and prepare picked/dropped/pasted files. */
async function addImageFiles(fileList) {
  const { accepted, errors } = selectImages(fileList, pendingImages.length);

  if (errors.length) {
    showNotice({
      tone: 'error',
      text: errors[0],
      hint: errors.length > 1 ? `${errors.length - 1} more file(s) were skipped.` : '',
    });
  }
  if (accepted.length === 0) return;
  if (!errors.length) hideNotice();

  const staged = accepted.map(({ file, mimeType }) => {
    const entry = {
      name: file.name || 'pasted-image',
      mimeType,
      state: 'loading',
      previewUrl: URL.createObjectURL(file),
      dataUrl: '',
    };
    pendingImages.push(entry);
    return { file, mimeType, entry };
  });
  renderImagePreviews();
  updateAttachState();

  for (const { file, mimeType, entry } of staged) {
    try {
      entry.dataUrl = await shrinkImage(file, mimeType);
      entry.mimeType = dataUrlToInline(entry.dataUrl)?.mimeType ?? mimeType;
      entry.state = 'ready';
    } catch {
      entry.state = 'error';
    }
    renderImagePreviews();
  }

  if (pendingImages.some((image) => image.state === 'error')) {
    showNotice({
      tone: 'error',
      text: 'One image could not be prepared.',
      hint: 'Try a JPG, PNG or WEBP file under 8 MB.',
    });
  }
}

/** Ctrl+V / ⌘V: paste a screenshot straight into the composer. */
function handlePaste(event) {
  const items = event.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === 'file' && String(item.type).startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) {
    event.preventDefault();
    addImageFiles(files);
  }
}

/** Drag-and-drop onto the composer. */
function wireDropZone() {
  const zone = el.composer?.closest('.composer-wrap') ?? el.composer;
  if (!zone) return;

  const carriesFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

  zone.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    zone.classList.add('is-dropping');
  });

  zone.addEventListener('dragleave', (event) => {
    if (event.relatedTarget && zone.contains(event.relatedTarget)) return;
    zone.classList.remove('is-dropping');
  });

  zone.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove('is-dropping');
    const files = event.dataTransfer?.files;
    if (files?.length) addImageFiles(files);
  });

  // Dropping outside the composer must not navigate away from the app.
  for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, (event) => {
      if (carriesFiles(event)) event.preventDefault();
    });
  }
}

function wireImageInput() {
  if (!el.attach || !el.file) return;
  el.attach.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => {
    if (el.file.files?.length) addImageFiles(el.file.files);
    el.file.value = ''; // picking the same file twice must still work
  });
  el.input.addEventListener('paste', handlePaste);
  wireDropZone();
  updateAttachState();
}

async function submit() {
  if (state.streaming) return;

  // If this chat has already been continued, the next message belongs in the
  // continuation so one conversation keeps a single thread.
  followContinuation();

  const text = el.input.value.trim();
  // Only images that finished downscaling are sendable.
  const images = pendingImages
    .filter((image) => image.state === 'ready' && image.dataUrl)
    .map((image) => ({ name: image.name, mimeType: image.mimeType, dataUrl: image.dataUrl }));
  if (!text && images.length === 0) return;

  const limit = state.health?.limits?.maxInputChars ?? 24000;
  if (text.length > limit) {
    showNotice({
      tone: 'error',
      text: `That message is too long (${text.length.toLocaleString()} characters, limit ${limit.toLocaleString()}).`,
      hint: 'Shorten your message, or split it into several questions.',
    });
    return;
  }

  hideNotice();

  let conversation = activeConversation();
  if (!conversation) conversation = createConversation();

  conversation.messages.push(
    images.length ? { role: 'user', content: text, images } : { role: 'user', content: text },
  );
  if (conversation.title === 'New chat') {
    conversation.title = titleFrom(text || `Image: ${images[0].name}`);
  }
  conversation.updatedAt = Date.now();

  el.input.value = '';
  clearPendingImages();
  autoGrow();
  renderHistory();
  renderMessages({ animateLastIndex: conversation.messages.length - 1 });
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
  article.classList.add('msg--assistant', 'msg--enter');
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
  let lastPainted = null;

  const paint = () => {
    if (renderQueued || latest === lastPainted) return;
    lastPainted = latest;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderRich(md, latest);
      const caret = document.createElement('span');
      caret.className = 'caret';
      md.append(caret);
      scrollToBottom();
    });
  };

  try {
    const result = await streamChat(messages, {
      signal: controller.signal,
      summary: conversation.summary ?? '',
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

    // Long-conversation upkeep runs AFTER the answer is on screen, so it can
    // never delay or interrupt the reply the user is reading.
    maintainContext(conversation);

    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(latest);
      copyBtn.textContent = ok ? 'Copied' : 'Failed';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 1500);
    });

    renderRich(md, latest);
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

    // The failure is shown inline where the answer would be; the status dot
    // in the top bar mirrors it for clarity.
    setStatus('error');
  } finally {
    state.abortController = null;
    setStreamingUI(false);

    // Desktop only: never steal focus after the answer finishes. On phones
    // focusing here pops the soft keyboard back open, which is the bug.
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      el.input.focus();
    }
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
    case 'auth_required':
    case 'auth_invalid':
    case 'signed_out':
      return 'Please sign in again';
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
  openLayer('sidebar', closeSidebar);
}

function closeSidebar() {
  el.sidebar.classList.remove('is-open');
  el.scrim.hidden = true;
  closeLayer('sidebar');
}

/* -------------------------------------------------------------------------- */
/* Intro animation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Plays the opening animation once, on app open only.
 *
 * - Skipped entirely when the user prefers reduced motion.
 * - Never replays on new chat, on conversation switch, or on message send.
 */
function playIntro() {
  const overlay = el.intro;
  if (!overlay) return;

  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) {
    overlay.remove();
    return;
  }

  // Force a reflow so the entry animation always runs from its first frame.
  void overlay.offsetWidth;
  overlay.classList.add('intro--play');

  const finish = () => {
    overlay.classList.remove('intro--play');
    overlay.remove();
  };

  // `animationend` covers the normal path; the timeout is a safety net in
  // case the animation is skipped (e.g. tab hidden during boot).
  overlay.addEventListener('animationend', finish, { once: true });
  window.setTimeout(finish, 2600);
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

/* ------------------------------- section switch --------------------------- */
/* Two sections live in the same page: the AI assistant (default) and the
   WhatsApp-style Messages list. The assistant shell is only hidden — never
   unmounted — so an in-flight stream, the composer and the saved history all
   survive a round trip between the two sections. */

let activeSection = 'assistant';

function setSection(section) {
  const next =
    section === 'messages' ? 'messages' : section === 'memory' ? 'memory' : 'assistant';
  // Route guard: while the gate is locked, no section may be opened — not from
  // a nav click, not from a deep link, not from a leftover hash. The server and
  // RLS enforce this too; this only stops the UI from pretending otherwise.
  if (!isUnlocked()) return;
  if (next === activeSection) return;

  activeSection = next;
  const showMessages = next === 'messages';
  const showMemory = next === 'memory';

  // Messages is its own screen, so it owns a history entry: Back returns to the
  // assistant instead of leaving the app.
  if (showMessages) openLayer('messages', () => setSection('assistant'));
  else closeLayer('messages');

  // Every screen's visibility is owned here and nowhere else. The Memory
  // section used to keep its `hidden` attribute for the life of the page, so
  // whether it appeared at all depended on upgrade.css loading in time: without
  // `.memory { display: block }` the UA `[hidden]` rule won, #appShell was
  // already hidden, and the user got a blank black screen. Toggling both sides
  // explicitly removes that dependency entirely.
  const visible = sectionVisibility(next);
  el.appShell.hidden = !visible.assistant;
  if (el.memory) el.memory.hidden = !visible.memory;
  // The legacy localStorage messenger is retired: the Messages section now
  // renders LOKY CONNECT, which reads real Supabase conversations. The old node
  // stays in the DOM (hidden) so nothing that references it breaks.
  el.messenger.hidden = true;

  el.navAssistant.setAttribute('aria-selected', String(!showMessages));
  el.navMessages.setAttribute('aria-selected', String(showMessages));

  if (showMessages) {
    openConnect();
  } else {
    closeConnect();
    leaveMessages();
  }

  // LOKY MEMORY: its own screen, behind the same auth gate. Nothing is fetched
  // until the section is actually opened.
  if (showMemory) openMemory();
  const memoryNav = document.getElementById('navMemory');
  if (memoryNav) memoryNav.setAttribute('aria-selected', String(showMemory));
  el.navAssistant.setAttribute('aria-selected', String(!showMessages && !showMemory));
}

el.navAssistant.addEventListener('click', () => setSection('assistant'));
el.navMessages.addEventListener('click', () => setSection('messages'));

/* ------------------------------- LOKY MEMORY ------------------------------ */

const navMemoryButton = document.getElementById('navMemory');
const navAssistantButton = el.navAssistant;

if (navMemoryButton) {
  navMemoryButton.addEventListener('click', () => {
    closeSidebar();
    setSection('memory');
  });
}

// The page owns its own data; wire it once and let it fetch on first open.
initMemoryUI();
resetMemory();

// The Memory screen replaces the chat shell, so it carries its own way back.
document.getElementById('memory')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-memory-back]')) setSection('assistant');
});

/* ---------------------------------- about --------------------------------- */

function openAbout() {
  el.aboutDialog.hidden = false;
  openLayer('about', closeAbout);
  el.aboutClose.focus();
}

function closeAbout() {
  el.aboutDialog.hidden = true;
  closeLayer('about');
  el.aboutBtn.focus();
}

el.aboutBtn.addEventListener('click', openAbout);
el.aboutClose.addEventListener('click', closeAbout);
el.aboutDialog.addEventListener('click', (event) => {
  if (event.target === el.aboutDialog || event.target.id === 'aboutBackdrop') closeAbout();
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

/* Safety net: the typing dots must never outlive the streaming state. */
const typingGuard = new MutationObserver(() => {
  if (!state.streaming || el.messages.querySelector('.msg--error')) clearTyping();
});
typingGuard.observe(el.messages, { childList: true, subtree: true, characterData: true });

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

/* Keep the shell in sync with the visual viewport so the composer stays above
   the on-screen keyboard on Android. */
function syncViewportHeight() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${Math.round(height)}px`);
  if (vv) window.scrollTo(0, 0);
}
syncViewportHeight();
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportHeight);
  window.visualViewport.addEventListener('scroll', syncViewportHeight);
}
window.addEventListener('resize', syncViewportHeight);
window.addEventListener('orientationchange', () => {
  window.setTimeout(syncViewportHeight, 150);
});

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
wireImageInput();

/* Android / browser Back: menus, dialogs and an open conversation each own one
   history entry, so Back closes them first. At the root it asks for
   confirmation instead of letting the page disappear on the first press. */
initBackNav({ onHint: (message) => toast(message || EXIT_HINT) });

/* Signing out must not leave a signed-in section or panel reachable by Back. */
window.addEventListener('loky:auth-changed', (event) => {
  const signedIn = event && event.detail ? event.detail.signedIn : undefined;
  if (signedIn === false || !isUnlocked()) resetLayers();
});

/* Account state is page-wide, not a Messages-only detail: restore any stored
   session and paint the nav chip + profile here, before the user opens
   Messages. Failures stay local to the chip/dialog and never block the chat. */
initProfileUI({ openMessages: () => setSection('messages') });

/* Friend requests + admin dashboard. The Admin nav entry is revealed only after
   the server confirms profiles.is_admin, and the API enforces it regardless of
   what the browser shows. */
initFriendsUI({
  openChatWith: (person) => {
    setSection('messages');
    window.dispatchEvent(new CustomEvent('loky:message-user', { detail: { person } }));
  },
});
const adminUI = initAdminUI();

/* The auth gate is the outermost boundary: until it unlocks, the assistant and
   Messages stay behind it. Signing in lands on the assistant; signing out drops
   straight back to the sign-in screen.

   The admin dashboard is told about the session here, directly. It used to
   depend on a `loky:auth-changed` event, but the only code that dispatched one
   was the sign-out path, so a signed-in visit to /admin never got verified and
   fell through to the assistant. Calling syncAdmin() avoids that gap, and
   avoids re-entering the gate (whose own listener re-runs checkSession on a
   signed-in event). */
initAuthGate({
  onUnlocked: () => {
    setSection('assistant');
    adminUI?.syncAdmin?.({ signedIn: true }).catch(() => {});
  },
  onLocked: () => {
    setSection('assistant');
    adminUI?.syncAdmin?.({ signedIn: false }).catch(() => {});
  },
});

// Opening animation — app open only, never on new chat / conversation switch.
playIntro();

// Health is best-effort: a failing check must never block the chat UI.
try {
  await checkHealth();
} catch {
  /* the composer still works; request errors surface per message */
}

// Only grab focus where a physical keyboard is expected (never on mobile).
if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
  el.input.focus();
}
