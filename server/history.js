/**
 * PRIOR-CONVERSATION CONTEXT — server side.
 *
 * The browser owns the chat list (localStorage), so it sends the relevant
 * earlier conversations with each request. This module is the trust boundary:
 * it sanitises whatever arrived, caps the size, and turns it into a system
 * block that tells the model these chats are REAL and must never be denied.
 *
 * Pure functions only — no fetch, no storage — so the exact text the model sees
 * stays testable.
 */

export const HISTORY_LIMITS = {
  indexEntries: 12,
  excerpts: 6,
  messages: 40,
  messageChars: 480,
  titleChars: 80,
  blockChars: 9000,
};

const ALLOWED_ROLES = new Set(['user', 'assistant']);

function clampText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function clampNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** YYYY-MM-DD, or '' — dates anchor "kal"/"yesterday" style questions. */
export function formatHistoryDate(value) {
  const stamp = clampNumber(value);
  if (!stamp) return '';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

/**
 * Validate + clamp the `history` field of a chat request.
 * Never throws: a malformed payload must not break an otherwise valid chat.
 */
export function normalizeHistoryInput(raw, limits = HISTORY_LIMITS) {
  const empty = { index: [], excerpts: [], ambiguous: false, intent: 'none', query: '' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;

  const index = [];
  for (const item of Array.isArray(raw.index) ? raw.index.slice(0, limits.indexEntries) : []) {
    if (!item || typeof item !== 'object') continue;
    const title = clampText(item.title, limits.titleChars);
    if (!title) continue;
    index.push({
      title,
      updatedAt: clampNumber(item.updatedAt),
      messageCount: Math.min(9999, Math.round(clampNumber(item.messageCount))),
    });
  }

  const excerpts = [];
  let messageBudget = limits.messages;
  let charBudget = limits.blockChars;

  for (const item of Array.isArray(raw.excerpts) ? raw.excerpts.slice(0, limits.excerpts) : []) {
    if (!item || typeof item !== 'object') continue;
    if (messageBudget <= 0 || charBudget <= 0) break;

    const title = clampText(item.title, limits.titleChars) || 'Untitled chat';
    const messages = [];
    for (const message of Array.isArray(item.messages) ? item.messages : []) {
      if (messageBudget <= 0 || charBudget <= 0) break;
      if (!message || typeof message !== 'object') continue;
      if (!ALLOWED_ROLES.has(message.role)) continue;
      const content = clampText(message.content, limits.messageChars);
      if (!content) continue;
      if (content.length > charBudget) break;
      messages.push({ role: message.role, content });
      messageBudget -= 1;
      charBudget -= content.length;
    }

    if (messages.length > 0) {
      excerpts.push({ title, updatedAt: clampNumber(item.updatedAt), messages });
    }
  }

  return {
    index,
    excerpts,
    ambiguous: Boolean(raw.ambiguous) && excerpts.length > 1,
    intent: typeof raw.intent === 'string' ? raw.intent.slice(0, 24) : 'none',
    query: clampText(raw.query, 300),
  };
}

const RULES = [
  'RULES FOR USING THIS (follow exactly):',
  "- The user's earlier conversations ARE saved and are shown above. Never say you cannot see, do not have access to, or do not save previous chats.",
  '- The messages above are the user\'s real words. Quote their actual wording and keep their original order. Never invent questions, answers, code, formulas or dates.',
  '- If asked for earlier questions, list the real ones in order. Add the original answers when asked, or when they are needed to make sense of a question.',
  '- If several conversations are listed and the user did not name one, say which ones are available and ask which they mean before listing everything.',
  '- If the requested detail is not in these excerpts, say what IS available (titles/dates above) and ask the user to open that chat. Do not guess or fabricate.',
  '- Do not claim a chat does not exist when it appears in the list above.',
];

/**
 * The hidden system block. Returns '' when there is nothing to add, so the
 * payload stays byte-identical for a brand-new user with no history.
 */
export function historyBlock(history, limits = HISTORY_LIMITS) {
  const data = history && typeof history === 'object' ? history : null;
  if (!data) return '';

  const index = Array.isArray(data.index) ? data.index : [];
  const excerpts = Array.isArray(data.excerpts) ? data.excerpts : [];
  if (index.length === 0 && excerpts.length === 0) return '';

  const parts = [];

  if (index.length > 0) {
    const lines = index.map((entry) => {
      const date = formatHistoryDate(entry.updatedAt);
      const when = date ? `updated ${date}` : 'date unknown';
      const count = entry.messageCount > 0 ? `${entry.messageCount} messages` : 'messages unknown';
      return `- "${entry.title}" (${when}, ${count})`;
    });
    parts.push(
      "THE USER'S SAVED CONVERSATIONS (from their own device — these chats exist):",
      lines.join('\n'),
    );
  }

  if (excerpts.length > 0) {
    const sections = excerpts.map((entry, position) => {
      const date = formatHistoryDate(entry.updatedAt);
      const heading = `### ${position + 1}. "${entry.title}"${date ? ` — ${date}` : ''}`;
      const turns = entry.messages
        .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
        .join('\n\n');
      return `${heading}\n\n${turns}`;
    });
    parts.push(
      'REAL EXCERPTS FROM THOSE EARLIER CONVERSATIONS (verbatim, newest first):',
      sections.join('\n\n'),
    );
  } else {
    parts.push(
      'Only the titles were retrieved for this question. Do not claim the chats are unavailable: name the relevant titles and ask which one the user means.',
    );
  }

  parts.push(RULES.join('\n'));

  const block = parts.join('\n\n');
  return block.length > limits.blockChars
    ? `${block.slice(0, limits.blockChars - 1).trimEnd()}…`
    : block;
}
