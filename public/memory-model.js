/**
 * LOKY MEMORY — pure rules shared by the browser, the server and the tests.
 *
 * Nothing here touches the DOM, the network or Supabase, so the exact rules
 * that decide "is this storable?", "is this a duplicate?" and "which memories
 * are relevant to this question?" can be unit-tested directly.
 *
 * Used by:
 *   - public/memory-ui.js   (validate + dedupe before saving, search/filter)
 *   - server/memory.js      (re-validate on the server; relevance selection
 *                            before a memory block is added to the prompt)
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

export const MEMORY_CATEGORIES = ['personal', 'study', 'projects', 'preferences'];

export const CATEGORY_META = {
  personal: { label: 'Personal', hint: 'Facts about you — name, city, routine' },
  study: { label: 'Study', hint: 'Subjects, syllabus, exam dates, weak topics' },
  projects: { label: 'Projects', hint: 'Ongoing work and where it stands' },
  preferences: { label: 'Preferences', hint: 'How you like answers, language, tone' },
};

export const MIN_CONTENT_CHARS = 3;
export const MAX_CONTENT_CHARS = 600;
/** Hard ceiling so one account cannot fill the prompt with thousands of rows. */
export const MAX_MEMORIES_PER_USER = 300;
/** How many memories may ever reach the model in one request. */
export const MAX_CONTEXT_MEMORIES = 8;
/** Character budget for the rendered memory block. */
export const MAX_CONTEXT_CHARS = 1200;

/* -------------------------------------------------------------------------- */
/* Normalisation + validation                                                 */
/* -------------------------------------------------------------------------- */

/** Collapse whitespace so "  Likes   tea " and "Likes tea" compare equal. */
export function normaliseContent(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normaliseCategory(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return MEMORY_CATEGORIES.includes(raw) ? raw : 'personal';
}

/**
 * Credential guard. Memory is meant for preferences and project facts, never
 * for secrets, so anything shaped like a key, token or password is refused.
 *
 * This is deliberately conservative: a false positive costs the user one
 * rephrase, a false negative would persist a live credential in a table the
 * user later shares on screen.
 */
const SECRET_PATTERNS = [
  // Provider keys
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bsk_live_[A-Za-z0-9]{8,}/,
  /\bAIza[0-9A-Za-z_-]{20,}/, // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack token
  /\bsb_secret_[A-Za-z0-9_-]{10,}/, // Supabase secret key
  /\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{10,}/, // Stripe-style
  // JWTs — Supabase anon/service keys are JWTs, so this covers them too
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // Private keys / connection strings with embedded passwords
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@/i,
  // Labelled secrets: "password: hunter2", "api key = abc123"
  /\b(?:password|passwd|pwd|passphrase)\b\s*[:=]\s*\S{4,}/i,
  /\b(?:api[_\s-]?key|secret[_\s-]?key|access[_\s-]?token|auth[_\s-]?token|bearer)\b\s*[:=]?\s*\S{12,}/i,
  /\b(?:service[_\s-]?role)\b/i,
];

/**
 * True when the text looks like it contains a credential or secret.
 * @returns {{ secret: boolean, reason?: string }}
 */
export function detectSecret(value) {
  const text = String(value ?? '');
  if (!text) return { secret: false };

  for (const pattern of SECRET_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // Never echo the matched secret back — only the shape of the problem.
      return { secret: true, reason: 'looks like a credential' };
    }
  }
  return { secret: false };
}

/**
 * Validate one memory before it is written anywhere.
 * @returns {{ ok: true, value: { content: string, category: string } }
 *          | { ok: false, error: string, code: string }}
 */
export function validateMemory(input = {}) {
  const content = normaliseContent(input.content);
  const category = normaliseCategory(input.category);

  if (content.length < MIN_CONTENT_CHARS) {
    return { ok: false, code: 'too_short', error: 'Write at least a few words.' };
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return {
      ok: false,
      code: 'too_long',
      error: `Keep it under ${MAX_CONTENT_CHARS} characters.`,
    };
  }
  if (detectSecret(content).secret) {
    return {
      ok: false,
      code: 'secret',
      error: 'That looks like a password, key or token. LOKY never stores secrets.',
    };
  }

  return { ok: true, value: { content, category } };
}

/* -------------------------------------------------------------------------- */
/* Duplicate prevention                                                       */
/* -------------------------------------------------------------------------- */

/** Comparison key: case- and whitespace-insensitive. */
export function dedupeKey(content) {
  return normaliseContent(content).toLowerCase();
}

/**
 * Find an existing memory with the same text.
 * @param {Array<{content: string, id?: string}>} memories
 * @param {string} content
 * @param {string} [ignoreId] editing a row should not collide with itself
 */
export function findDuplicate(memories, content, ignoreId = null) {
  const key = dedupeKey(content);
  if (!key) return null;
  return (
    (memories ?? []).find(
      (memory) => memory && memory.id !== ignoreId && dedupeKey(memory.content) === key,
    ) ?? null
  );
}

/* -------------------------------------------------------------------------- */
/* Relevance                                                                  */
/* -------------------------------------------------------------------------- */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'are', 'was', 'were', 'with', 'that', 'this',
  'have', 'has', 'had', 'but', 'not', 'can', 'could', 'would', 'should', 'will',
  'what', 'when', 'where', 'which', 'who', 'why', 'how', 'does', 'did', 'from',
  'about', 'into', 'than', 'then', 'them', 'they', 'his', 'her', 'its', 'our',
  'please', 'help', 'give', 'tell', 'make', 'want', 'need', 'like', 'just',
  'also', 'very', 'more', 'most', 'some', 'any', 'all', 'now', 'use', 'using',
  'hai', 'hain', 'kya', 'kaise', 'mera', 'meri', 'mujhe', 'kar', 'karo', 'aap',
]);

/** Meaningful lowercase tokens of a query or memory. */
export function tokenise(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9\u0900-\u097F]+/i)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/**
 * Score one memory against a query.
 *
 * Token overlap dominates; a pinned memory gets a small boost so an explicit
 * "always remember this" instruction keeps working, and freshness breaks ties
 * without letting a recent but unrelated memory outrank a relevant one.
 */
export function scoreMemory(memory, query) {
  if (!memory || typeof memory.content !== 'string') return 0;
  const queryTokens = new Set(tokenise(query));
  if (queryTokens.size === 0) return memory.pinned ? 1 : 0;

  const contentTokens = tokenise(memory.content);
  const categoryTokens = tokenise(CATEGORY_META[memory.category]?.label ?? '');

  let overlap = 0;
  const seen = new Set();
  for (const token of contentTokens) {
    if (queryTokens.has(token) && !seen.has(token)) {
      overlap += 1;
      seen.add(token);
    }
  }
  // Category words ("study", "project", "preference") count for less than the
  // memory's own content, so a query about "my project" prefers real project
  // notes over every row that merely sits in the Projects folder.
  let categoryHits = 0;
  for (const token of categoryTokens) {
    if (queryTokens.has(token)) categoryHits += 1;
  }

  // Substring help for inflections: "physics" vs "physics exam".
  let partial = 0;
  if (overlap === 0) {
    for (const token of queryTokens) {
      if (token.length >= 5 && contentTokens.some((c) => c.startsWith(token.slice(0, 5)))) {
        partial += 0.5;
        break;
      }
    }
  }

  return overlap * 2 + categoryHits * 0.5 + partial + (memory.pinned ? 0.75 : 0);
}

/**
 * Pick the memories worth sending to the model.
 *
 * Unrelated memories are never included: with a query, only memories that
 * actually match are returned. Without a query (rare) the most recent pinned
 * ones are used, which is the "who am I talking to" baseline.
 *
 * @returns {Array} a new array, best first, capped by `limit`
 */
export function selectRelevant(memories, query, { limit = MAX_CONTEXT_MEMORIES } = {}) {
  const list = (memories ?? []).filter((m) => m && typeof m.content === 'string');
  if (list.length === 0) return [];

  const q = String(query ?? '').trim();
  const scored = list.map((memory) => ({ memory, score: scoreMemory(memory, q) }));

  let picked;
  if (!q) {
    picked = scored
      .filter((entry) => entry.memory.pinned)
      .sort(byRecency)
      .slice(0, Math.min(limit, 4));
    if (picked.length === 0) picked = scored.sort(byRecency).slice(0, Math.min(limit, 4));
  } else {
    picked = scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || compareRecency(a.memory, b.memory))
      .slice(0, limit);
  }

  return picked.map((entry) => entry.memory);
}

function timestamp(memory) {
  const value = memory?.updated_at ?? memory?.created_at;
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : 0;
}

function compareRecency(a, b) {
  return timestamp(b) - timestamp(a);
}

function byRecency(a, b) {
  return compareRecency(a.memory, b.memory);
}

/* -------------------------------------------------------------------------- */
/* Prompt block                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Render the selected memories as a compact block for the system instruction.
 *
 * Deliberately small and labelled: the model is told these are the user's own
 * saved notes, that they may be stale, and that it must not invent memories.
 * Returns '' when there is nothing to say, so callers can skip the block
 * entirely rather than shipping an empty heading.
 */
export function buildMemoryBlock(memories, { maxChars = MAX_CONTEXT_CHARS } = {}) {
  const list = (memories ?? []).filter((m) => m && normaliseContent(m.content));
  if (list.length === 0) return '';

  const lines = [];
  let used = 0;
  for (const memory of list) {
    const label = CATEGORY_META[normaliseCategory(memory.category)]?.label ?? 'Personal';
    const line = `- [${label}] ${normaliseContent(memory.content)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return '';

  return [
    'Saved notes about this user (from their LOKY Memory page):',
    ...lines,
    'Use these only where they genuinely help the current question. Do not mention the notes themselves, do not assume anything beyond them, and never invent a memory.',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Listing helpers (used by the Memory page)                                  */
/* -------------------------------------------------------------------------- */

/** Stable display order: pinned first, then most recently updated. */
export function sortMemories(memories) {
  return [...(memories ?? [])].sort(
    (a, b) => Number(Boolean(b?.pinned)) - Number(Boolean(a?.pinned)) || compareRecency(a, b),
  );
}

/** Search + category filter for the Memory page. */
export function filterMemories(memories, { query = '', category = 'all' } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  return sortMemories(memories).filter((memory) => {
    if (!memory) return false;
    if (category !== 'all' && normaliseCategory(memory.category) !== category) return false;
    if (!q) return true;
    return String(memory.content ?? '').toLowerCase().includes(q);
  });
}

/** Counts per category, for the Memory page cards. */
export function countByCategory(memories) {
  const counts = Object.fromEntries(MEMORY_CATEGORIES.map((category) => [category, 0]));
  for (const memory of memories ?? []) {
    const category = normaliseCategory(memory?.category);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}
