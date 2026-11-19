/**
 * CONTEXT ENGINE — token-aware conversation windowing and summarisation.
 *
 * Pure functions only: no fetch, no storage, no DOM. That keeps the behaviour
 * that decides "what does the model actually see" testable in Node, and keeps
 * the /api/chat handler a thin orchestrator.
 *
 * Why this exists
 * ---------------
 * Previously the only limit was a message COUNT (`MAX_MESSAGES`) plus a raw
 * character cap. Both are wrong for a real assistant:
 *
 *   - 30 short messages are cheap; 30 long ones blow the context window.
 *   - Hitting the count limit hard-failed with "start a new chat", losing the
 *     thread instead of continuing it.
 *
 * So context is now measured in ESTIMATED TOKENS, and anything that does not
 * fit is compressed into a rolling summary rather than dropped silently.
 */

/**
 * Conservative characters-per-token ratio.
 *
 * Real tokenisers average ~4 chars/token for English prose, but code, LaTeX and
 * Devanagari/Hinglish text tokenise worse (closer to 2.5-3). Using 3.2 makes the
 * estimate deliberately pessimistic, so we compress slightly early instead of
 * overflowing and getting a provider 400.
 */
export const CHARS_PER_TOKEN = 3.2;

/** An attached image is billed by the provider roughly as a fixed block. */
export const IMAGE_TOKENS = 1100;

/** Never summarise fewer messages than this - it is not worth a provider call. */
export const MIN_MESSAGES_TO_SUMMARISE = 6;

/** Keep at least this many of the newest messages verbatim after a summary. */
export const MIN_RECENT_MESSAGES = 8;

/** Hard cap on a stored summary, in characters (~1200 tokens). */
export const SUMMARY_MAX_CHARS = 4800;

/** Estimate the token cost of a string. */
export function estimateTokens(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value) return 0;
  return Math.ceil(value.length / CHARS_PER_TOKEN);
}

/** Estimate the token cost of one internal message ({ role, content, images }). */
export function messageTokens(message) {
  if (!message || typeof message !== 'object') return 0;
  const images = Array.isArray(message.images) ? message.images.length : 0;
  return estimateTokens(message.content) + images * IMAGE_TOKENS;
}

/** Estimate the token cost of a whole conversation. */
export function conversationTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

/**
 * Split a conversation into the part to send and the part to summarise.
 *
 * Walks backwards from the newest message, keeping everything that fits inside
 * `budget`. Always keeps at least `minRecent` messages (when available) so the
 * model sees the immediate exchange even if a single turn is enormous, and
 * never returns an empty `recent` array for a non-empty input.
 *
 * @returns {{ recent: object[], older: object[], trimmed: boolean }}
 */
export function selectWindow(messages, budget, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const minRecent = Math.max(1, options.minRecent ?? MIN_RECENT_MESSAGES);
  if (list.length === 0) return { recent: [], older: [], trimmed: false };

  const limit = Number.isFinite(budget) && budget > 0 ? budget : Infinity;
  let used = 0;
  let cut = list.length;

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const cost = messageTokens(list[index]);
    const keptCount = list.length - index;
    // Always admit the newest messages, even when one of them alone is over
    // budget - sending nothing at all would be a worse failure.
    if (used + cost > limit && keptCount > minRecent) break;
    used += cost;
    cut = index;
  }

  const recent = list.slice(cut);
  const older = list.slice(0, cut);
  return { recent, older, trimmed: older.length > 0 };
}

/**
 * Trim a transcript down to something a summariser can read cheaply.
 * Keeps the START (the original instructions and task) and the END (the most
 * recent state), which is where the load-bearing facts usually live.
 */
export function clampTranscript(messages, maxChars = 24000) {
  const list = Array.isArray(messages) ? messages : [];
  const render = (message) => {
    const role = message?.role === 'assistant' ? 'Assistant' : 'User';
    const text = typeof message?.content === 'string' ? message.content.trim() : '';
    const images = Array.isArray(message?.images) ? message.images.length : 0;
    const suffix = images > 0 ? ` [${images} image${images === 1 ? '' : 's'} attached]` : '';
    return `${role}: ${text}${suffix}`;
  };

  const lines = list.map(render).filter(Boolean);
  const joined = lines.join('\n\n');
  if (joined.length <= maxChars) return joined;

  // Head + tail budget, split 45/55 in favour of the newest state.
  const headBudget = Math.floor(maxChars * 0.45);
  const tailBudget = maxChars - headBudget;

  let head = '';
  for (const line of lines) {
    if (head.length + line.length + 2 > headBudget) break;
    head += `${line}\n\n`;
  }

  let tail = '';
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (tail.length + line.length + 2 > tailBudget) break;
    tail = `${line}\n\n${tail}`;
  }

  return `${head.trim()}\n\n[… middle of the conversation omitted for length …]\n\n${tail.trim()}`;
}

/**
 * Instructions for the summariser. Deliberately asks for the things that make
 * a continued conversation still work: decisions, constraints, unfinished
 * tasks and exact technical/mathematical detail.
 */
export const SUMMARY_SYSTEM_PROMPT = [
  'You compress chat transcripts into a compact working summary.',
  'The summary is given to another assistant so the conversation can continue without the full history.',
  'Write in the same language the user writes in.',
  'Preserve, in this order:',
  '1. What the user is trying to achieve, and any stated constraints or preferences.',
  '2. Decisions already made and conclusions already reached.',
  '3. Unfinished tasks, open questions and next steps.',
  '4. Concrete facts and figures: names, numbers, dates, file names, commands, results.',
  '5. Mathematics and science: exact formulas, given values, intermediate results and final answers.',
  '6. Code: languages, libraries, key function or file names, and the current state of the work.',
  'Omit pleasantries, repeated explanations and anything already resolved.',
  'Use short headed bullet lists. Never invent details that are not in the transcript.',
  'If something is unknown, leave it out rather than guessing.',
].join(' ');

/**
 * Build the messages sent to the provider in order to summarise a transcript.
 * A previous summary is folded in so summaries are ROLLING, not restarting.
 */
export function buildSummaryMessages(messages, previousSummary = '') {
  const transcript = clampTranscript(messages);
  const prior = normalizeSummary(previousSummary);
  const sections = [];
  if (prior) {
    sections.push(`SUMMARY SO FAR (compress this together with the new messages):\n${prior}`);
  }
  sections.push(`NEW MESSAGES TO FOLD IN:\n${transcript || '(none)'}`);
  sections.push('Return ONLY the updated summary. No preamble, no closing remarks.');

  return [{ role: 'user', content: sections.join('\n\n') }];
}

/**
 * Clean a model-produced summary: strip wrapping code fences, collapse runs of
 * blank lines and cap the length. Returns '' for anything unusable.
 */
export function normalizeSummary(text) {
  let out = typeof text === 'string' ? text : '';
  if (!out) return '';

  out = out.trim();
  // Some models wrap the whole answer in a fence; the fences add nothing.
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(out);
  if (fenced) out = fenced[1];
  // Drop a leading "Summary:" label.
  out = out.replace(/^\s*(?:summary|updated summary)\s*:\s*/i, '');
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  if (out.length > SUMMARY_MAX_CHARS) {
    out = `${out.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
  }
  return out;
}

/**
 * The hidden block handed to the main model as extra system context.
 * Returns '' when there is nothing to add, so payloads stay byte-identical
 * when the feature is not in use.
 */
export function summaryBlock(summary) {
  const clean = normalizeSummary(summary);
  if (!clean) return '';
  return [
    'CONVERSATION SO FAR (compressed earlier context — treat as established facts):',
    clean,
    'Continue naturally from this. Do not mention that a summary exists.',
  ].join('\n');
}

/**
 * Validate the `summary` field of a chat request.
 * Returns '' for anything that is not a usable string; never throws, because a
 * malformed summary must not take down an otherwise valid chat request.
 */
export function normalizeSummaryInput(raw) {
  if (typeof raw !== 'string') return '';
  return normalizeSummary(raw);
}

/** Validate + clamp a summary request body. Throws a user-safe error. */
export function validateSummaryRequest(body, limits = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { messages: [], previousSummary: '', error: 'Send a JSON object with a "messages" array.' };
  }
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const maxMessages = Number.isFinite(limits.maxMessages) ? limits.maxMessages : 40;

  const messages = [];
  for (const item of raw.slice(-maxMessages)) {
    if (!item || typeof item !== 'object') continue;
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) continue;
    const images = Array.isArray(item.images) ? item.images.length : 0;
    messages.push(images > 0 ? { role: item.role, content, images } : { role: item.role, content });
  }

  if (messages.length === 0) {
    return { messages: [], previousSummary: '', error: 'There is nothing to summarise yet.' };
  }
  return {
    messages,
    previousSummary: normalizeSummaryInput(body.previousSummary),
    error: null,
  };
}
