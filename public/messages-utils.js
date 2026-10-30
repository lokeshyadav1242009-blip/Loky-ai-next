/**
 * LOKY AI Next — DOM-free helpers for the Messages section.
 *
 * Same pattern as chat-utils.js: pure JavaScript with no DOM and no storage
 * access, so the behaviour that matters (normalisation, persistence shape,
 * search, ordering, the demo seed) can be unit tested in Node.
 *
 * Storage: localStorage under `loky.ai.next.messages.v1` — a key that is
 * separate from the AI assistant history (`loky.ai.next.v1`) so the two
 * features can never overwrite each other. Everything stays on this device;
 * nothing is uploaded, shared or sent to a server.
 *
 * No dependencies. No secrets.
 */

import { newId, sanitizeTitle } from './chat-utils.js';

export const MESSAGES_STORAGE_KEY = 'loky.ai.next.messages.v1';
export const MAX_THREADS = 60;
export const MAX_MESSAGES_PER_THREAD = 200;
export const MAX_MESSAGE_LENGTH = 2000;
export const DEFAULT_THREAD_NAME = 'New conversation';

/** Avatar colours (dark-theme friendly, WhatsApp-ish muted tones). */
export const AVATAR_COLORS = [
  '#8b7bff',
  '#22d3ee',
  '#4ade80',
  '#ffc46b',
  '#ff8fa3',
  '#7dd3fc',
  '#c4b5fd',
  '#fb923c',
];

/** Emoji offered by the picker. Deliberately small and dependency-free. */
export const EMOJI_PALETTE = [
  '😀', '😂', '🥲', '😊', '😍', '😎', '🤔', '🙃',
  '😇', '🥳', '😴', '🤝', '👍', '👏', '🙏', '💪',
  '🔥', '✨', '🎉', '❤️', '💜', '💯', '✅', '❌',
  '⚡', '📌', '📎', '📷', '🎧', '☕', '🍕', '🐶',
  '🐱', '🚀', '💡', '⭐', '🌙', '☀️', '🏁', '🧠',
];

/* --------------------------------- ids ---------------------------------- */

/** Unique-enough id for a conversation thread. */
export function createThreadId() {
  return `m_${newId()}`;
}

/* -------------------------------- avatars -------------------------------- */

/**
 * Up to two initials for a contact / conversation name.
 */
export function initialsFor(name) {
  const clean = String(name ?? '').trim();
  if (!clean) return '?';
  const parts = clean.split(/\s+/).filter(Boolean).slice(0, 2);
  const letters = parts
    .map((part) => Array.from(part)[0] ?? '')
    .join('')
    .toUpperCase();
  return letters || '?';
}

/**
 * Deterministic avatar colour for a seed string (usually the contact name),
 * so the same contact always gets the same colour.
 */
export function avatarColorFor(seed) {
  const text = String(seed ?? '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/* -------------------------------- threads ------------------------------- */

/**
 * Create an empty (user started) conversation.
 */
export function createThread(name, now = Date.now()) {
  const clean = sanitizeTitle(name, DEFAULT_THREAD_NAME);
  return {
    id: createThreadId(),
    name: clean,
    avatarSeed: clean,
    demo: false,
    unread: 0,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function normalizeMessage(raw, now) {
  if (!raw || typeof raw !== 'object') return null;

  const direction = raw.direction === 'out' ? 'out' : 'in';
  const text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_MESSAGE_LENGTH) : '';
  const attachment =
    raw.attachment && typeof raw.attachment.name === 'string' && raw.attachment.name
      ? {
          name: String(raw.attachment.name).slice(0, 120),
          size: Number(raw.attachment.size) > 0 ? Number(raw.attachment.size) : 0,
        }
      : null;

  if (!text && !attachment) return null;

  const at = Number(raw.at);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `msg_${now}`,
    direction,
    text,
    at: Number.isFinite(at) && at > 0 ? at : now,
    attachment,
  };
}

/**
 * Validate + repair threads read back from localStorage so a corrupted or
 * hand-edited payload can never crash the UI.
 */
export function normalizeThreads(raw) {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const out = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.id !== 'string' || !item.id) continue;

    const messages = Array.isArray(item.messages)
      ? item.messages
          .map((m) => normalizeMessage(m, now))
          .filter(Boolean)
          .slice(-MAX_MESSAGES_PER_THREAD)
      : [];

    const createdAt = Number(item.createdAt) > 0 ? Number(item.createdAt) : now;
    const updatedAt = Number(item.updatedAt) > 0 ? Number(item.updatedAt) : createdAt;

    out.push({
      id: item.id,
      name: sanitizeTitle(item.name, DEFAULT_THREAD_NAME),
      avatarSeed:
        typeof item.avatarSeed === 'string' && item.avatarSeed ? item.avatarSeed : String(item.name ?? ''),
      demo: Boolean(item.demo),
      unread: Math.max(0, Math.min(999, Number(item.unread) || 0)),
      createdAt,
      updatedAt,
      // A locally-written thread has no remoteId. Only a server-backed
      // conversation carries one; anything else is treated as local.
      remoteId: typeof item.remoteId === 'string' && item.remoteId ? item.remoteId : null,
      remoteUserId: typeof item.remoteUserId === 'string' && item.remoteUserId ? item.remoteUserId : null,
      remoteUsername:
        typeof item.remoteUsername === 'string' && item.remoteUsername ? item.remoteUsername : null,
      messages,
    });
  }

  return out;
}

/**
 * Serialize only the fields we want to persist. Never stores anything else
 * (and never an API key).
 */
export function serializeThreads(threads, activeId = null) {
  const list = Array.isArray(threads) ? threads : [];
  return JSON.stringify({
    activeId: typeof activeId === 'string' && activeId ? activeId : null,
    threads: list.slice(0, MAX_THREADS).map((t) => ({
      id: t.id,
      name: t.name,
      avatarSeed: t.avatarSeed,
      demo: Boolean(t.demo),
      unread: Number(t.unread) || 0,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      messages: (Array.isArray(t.messages) ? t.messages : [])
        .slice(-MAX_MESSAGES_PER_THREAD)
        .map((m) => ({
          id: m.id,
          direction: m.direction === 'out' ? 'out' : 'in',
          text: m.text,
          at: m.at,
          attachment: m.attachment
            ? { name: m.attachment.name, size: m.attachment.size }
            : null,
        })),
    })),
  });
}

/* -------------------------------- ordering ------------------------------- */

/** Newest activity first. Does not mutate the input. */
export function sortThreads(threads) {
  const list = Array.isArray(threads) ? threads : [];
  return [...list].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

/* --------------------------------- search -------------------------------- */

/**
 * Does a thread match the search query? Matches the conversation name and
 * the text of every message in it.
 */
export function threadMatches(thread, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  if (!thread) return false;

  if (String(thread.name ?? '').toLowerCase().includes(q)) return true;

  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  return messages.some((m) => String(m?.text ?? '').toLowerCase().includes(q));
}

/**
 * Search + order conversations for the chat list.
 */
export function filterThreads(threads, query) {
  const list = Array.isArray(threads) ? threads : [];
  return sortThreads(list.filter((t) => threadMatches(t, query)));
}

/* -------------------------------- preview -------------------------------- */

/**
 * One-line preview of the last message in a conversation.
 */
export function threadPreview(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  if (!messages.length) return 'No messages yet';

  const last = messages[messages.length - 1];
  const body =
    last.attachment && !last.text ? `Attachment: ${last.attachment.name}` : String(last.text ?? '');
  return last.direction === 'out' ? `You: ${body}` : body;
}

/**
 * Clock time for a message bubble, e.g. "14:05".
 */
export function formatClockTime(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Human friendly size for an attachment, e.g. "248 KB".
 */
export function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------- demo seed ------------------------------- */

/**
 * Sample conversations used for the demo. These are NOT real conversations:
 * the contacts are fictional and every message is clearly marked as sample
 * content by the `demo` flag, which the UI renders as a "Sample" badge.
 */
export function sampleThreads(now = Date.now()) {
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;

  const seeds = [
    {
      id: 'demo_aarav',
      name: 'Aarav Mehta',
      unread: 2,
      updatedAt: now - 4 * min,
      messages: [
        { direction: 'in', text: 'Hey! Are we still on for the design review tomorrow?', at: now - 26 * min },
        { direction: 'out', text: 'Yes — 10:30 works for me. I will send the updated mockups before that.', at: now - 22 * min },
        { direction: 'in', text: 'Perfect. Mainly interested in the mobile layout and dark theme contrast.', at: now - 4 * min },
      ],
    },
    {
      id: 'demo_priya',
      name: 'Priya Nair',
      unread: 1,
      updatedAt: now - 52 * min,
      messages: [
        { direction: 'in', text: 'Can you share the API integration notes when you have a minute?', at: now - 61 * min },
        { direction: 'out', text: 'Sure, I will drop them in the shared folder tonight.', at: now - 58 * min },
        { direction: 'in', text: 'Thank you!', at: now - 52 * min },
      ],
    },
    {
      id: 'demo_rohan',
      name: 'Rohan Kapoor',
      unread: 0,
      updatedAt: now - 5 * hour,
      messages: [
        { direction: 'out', text: 'Sent the deployment checklist — all green so far.', at: now - 5 * hour - 8 * min },
        { direction: 'in', text: 'Great, I will run through it this evening.', at: now - 5 * hour },
      ],
    },
    {
      id: 'demo_sneha',
      name: 'Sneha Iyer',
      unread: 3,
      updatedAt: now - 26 * hour,
      messages: [
        { direction: 'in', text: 'Loved the new streaming animation.', at: now - 28 * hour },
        { direction: 'in', text: 'It feels so much faster on my phone now.', at: now - 27 * hour },
        { direction: 'in', text: 'Sending you the screen recording later.', at: now - 26 * hour },
      ],
    },
    {
      id: 'demo_vikram',
      name: 'Vikram Singh',
      unread: 0,
      updatedAt: now - 3 * day,
      messages: [
        { direction: 'in', text: 'Reminder: retro moved to Friday.', at: now - 3 * day },
        { direction: 'out', text: 'Noted, thanks.', at: now - 3 * day + 6 * min },
      ],
    },
  ];

  return seeds.map((seed) => ({
    id: seed.id,
    name: seed.name,
    avatarSeed: seed.name,
    demo: true,
    unread: seed.unread,
    createdAt: seed.updatedAt - day,
    updatedAt: seed.updatedAt,
    messages: seed.messages.map((m, i) => ({
      id: `${seed.id}_m${i}`,
      direction: m.direction,
      text: m.text,
      at: m.at,
      attachment: null,
    })),
  }));
}
