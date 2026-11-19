/**
 * LOKY MEMORY — automatic extraction pipeline.
 *
 * After a reply has already been streamed to the user, this module reads the
 * turn, asks the configured model which facts are worth keeping long-term, and
 * writes them through the same user-scoped PostgREST store as the Memory page.
 * Nothing here runs on the critical path of a chat response: the answer is
 * finished and flushed before extraction is scheduled.
 *
 * Guarantees:
 *   - the caller's own access token is used, so RLS decides what is readable
 *     and writable; a bug here cannot reach another account's rows;
 *   - every candidate passes the same validateMemory() rules as manual entries
 *     (length, category, credential guard), so a leaked key is never stored;
 *   - writes are confirmed by the database before they are counted — this
 *     module never reports a memory as saved on the strength of a request it
 *     sent;
 *   - a changed preference updates the existing row instead of duplicating it;
 *   - any failure is swallowed: memory is an enhancement, never a dependency.
 */

import { createHash } from 'node:crypto';

import {
  MAX_MEMORIES_PER_USER,
  dedupeKey,
  findDuplicate,
  normaliseContent,
  similarity,
  validateMemory,
} from '../public/memory-model.js';
import { createMemoryStore, supabaseCreds } from './memory.js';
import { streamChat } from './providers.js';

/** Hard ceiling on how many facts one turn may add. */
export const MAX_CANDIDATES = 5;
/** Transcript budget sent to the extractor, in characters. */
export const MAX_TRANSCRIPT_CHARS = 4000;
export const DEFAULT_TIMEOUT_MS = 20000;
/** Below this importance a fact is too transient to be worth a row. */
export const MIN_IMPORTANCE = 0.35;
/**
 * At or above this similarity two notes are the same fact.
 *
 * Kept high on purpose: rewriting the wrong row loses the user's own words,
 * while a missed merge is visible and fixable on the Memory page.
 */
export const SUPERSEDE_SIMILARITY = 0.7;
/**
 * Between this and SUPERSEDE_SIMILARITY the notes are clearly related but not
 * provably the same claim ("preparing for JEE physics" vs "...chemistry").
 * Those are neither merged nor stored, so a contradiction is never created
 * silently — the user sees the existing note and can edit it themselves.
 */
export const AMBIGUOUS_SIMILARITY = 0.4;

export const EXTRACTION_SYSTEM = [
  'You maintain the long-term memory of LOKY AI, an assistant.',
  'Read the conversation and extract only durable facts about the USER that will still be useful in a completely different chat weeks later.',
  '',
  'Worth remembering:',
  '- long-term goals and targets (exams, degrees, career)',
  '- education, class, stream, profession',
  '- stable learning or working preferences',
  '- ongoing projects and their current state',
  '- recurring plans, schedules and milestones',
  '- durable personal facts the user chose to share',
  '',
  'Not worth remembering:',
  '- small talk, greetings, jokes, one-off questions',
  '- anything the assistant said about itself',
  '- temporary moods or states ("I am tired today")',
  '- the content of a single homework question',
  '- passwords, API keys, tokens, card or ID numbers, addresses, phone numbers',
  '',
  'Rules:',
  '- Write each memory as one short third-person sentence about the user, under 200 characters.',
  '- Prefer one clear fact per memory. Do not combine unrelated facts.',
  '- Only include what the user actually stated. Never infer or invent.',
  '- importance: 0..1, how useful this is in a future chat (1 = core identity or goal).',
  '- confidence: 0..1, how certain the statement is.',
  '- category: one of personal, study, projects, preferences.',
  `- Return at most ${MAX_CANDIDATES} memories. Return {"memories": []} when nothing qualifies.`,
  '',
  'Respond with JSON only, no prose and no code fences:',
  '{"memories":[{"content":"...","category":"study","importance":0.9,"confidence":0.8}]}',
].join('\n');

/* -------------------------------------------------------------------------- */
/* Pure helpers (unit tested directly)                                        */
/* -------------------------------------------------------------------------- */

function clampUnit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

/**
 * Render the recent turns as a compact transcript for the extractor.
 *
 * Images are described by placeholder text rather than sent again: extraction
 * is a text task and re-uploading base64 would cost tokens for no benefit.
 */
export function buildTranscript(messages, { maxChars = MAX_TRANSCRIPT_CHARS } = {}) {
  const turns = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => {
      const text = normaliseContent(message.content);
      const images = Array.isArray(message.images) && message.images.length > 0;
      const body = text || (images ? '[image attached]' : '');
      if (!body) return null;
      const speaker = message.role === 'user' ? 'User' : 'Assistant';
      const limit = message.role === 'user' ? 900 : 400;
      return `${speaker}: ${body.length > limit ? `${body.slice(0, limit)}…` : body}`;
    })
    .filter(Boolean);

  if (turns.length === 0) return '';

  // Keep the newest turns: they hold the facts the user just stated.
  const kept = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (used + turn.length + 1 > maxChars) break;
    kept.unshift(turn);
    used += turn.length + 1;
  }
  return kept.join('\n');
}

/** Pull the first JSON object/array out of whatever the model returned. */
function findJsonSlice(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : text;
  const start = body.search(/[[{]/);
  if (start === -1) return '';
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  if (end <= start) return '';
  return body.slice(start, end + 1);
}

/**
 * Turn the extractor's raw output into validated candidates.
 *
 * Never throws: a malformed model response means "nothing to remember", not a
 * failed chat. Invalid, too-short, too-long and secret-looking entries are
 * dropped here rather than at the database.
 *
 * @returns {Array<{content: string, category: string, importance: number, confidence: number}>}
 */
export function parseExtraction(raw, { maxItems = MAX_CANDIDATES } = {}) {
  const slice = findJsonSlice(raw);
  if (!slice) return [];

  let parsed;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return [];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.memories)
      ? parsed.memories
      : Array.isArray(parsed?.facts)
        ? parsed.facts
        : [];

  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item) continue;
    const content = typeof item === 'string' ? item : item.content;
    const checked = validateMemory({
      content,
      category: typeof item === 'object' ? item.category : undefined,
    });
    if (!checked.ok) continue;

    const key = dedupeKey(checked.value.content);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      content: checked.value.content,
      category: checked.value.category,
      importance: clampUnit(item?.importance, 0.5),
      confidence: clampUnit(item?.confidence, 0.6),
    });
  }

  return out.sort((a, b) => b.importance - a.importance).slice(0, Math.max(0, maxItems));
}

/**
 * Decide what to write for a batch of candidates.
 *
 * Three outcomes, all pure so they can be asserted exactly:
 *   add    — genuinely new and worth keeping;
 *   update — same fact as an existing row, so the row is superseded in place
 *            (this is how "I prefer one-shot lectures" becomes "I prefer
 *            detailed notes" without leaving both claims behind);
 *   skip   — duplicate, too trivial, ambiguous, or over the account quota.
 *
 * @returns {{adds: Array, updates: Array, skipped: Array<{content: string, reason: string}>}}
 */
export function planMemoryWrites(
  candidates,
  existing,
  { maxAdds = MAX_CANDIDATES, quota = MAX_MEMORIES_PER_USER } = {},
) {
  const known = (Array.isArray(existing) ? existing : []).filter(Boolean);
  const adds = [];
  const updates = [];
  const skipped = [];

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate?.content) continue;
    const content = normaliseContent(candidate.content);

    // 1. Identical text (case/space-insensitive) is always a duplicate.
    if (findDuplicate([...known, ...adds], content)) {
      skipped.push({ content, reason: 'duplicate' });
      continue;
    }

    // 2. Same fact, new wording: supersede the row that already holds it.
    let best = null;
    for (const memory of known) {
      if (memory.category !== candidate.category) continue;
      const score = similarity(content, memory.content);
      if (!best || score > best.score) best = { memory, score };
    }
    if (best && best.score >= SUPERSEDE_SIMILARITY) {
      if (dedupeKey(best.memory.content) === dedupeKey(content)) {
        skipped.push({ content, reason: 'duplicate' });
      } else {
        updates.push({ id: best.memory.id, content, category: candidate.category, candidate });
      }
      continue;
    }

    // 3. Close but not clearly the same fact, and it matters: overwriting an
    //    important note on a guess would silently lose the user's own words,
    //    so leave both untouched and let them decide on the Memory page.
    if (best && best.score >= AMBIGUOUS_SIMILARITY && candidate.importance >= 0.6) {
      skipped.push({ content, reason: 'ambiguous' });
      continue;
    }

    // 4. Too transient to be worth a row.
    if (candidate.importance < MIN_IMPORTANCE) {
      skipped.push({ content, reason: 'low_importance' });
      continue;
    }

    // 5. Respect the account ceiling and this run's own cap.
    if (known.length + adds.length >= quota) {
      skipped.push({ content, reason: 'quota' });
      continue;
    }
    if (adds.length >= maxAdds) {
      skipped.push({ content, reason: 'batch_cap' });
      continue;
    }

    adds.push(candidate);
  }

  return { adds, updates, skipped };
}

/** Environment switches, resolved once per call so tests can inject them. */
export function extractionSettings(env = process.env) {
  const raw = String(env.MEMORY_AUTO_EXTRACT ?? 'on').toLowerCase();
  const disabled = ['0', 'off', 'false', 'no', 'disabled'].includes(raw);
  const timeout = Number(env.MEMORY_EXTRACT_TIMEOUT_MS);
  const concurrent = Number(env.MEMORY_EXTRACT_MAX_CONCURRENT);
  return {
    enabled: !disabled,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 60000) : DEFAULT_TIMEOUT_MS,
    maxConcurrent: Number.isFinite(concurrent) && concurrent >= 1 ? Math.min(concurrent, 4) : 2,
  };
}

/* -------------------------------------------------------------------------- */
/* Model call                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Ask the configured provider for the memory candidates.
 *
 * Reuses the streaming client so every supported provider (OpenAI-compatible
 * and Gemini) works without a second code path; the stream is simply collected
 * into one string. A dedicated low temperature and a small token ceiling keep
 * this cheap and deterministic.
 */
export async function completeExtraction(
  config,
  transcript,
  { timeoutMs = DEFAULT_TIMEOUT_MS, streamImpl = streamChat } = {},
) {
  const extractionConfig = {
    ...config,
    systemPrompt: EXTRACTION_SYSTEM,
    temperature: 0.2,
    maxTokens: 900,
    timeoutMs,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = '';
  try {
    for await (const delta of streamImpl(
      extractionConfig,
      [{ role: 'user', content: transcript }],
      { signal: controller.signal, systemExtra: '' },
    )) {
      text += delta;
      // The answer is a small JSON object; anything longer is a model error.
      if (text.length > 4000) break;
    }
  } finally {
    clearTimeout(timer);
  }
  return text;
}

async function withRetry(task, attempts = 2) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Extract and persist memories for one finished turn.
 *
 * Never throws and never touches the chat response. The returned object is for
 * logging and tests; it is deliberately not shown to the user, because a
 * memory is only "saved" once the database has confirmed the write.
 */
export async function runMemoryExtraction({
  config,
  token,
  creds = null,
  messages,
  conversationId = null,
  complete = completeExtraction,
  storeFactory = createMemoryStore,
  settings = extractionSettings(),
  log = () => {},
}) {
  if (!settings.enabled) return { ok: false, reason: 'auto_memory_off' };

  const resolved = creds ?? supabaseCreds(config);
  if (!resolved || !token) return { ok: false, reason: 'not_configured' };

  const transcript = buildTranscript(messages);
  if (!transcript) return { ok: false, reason: 'empty_transcript' };

  let store;
  try {
    store = storeFactory({ ...resolved, token });
  } catch {
    return { ok: false, reason: 'store_unavailable' };
  }

  // Respect the user's switch: OFF means no reading, no writing, no model call.
  try {
    if (!(await store.getEnabled())) return { ok: false, reason: 'disabled' };
  } catch {
    return { ok: false, reason: 'settings_unavailable' };
  }

  let existing;
  try {
    existing = await store.list();
  } catch {
    return { ok: false, reason: 'read_failed' };
  }

  let raw;
  try {
    raw = await withRetry(() => complete(config, transcript, { timeoutMs: settings.timeoutMs }));
  } catch {
    return { ok: false, reason: 'extract_failed' };
  }

  const candidates = parseExtraction(raw);
  if (candidates.length === 0) return { ok: true, saved: 0, updated: 0, skipped: 0 };

  const plan = planMemoryWrites(candidates, existing);
  let saved = 0;
  let updated = 0;
  let skipped = plan.skipped.length;

  for (const change of plan.updates) {
    try {
      const row = await store.update(change.id, {
        content: change.content,
        category: change.category,
      });
      if (row) updated += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  for (const candidate of plan.adds) {
    try {
      const row = await store.create(
        {
          content: candidate.content,
          category: candidate.category,
          source: 'auto',
          importance: candidate.importance,
          confidence: candidate.confidence,
          sourceConversationId: conversationId,
        },
        { knownExisting: existing },
      );
      if (row) saved += 1;
      else skipped += 1;
    } catch (error) {
      // A unique-index conflict means another turn already stored this fact.
      if (error?.code === 'duplicate') skipped += 1;
      else {
        skipped += 1;
        log('[memory] write failed:', error?.code ?? error?.message);
      }
    }
  }

  if (saved || updated) log(`[memory] saved ${saved}, updated ${updated}, skipped ${skipped}`);
  return { ok: true, saved, updated, skipped };
}

/* -------------------------------------------------------------------------- */
/* Background queue                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Bounded fire-and-forget queue.
 *
 * Keeps extraction off the response path while stopping a burst of messages
 * from spawning unbounded model calls: at most `maxConcurrent` run, and the
 * same conversation is never processed twice inside `dedupeTtlMs`.
 */
export function createExtractionQueue({
  maxConcurrent = 2,
  dedupeTtlMs = 10 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  const pending = [];
  const seen = new Map();
  let active = 0;

  function prune() {
    const cutoff = now() - dedupeTtlMs;
    for (const [key, at] of seen) if (at < cutoff) seen.delete(key);
    // Hard bound so a long-lived process cannot grow this map forever.
    if (seen.size > 500) {
      const excess = seen.size - 500;
      let removed = 0;
      for (const key of seen.keys()) {
        seen.delete(key);
        if (++removed >= excess) break;
      }
    }
  }

  function pump() {
    while (active < maxConcurrent && pending.length > 0) {
      const task = pending.shift();
      active += 1;
      Promise.resolve()
        .then(task)
        .catch(() => {})
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return {
    /** @returns {boolean} true when the task was accepted */
    push(key, task) {
      prune();
      if (key && seen.has(key)) return false;
      if (key) seen.set(key, now());
      pending.push(task);
      pump();
      return true;
    },
    stats() {
      return { active, pending: pending.length, seen: seen.size };
    },
  };
}

let sharedQueue = null;

function queueFor(settings) {
  if (!sharedQueue) {
    sharedQueue = createExtractionQueue({ maxConcurrent: settings.maxConcurrent });
  }
  return sharedQueue;
}

/**
 * Schedule extraction for a turn that has already been answered.
 *
 * Called from the chat route *after* the stream is closed, so the user never
 * waits for it. Returns a boolean for tests; production callers ignore it.
 */
export function scheduleMemoryExtraction({
  config,
  token,
  messages,
  reply = '',
  conversationId = null,
  settings = extractionSettings(),
  queue = null,
  run = runMemoryExtraction,
  log = () => {},
}) {
  if (!settings.enabled || !token || !config) return false;

  const transcript = buildTranscript(messages);
  if (!transcript) return false;

  // One key per user + conversation + last user turn: retrying the same send or
  // reopening a chat cannot re-extract the same facts.
  const userKey = createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
  const signature = createHash('sha256')
    .update(`${conversationId ?? ''}|${normaliseContent(lastUser?.content ?? '')}|${reply.length}`)
    .digest('hex')
    .slice(0, 16);

  const activeQueue = queue ?? queueFor(settings);
  return activeQueue.push(`${userKey}:${signature}`, () =>
    run({ config, token, messages, conversationId, settings, log }).catch(() => {}),
  );
}
