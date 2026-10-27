/**
 * LOKY AI Next — DOM-free chat helpers.
 *
 * Everything in this module is pure JavaScript with no DOM / storage access,
 * so the behaviour that matters for the chat-history feature (title handling,
 * timestamps, persistence shape) can be unit tested in Node.
 *
 * No dependencies. No secrets.
 */

export const STORAGE_KEY = 'loky.ai.next.v1';
export const MAX_STORED_CONVERSATIONS = 50;
export const MAX_TITLE_LENGTH = 80;
export const DEFAULT_TITLE = 'New chat';

/* --------------------------------- ids ---------------------------------- */

let idCounter = 0;

/**
 * Unique-enough id for a conversation. Uses crypto when available so ids do
 * not collide across tabs, and falls back to time + counter.
 */
export function newId() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  idCounter = (idCounter + 1) % 100000;
  return `c_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/* -------------------------------- titles -------------------------------- */

/**
 * Normalise a user supplied title: collapse whitespace, trim, drop empties
 * and cap the length. Falls back to `fallback` when nothing usable is left.
 */
export function sanitizeTitle(raw, fallback = DEFAULT_TITLE, maxLength = MAX_TITLE_LENGTH) {
  const clean = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return fallback;
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

/**
 * Derive a chat title from the first user message.
 */
export function titleFrom(text, maxLength = 48) {
  return sanitizeTitle(text, DEFAULT_TITLE, maxLength);
}

/* ------------------------------ timestamps ------------------------------ */

function toTime(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? time : 0;
}

/**
 * Human friendly "when did this happen" label, e.g. "just now", "12m ago",
 * "3h ago", "yesterday", "4d ago", "12 Mar 2025".
 */
export function formatRelativeTime(value, now = Date.now()) {
  const time = toTime(value);
  if (!time) return '';

  const diff = now - time;
  // Clock skew / future timestamps: treat as "just now" rather than "-3m ago".
  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;

  return formatAbsoluteTime(time);
}

/**
 * Calendar date of a timestamp, e.g. "12 Mar 2025".
 */
export function formatAbsoluteTime(value) {
  const time = toTime(value);
  if (!time) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Full locale timestamp, used for tooltips.
 */
export function formatTimestampLabel(value) {
  const time = toTime(value);
  if (!time) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

/* ------------------------------ persistence ----------------------------- */

/**
 * Validate + repair conversations read back from localStorage so a corrupted
 * or hand-edited payload can never crash the app.
 */
export function normalizeConversations(raw) {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const out = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.id !== 'string' || !item.id) continue;
    if (!Array.isArray(item.messages)) continue;

    const createdAt = toTime(item.createdAt) || now;
    const updatedAt = toTime(item.updatedAt) || createdAt;
    const messages = item.messages
      .filter(
        (m) =>
          m &&
          typeof m === 'object' &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string',
      )
      .map((m) => ({
        role: m.role,
        content: m.content,
        error: Boolean(m.error),
      }));

    out.push({
      id: item.id,
      title: sanitizeTitle(item.title, 'Untitled chat'),
      createdAt,
      updatedAt,
      messages,
    });
  }

  return out;
}

/**
 * Serialize only the fields we want to persist — never leak anything else
 * (and never an API key) into storage.
 */
export function serializeConversations(conversations, activeId = null) {
  const list = Array.isArray(conversations) ? conversations : [];
  return JSON.stringify({
    activeId: typeof activeId === 'string' && activeId ? activeId : null,
    conversations: list.slice(0, MAX_STORED_CONVERSATIONS).map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: Array.isArray(c.messages)
        ? c.messages.map((m) => ({
            role: m.role,
            content: m.content,
            error: Boolean(m.error),
          }))
        : [],
    })),
  });
}
