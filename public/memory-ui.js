/**
 * LOKY MEMORY — the Memory page.
 *
 * Rendered entirely from live Supabase rows via /api/memories. There is no
 * sample data anywhere in this file: an empty account shows an empty state.
 *
 * Layout: switch + composer at the top, then category cards with live counts,
 * then search/filter, then the saved notes themselves with inline edit and a
 * two-step delete (no browser confirm dialogs — the app must never pop one).
 */

import { getAccessToken, refreshAccessToken } from './supabase-client.js';
import {
  CATEGORY_META,
  MAX_CONTENT_CHARS,
  MAX_MEMORIES_PER_USER,
  countByCategory,
  filterMemories,
  findDuplicate,
  sortMemories,
  validateMemory,
} from './memory-model.js';

const state = {
  loaded: false,
  loading: false,
  configured: true,
  enabled: true,
  memories: [],
  query: '',
  category: 'all',
  editingId: null,
  pendingDeleteId: null,
  error: '',
  notice: '',
  busy: false,
};

let root = null;
let onCount = null;

/* --------------------------------- network -------------------------------- */

async function api(path, { method = 'GET', body } = {}) {
  const call = async (token) =>
    fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let token = '';
  try {
    token = await getAccessToken();
  } catch {
    token = '';
  }

  let response = await call(token);
  if (response.status === 401) {
    // An almost-expired token is normal; refresh once, then give up.
    try {
      token = await refreshAccessToken();
      response = await call(token);
    } catch {
      /* fall through to the error below */
    }
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error?.message || 'Memory storage is unavailable right now.');
    error.code = data?.error?.code || 'memory_error';
    error.status = response.status;
    throw error;
  }
  return data;
}

/* ---------------------------------- view ---------------------------------- */

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label, className, onClick) {
  const element = node('button', className, label);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function visibleMemories() {
  return sortMemories(filterMemories(state.memories, { query: state.query, category: state.category }));
}

function notify(message) {
  state.notice = message;
  render();
  if (message) {
    setTimeout(() => {
      if (state.notice === message) {
        state.notice = '';
        render();
      }
    }, 3200);
  }
}

/* --------------------------------- actions -------------------------------- */

async function load() {
  state.loading = true;
  state.error = '';
  render();
  try {
    const data = await api('/api/memories');
    state.memories = Array.isArray(data?.memories) ? data.memories : [];
    state.enabled = data?.enabled !== false;
    state.configured = data?.configured !== false;
    state.loaded = true;
  } catch (error) {
    state.error = error.message;
    state.loaded = true;
  } finally {
    state.loading = false;
    render();
    reportCount();
  }
}

async function toggleEnabled(next) {
  state.enabled = next;
  state.busy = true;
  render();
  try {
    const data = await api('/api/memory-settings', { method: 'PATCH', body: { enabled: next } });
    state.enabled = data?.enabled !== false;
    notify(state.enabled ? 'Memory is on.' : 'Memory is off — nothing will be sent to the AI.');
  } catch (error) {
    state.enabled = !next;
    notify(error.message);
  } finally {
    state.busy = false;
    render();
  }
}

async function saveNew(content, category) {
  const checked = validateMemory({ content, category });
  if (!checked.ok) {
    notify(checked.error);
    return false;
  }

  const duplicate = findDuplicate(state.memories, checked.value.content);
  if (duplicate) {
    notify('You already saved that.');
    return false;
  }

  state.busy = true;
  render();
  try {
    const data = await api('/api/memories', {
      method: 'POST',
      body: { content: checked.value.content, category: checked.value.category, source: 'manual' },
    });
    if (data?.memory) state.memories = [data.memory, ...state.memories];
    notify('Saved to memory.');
    reportCount();
    return true;
  } catch (error) {
    notify(error.message);
    return false;
  } finally {
    state.busy = false;
    render();
  }
}

async function saveEdit(id, content, category) {
  const checked = validateMemory({ content, category });
  if (!checked.ok) {
    notify(checked.error);
    return false;
  }
  const duplicate = findDuplicate(state.memories, checked.value.content, id);
  if (duplicate) {
    notify('You already saved that.');
    return false;
  }

  state.busy = true;
  render();
  try {
    const data = await api(`/api/memories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { content: checked.value.content, category: checked.value.category },
    });
    if (data?.memory) {
      state.memories = state.memories.map((m) => (m.id === id ? data.memory : m));
    }
    state.editingId = null;
    notify('Memory updated.');
    return true;
  } catch (error) {
    notify(error.message);
    return false;
  } finally {
    state.busy = false;
    render();
  }
}

async function removeMemory(id) {
  state.busy = true;
  render();
  try {
    await api(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.memories = state.memories.filter((m) => m.id !== id);
    state.pendingDeleteId = null;
    notify('Memory deleted.');
    reportCount();
  } catch (error) {
    notify(error.message);
  } finally {
    state.busy = false;
    render();
  }
}

async function togglePin(memory) {
  try {
    const data = await api(`/api/memories/${encodeURIComponent(memory.id)}`, {
      method: 'PATCH',
      body: { pinned: !memory.pinned },
    });
    if (data?.memory) {
      state.memories = state.memories.map((m) => (m.id === memory.id ? data.memory : m));
    }
    render();
  } catch (error) {
    notify(error.message);
  }
}

function reportCount() {
  if (typeof onCount === 'function') onCount(state.memories.length, state.enabled);
}

/* --------------------------------- render --------------------------------- */

function renderHeader() {
  const header = node('header', 'memory__head');

  const titles = node('div', 'memory__titles');
  const back = node('button', 'memory__back', '\u2190 Chat');
  back.type = 'button';
  back.dataset.memoryBack = 'true';
  back.setAttribute('aria-label', 'Back to the AI assistant');
  titles.append(
    node('h2', 'memory__title', 'LOKY MEMORY'),
    node('p', 'memory__sub', 'Facts you have shared, so the assistant can pick up where you left off.'),
  );

  const toggleWrap = node('label', 'memory__toggle');
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = state.enabled;
  toggle.id = 'memoryEnabled';
  toggle.disabled = state.busy || !state.configured;
  toggle.addEventListener('change', () => toggleEnabled(toggle.checked));
  const track = node('span', 'memory__toggle-track');
  const text = node('span', 'memory__toggle-text', state.enabled ? 'Memory on' : 'Memory off');
  toggleWrap.append(toggle, track, text);
  toggleWrap.title = 'When off, no memories are sent to the AI.';

  header.append(back, titles, toggleWrap);
  return header;
}

function renderComposer() {
  const form = node('form', 'memory__composer');

  const input = document.createElement('textarea');
  input.className = 'memory__input';
  input.id = 'memoryInput';
  input.rows = 2;
  input.maxLength = MAX_CONTENT_CHARS;
  input.placeholder = 'Something to remember — e.g. “I am preparing for JEE and prefer step-by-step maths”.';
  input.disabled = state.busy || !state.configured;

  const controls = node('div', 'memory__composer-row');

  const select = document.createElement('select');
  select.className = 'memory__select';
  select.id = 'memoryCategory';
  select.disabled = state.busy || !state.configured;
  for (const key of Object.keys(CATEGORY_META)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = CATEGORY_META[key].label;
    select.append(option);
  }

  const save = button('Save memory', 'memory__save', async () => {
    const ok = await saveNew(input.value, select.value);
    if (ok) {
      input.value = '';
      input.focus();
    }
  });
  save.disabled = state.busy || !state.configured;

  controls.append(select, save);
  form.append(input, controls);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save.click();
  });

  return form;
}

function renderCards() {
  const counts = countByCategory(state.memories);
  const wrap = node('div', 'memory__cards');

  for (const key of Object.keys(CATEGORY_META)) {
    const meta = CATEGORY_META[key];
    const card = node('button', 'memory__card');
    card.type = 'button';
    card.classList.toggle('is-active', state.category === key);
    card.append(
      node('span', 'memory__card-icon', meta.icon || '•'),
      node('span', 'memory__card-label', meta.label),
      node('span', 'memory__card-count', String(counts[key] || 0)),
    );
    card.addEventListener('click', () => {
      state.category = state.category === key ? 'all' : key;
      render();
    });
    wrap.append(card);
  }

  const all = node('button', 'memory__card memory__card--all');
  all.type = 'button';
  all.classList.toggle('is-active', state.category === 'all');
  all.append(
    node('span', 'memory__card-icon', '★'),
    node('span', 'memory__card-label', 'All'),
    node('span', 'memory__card-count', String(state.memories.length)),
  );
  all.addEventListener('click', () => {
    state.category = 'all';
    render();
  });
  wrap.prepend(all);

  return wrap;
}

function renderFilters() {
  const bar = node('div', 'memory__filters');

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'memory__search';
  search.id = 'memorySearch';
  search.placeholder = 'Search your memories…';
  search.value = state.query;
  search.addEventListener('input', () => {
    state.query = search.value;
    renderList();
  });

  const meta = node(
    'p',
    'memory__meta',
    `${state.memories.length} of ${MAX_MEMORIES_PER_USER} saved`,
  );

  bar.append(search, meta);
  return bar;
}

function renderCardItem(memory) {
  const item = node('article', 'memory__item');
  item.dataset.id = memory.id;
  if (memory.pinned) item.classList.add('is-pinned');

  if (state.editingId === memory.id) {
    const form = node('form', 'memory__edit');

    const input = document.createElement('textarea');
    input.className = 'memory__input';
    input.rows = 2;
    input.maxLength = MAX_CONTENT_CHARS;
    input.value = memory.content;

    const select = document.createElement('select');
    select.className = 'memory__select';
    for (const key of Object.keys(CATEGORY_META)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = CATEGORY_META[key].label;
      option.selected = key === memory.category;
      select.append(option);
    }

    const actions = node('div', 'memory__item-actions');
    actions.append(
      button('Save', 'memory__save', () => saveEdit(memory.id, input.value, select.value)),
      button(
        'Cancel',
        'memory__ghost',
        () => {
          state.editingId = null;
          render();
        },
      ),
    );

    form.append(input, select, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveEdit(memory.id, input.value, select.value);
    });
    item.append(form);
    return item;
  }

  const meta = node('div', 'memory__item-meta');
  const badge = node('span', `memory__badge memory__badge--${memory.category}`,
    CATEGORY_META[memory.category]?.label || 'Personal');
  meta.append(badge, node('span', 'memory__date', formatDate(memory.updated_at || memory.created_at)));

  const text = node('p', 'memory__item-text', memory.content);

  const actions = node('div', 'memory__item-actions');

  if (state.pendingDeleteId === memory.id) {
    actions.append(
      node('span', 'memory__confirm', 'Delete this?'),
      button('Yes, delete', 'memory__danger', () => removeMemory(memory.id)),
      button(
        'Keep',
        'memory__ghost',
        () => {
          state.pendingDeleteId = null;
          render();
        },
      ),
    );
  } else {
    actions.append(
      button(
        memory.pinned ? 'Unpin' : 'Pin',
        'memory__ghost',
        () => togglePin(memory),
      ),
      button(
        'Edit',
        'memory__ghost',
        () => {
          state.editingId = memory.id;
          state.pendingDeleteId = null;
          render();
        },
      ),
      button(
        'Delete',
        'memory__ghost memory__ghost--danger',
        () => {
          state.pendingDeleteId = memory.id;
          state.editingId = null;
          render();
        },
      ),
    );
  }

  item.append(meta, text, actions);
  return item;
}

function renderList() {
  const list = root.querySelector('.memory__list');
  if (!list) return;
  list.replaceChildren();

  const items = visibleMemories();
  if (items.length === 0) {
    const empty = node('div', 'memory__empty');
    if (!state.configured) {
      empty.append(
        node('p', 'memory__empty-title', 'Memory needs Supabase'),
        node('p', 'memory__empty-text',
          'Add SUPABASE_URL and SUPABASE_ANON_KEY to this deployment to store memories. Nothing is being saved or sent right now.'),
      );
    } else if (state.memories.length === 0) {
      empty.append(
        node('p', 'memory__empty-title', 'Nothing saved yet'),
        node('p', 'memory__empty-text',
          'Add a note above — a preference, an exam you are preparing for, or a project you are building. Only relevant notes are shared with the AI.'),
      );
    } else {
      empty.append(
        node('p', 'memory__empty-title', 'No matches'),
        node('p', 'memory__empty-text', 'Try a different word or pick another category.'),
      );
    }
    list.append(empty);
    return;
  }

  for (const memory of items) list.append(renderCardItem(memory));
}

function render() {
  if (!root) return;
  root.replaceChildren();

  const shell = node('div', 'memory__shell');
  shell.append(renderHeader());

  if (!state.enabled && state.configured) {
    shell.append(
      node('p', 'memory__banner',
        'Memory is off. Your saved notes stay here, but none of them are sent to the AI.'),
    );
  }

  if (state.configured) shell.append(renderComposer());
  shell.append(renderCards(), renderFilters());

  if (state.error) {
    const errorBox = node('p', 'memory__banner memory__banner--error', state.error);
    errorBox.append(
      button('Retry', 'memory__ghost', () => load()),
    );
    shell.append(errorBox);
  }

  const list = node('div', 'memory__list');
  shell.append(list);

  if (state.notice) shell.append(node('p', 'memory__notice', state.notice));
  if (state.loading && !state.loaded) shell.append(node('p', 'memory__meta', 'Loading your memories…'));

  root.append(shell);
  renderList();
}

/* --------------------------------- public --------------------------------- */

/** Wire the section once. `countHook` updates a nav badge, if the app has one. */
export function initMemoryUI({ countHook } = {}) {
  root = document.getElementById('memory');
  if (!root) return false;
  onCount = countHook;
  return true;
}

/** Called every time the Memory section is opened. */
export function openMemory() {
  if (!root) return;
  if (!state.loaded && !state.loading) {
    load();
  } else {
    render();
  }
}

/** Reload after a sign-in/sign-out so another account never sees stale rows. */
export function resetMemory() {
  state.loaded = false;
  state.memories = [];
  state.enabled = true;
  state.query = '';
  state.category = 'all';
  state.editingId = null;
  state.pendingDeleteId = null;
  state.error = '';
  state.notice = '';
  if (root) render();
}

export const memoryState = state;
