/**
 * LOKY AI Next — infinite-chat planning helpers (browser side).
 *
 * Pure functions only: no DOM, no storage, no network. The UI uses them to
 * decide when a conversation needs a rolling summary, and when it has grown so
 * long that it should continue in a NEW chat that inherits a compact summary.
 *
 * The server enforces the same token budget independently (server/context.js),
 * so a stale or tampered client still cannot send an oversized payload.
 *
 * No dependencies. No secrets.
 */

/** Characters per token, deliberately pessimistic (code, LaTeX, Hinglish). */
export const CHARS_PER_TOKEN = 3.2;

/** Rough cost of one attached image, since its bytes are not text tokens. */
export const IMAGE_TOKENS = 1100;

/** Must match the server default (AI_CONTEXT_TOKENS) unless told otherwise. */
export const DEFAULT_CONTEXT_BUDGET = 24000;

/** Summarise once pending turns pass this share of the budget. */
export const SUMMARY_TRIGGER_RATIO = 0.72;

/**
 * Continue in a new chat once the whole conversation is this many budgets long.
 * Requiring a summary first means the new chat always inherits real context.
 */
export const CONTINUE_TOTAL_RATIO = 2.2;

/** Never summarise a conversation shorter than this: it is noise, not context. */
export const MIN_MESSAGES_BEFORE_SUMMARY = 8;

/** Turns kept verbatim (not folded into the summary) when compacting. */
export const KEEP_RECENT_MESSAGES = 8;

/** Shown when a chat has been continued, so the split is never silent. */
export const CONTINUED_NOTICE = 'Conversation continued in a new chat.';

export const CONTINUATION_TITLE_MAX = 80;

/* --------------------------------- tokens -------------------------------- */

export function estimateTokens(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value) return 0;
  return Math.ceil(value.length / CHARS_PER_TOKEN);
}

export function messageTokens(message) {
  if (!message || typeof message !== 'object') return 0;
  const images = Array.isArray(message.images) ? message.images.length : 0;
  return estimateTokens(message.content) + images * IMAGE_TOKENS;
}

export function conversationTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.reduce((sum, message) => sum + messageTokens(message), 0);
}

/* ------------------------------- planning -------------------------------- */

function storedSummary(conversation) {
  return typeof conversation?.summary === 'string' ? conversation.summary.trim() : '';
}

function summaryUpTo(conversation) {
  const value = Number(conversation?.summaryUpTo);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Turns that are NOT yet covered by the stored summary. Anything the summary
 * already describes is skipped, so the same turns are never summarised twice.
 */
export function pendingMessages(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  return messages.slice(Math.min(summaryUpTo(conversation), messages.length));
}

/**
 * Work out what a conversation needs right now.
 *
 * Returns the token accounting plus two independent decisions:
 *   needsSummary      — fold older turns into the rolling summary
 *   needsContinuation — start a fresh chat seeded with that summary
 */
export function planContext(conversation, budget = DEFAULT_CONTEXT_BUDGET) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const summary = storedSummary(conversation);
  const pending = pendingMessages(conversation);
  const budgetTokens = Number(budget) > 0 ? Number(budget) : DEFAULT_CONTEXT_BUDGET;

  const summaryTokens = estimateTokens(summary);
  const pendingTokens = conversationTokens(pending) + summaryTokens;
  const totalTokens = conversationTokens(messages) + summaryTokens;

  const enoughTurns = pending.length > MIN_MESSAGES_BEFORE_SUMMARY;

  // Keep the newest turns verbatim; everything before them may be summarised.
  const keep = Math.min(KEEP_RECENT_MESSAGES, Math.max(0, pending.length - 2));
  const splitAt = Math.max(summaryUpTo(conversation), messages.length - keep);
  const summarisable = messages.slice(summaryUpTo(conversation), splitAt);

  return {
    messages,
    summary,
    pending,
    summarisable,
    splitAt,
    tokens: totalTokens,
    pendingTokens,
    budget: budgetTokens,
    needsSummary:
      enoughTurns &&
      pendingTokens > budgetTokens * SUMMARY_TRIGGER_RATIO &&
      summarisable.length > 0,
    // Continuation requires a summary to inherit, so the new chat is never
    // context-free, and it must be a genuine long-conversation situation.
    needsContinuation:
      enoughTurns &&
      Boolean(summary) &&
      totalTokens > budgetTokens * CONTINUE_TOTAL_RATIO &&
      !conversation?.continuedTo,
  };
}

/**
 * Build the POST /api/summarize body for the turns that are due for folding.
 * Returns null when there is nothing worth summarising.
 */
export function buildSummaryPayload(conversation, { maxChars = 24000 } = {}) {
  const plan = planContext(conversation);
  const older = plan.summarisable;
  // Below the threshold a summary is noise, not context: never spend a
  // provider call on a handful of turns.
  if (plan.pending.length <= MIN_MESSAGES_BEFORE_SUMMARY) return null;
  if (older.length === 0) return null;

  const messages = older.map((message) => ({
    role: message.role,
    content: clampChars(message.content, maxChars),
  }));

  return {
    upTo: plan.splitAt,
    body: {
      previousSummary: plan.summary,
      messages,
    },
  };
}

/* ------------------------------ continuation ----------------------------- */

/**
 * Title for a continuation chat. Keeps the original name recognisable and
 * stays within the stored-title limit.
 */
export function continuationTitle(title, maxLength = CONTINUATION_TITLE_MAX) {
  const base = String(title ?? '').replace(/\s+/g, ' ').trim() || 'Conversation';
  const suffix = ' (continued)';
  const limit = Number(maxLength) > suffix.length ? Number(maxLength) : CONTINUATION_TITLE_MAX;
  const room = limit - suffix.length;
  if (base.length <= room) return `${base}${suffix}`;
  return `${base.slice(0, Math.max(1, room - 1)).trimEnd()}…${suffix}`;
}

/**
 * The record for a continuation chat: no copied messages, just the compact
 * summary plus a link back to where the conversation came from.
 */
export function continuationRecord({ previous, id, summary, now = Date.now() }) {
  return {
    id,
    title: continuationTitle(previous?.title),
    createdAt: now,
    updatedAt: now,
    messages: [],
    summary: String(summary ?? '').trim(),
    summaryUpTo: 0,
    continuedFrom: typeof previous?.id === 'string' ? previous.id : null,
    continuedFromTitle: typeof previous?.title === 'string' ? previous.title : '',
  };
}

/* --------------------------------- utils --------------------------------- */

export function clampChars(text, maxChars) {
  const value = typeof text === 'string' ? text : '';
  const limit = Number(maxChars) > 0 ? Number(maxChars) : 24000;
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(1, limit - 1))}…`;
}

/**
 * One-line description of a continuation link, used for the banner in the UI.
 */
export function continuationLabel(conversation) {
  if (!conversation || typeof conversation !== 'object') return '';
  if (conversation.continuedFrom) {
    const from = String(conversation.continuedFromTitle ?? '').trim();
    return from ? `Continuing “${from}”` : 'Continuing an earlier conversation';
  }
  if (conversation.continuedTo) return CONTINUED_NOTICE;
  return '';
}
