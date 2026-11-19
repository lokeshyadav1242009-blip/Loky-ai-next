/**
 * PREVIOUS-CONVERSATION RETRIEVAL — pure helpers, no DOM, no fetch.
 *
 * Why this exists
 * ---------------
 * Chat history for the AI assistant is stored in this browser (`loky.ai.next.v1`
 * in localStorage). The server can never read it, so `/api/chat` used to receive
 * ONLY the current conversation. Asked "pichle chat me jo que diye the wapis de",
 * the model had no earlier turns at all and answered that previous chats are not
 * saved — while the sidebar was visibly listing them.
 *
 * This module turns the conversations the sidebar already shows into a compact,
 * request-sized payload:
 *   - `index`     always sent: titles + dates, so the model knows chats EXIST.
 *   - `excerpts`  sent when the message actually asks about earlier chats:
 *                 the real messages, in their original order, never invented.
 *
 * Kept pure and dependency-free so the behaviour is testable in Node.
 */

/** Titles/dates sent on every request. Small enough to be free. */
export const HISTORY_INDEX_LIMIT = 12;

/** Never attach more than this many conversations' worth of excerpts. */
export const HISTORY_EXCERPT_CONVERSATIONS = 6;

/** Total messages across all excerpts. */
export const HISTORY_EXCERPT_MESSAGES = 40;

/** Per-message clamp. Long code answers are cut, the question stays intact. */
export const HISTORY_MESSAGE_CHARS = 480;

/** Total characters of excerpt text. */
export const HISTORY_BLOCK_CHARS = 8000;

/** A title longer than this is not a title. */
export const HISTORY_TITLE_CHARS = 80;

/**
 * Words that only mean something in combination with a history anchor.
 * Hindi/Hinglish is written many ways, so each idea has several spellings.
 */
const HISTORY_ANCHORS = [
  /pichl[aei]/,
  /pichh?l[aei]/,
  /pur[ae]n[aei]/,
  /previous/,
  /earlier/,
  /last (?:chat|conversation|time|baat|message)/,
  /pehle (?:wali|wale|wala|ki|ka|ke)/,
  /kal (?:kya|ki|ka|discuss|baat|wala)/,
  /yesterday/,
  /saved (?:chat|conversation)/,
  /chat history/,
  /पिछल/,
  /पहले/,
  /कल/,
];

/** Past-tense markers: "kya kiya tha", "what did we discuss". */
const PAST_MARKERS = [
  /\btha\b/,
  /\bthe\b/,
  /\bkiye\b/,
  /\bkiya\b/,
  /\bpooch?a\b/,
  /\bdiscuss/,
  /\basked\b/,
  /\bsaid\b/,
  /\btold\b/,
];

/** A history question still needs to ask for something back. */
const RETRIEVAL_VERBS = [
  /\bde\b/,
  /\bdo\b/,
  /\bdena\b/,
  /\bdijiye\b/,
  /\bdikha/,
  /\bbhej/,
  /\bchahiye\b/,
  /\bwapas?\b/,
  /\bwapis\b/,
  /\bdobara\b/,
  /\bphir se\b/,
  /\bshow\b/,
  /\bgive\b/,
  /\bget\b/,
  /\blist\b/,
  /\bsend\b/,
  /\bwhat\b/,
  /\bkya\b/,
  /\bbata/,
  /\bcontinue\b/,
];

const CONTINUE_PATTERNS = [/continue/, /jahan chhoda/, /wahi se/, /\bresume\b/, /aage badh/];
const CODE_PATTERNS = [/\bcode\b/, /\bscript\b/, /\bprogram\b/, /\bfunction\b/, /\bclass\b/];
const MATH_PATTERNS = [/\bmaths?\b/, /mathematic/, /\bformula/, /\bequation/, /\bganit\b/, /\bphysics\b/, /\bchemistry\b/];
const QUESTION_PATTERNS = [/\bquestions?\b/, /\bsawa?al\b/, /\bpooch/, /\bque\b/, /\basked\b/, /\bproblems?\b/];

/** Ignored when scoring: too common to identify a conversation. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'was', 'were', 'that', 'this', 'with', 'from',
  'what', 'did', 'does', 'have', 'has', 'had', 'are', 'but', 'not', 'all', 'can',
  'give', 'show', 'send', 'list', 'please', 'again', 'back', 'chat', 'chats',
  'mein', 'me', 'ka', 'ki', 'ke', 'ko', 'se', 'tha', 'the', 'hai', 'ho', 'de',
  'do', 'dena', 'dijiye', 'kya', 'wapas', 'wapis', 'dobara', 'pichle', 'pichli',
  'previous', 'earlier', 'last', 'time', 'saved', 'history', 'question', 'questions',
]);

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/** Meaningful tokens, Unicode-aware so Devanagari survives. */
function contentTerms(text) {
  const words = lower(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
  const terms = new Set();
  for (const word of words) {
    if (word.length >= 3 && !STOPWORDS.has(word)) terms.add(word);
  }
  return terms;
}

export function conversationTitle(conversation) {
  const raw = typeof conversation?.title === 'string' ? conversation.title.trim() : '';
  const title = raw || 'Untitled chat';
  return title.length > HISTORY_TITLE_CHARS ? `${title.slice(0, HISTORY_TITLE_CHARS - 1).trimEnd()}…` : title;
}

function usableMessages(conversation) {
  const list = Array.isArray(conversation?.messages) ? conversation.messages : [];
  return list.filter(
    (message) =>
      message &&
      typeof message.content === 'string' &&
      message.content.trim().length > 0 &&
      !message.error,
  );
}

function updatedAt(conversation) {
  const value = Number(conversation?.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Does this message ask about earlier conversations?
 *
 * Deliberately conservative-but-forgiving: a history anchor OR a past-tense
 * marker must appear together with something being asked for. "Write a python
 * function" therefore stays a normal question and costs nothing.
 */
export function detectHistoryIntent(raw) {
  const text = lower(raw).replace(/\s+/g, ' ').trim();
  if (!text) return { isHistory: false, kind: 'none', terms: [] };

  const anchored = HISTORY_ANCHORS.some((pattern) => pattern.test(text));
  const pastTense = PAST_MARKERS.some((pattern) => pattern.test(text));
  const wants = RETRIEVAL_VERBS.some((pattern) => pattern.test(text));
  const isHistory = wants && (anchored || pastTense);

  let kind = 'general';
  if (isHistory) {
    if (CONTINUE_PATTERNS.some((p) => p.test(text))) kind = 'continue';
    else if (CODE_PATTERNS.some((p) => p.test(text))) kind = 'code';
    else if (MATH_PATTERNS.some((p) => p.test(text))) kind = 'math';
    else if (QUESTION_PATTERNS.some((p) => p.test(text))) kind = 'questions';
  } else {
    kind = 'none';
  }

  return { isHistory, kind, terms: [...contentTerms(text)] };
}

/**
 * Rank the user's other conversations against the question.
 *
 * Keyword overlap decides; recency only breaks ties. A maths question should
 * find the maths chat even if an unrelated chat is five minutes newer.
 */
export function rankConversations(conversations, { activeId = null, query = '', now = Date.now() } = {}) {
  const list = Array.isArray(conversations) ? conversations : [];
  const terms = contentTerms(query);
  const scored = [];

  for (const conversation of list) {
    if (!conversation || conversation.id === activeId) continue;
    const messages = usableMessages(conversation);
    if (messages.length === 0) continue;

    const titleTerms = contentTerms(conversationTitle(conversation));
    let score = 0;
    for (const term of terms) {
      if (titleTerms.has(term)) score += 3;
    }
    if (terms.size > 0) {
      const bodyTerms = contentTerms(messages.map((m) => m.content).join(' '));
      for (const term of terms) {
        if (bodyTerms.has(term)) score += 1;
      }
    }

    const age = Math.max(0, now - updatedAt(conversation));
    const recency = 1 / (1 + age / (1000 * 60 * 60 * 24));
    scored.push({ conversation, messages, score: score + recency * 0.5 });
  }

  scored.sort(
    (a, b) => b.score - a.score || updatedAt(b.conversation) - updatedAt(a.conversation),
  );
  return scored;
}

/**
 * Build the `history` field of a chat request.
 *
 * Always returns an `index` (titles prove the chats exist). Adds real message
 * excerpts only when the question is about earlier chats, and reports
 * `ambiguous` when several conversations match so the assistant can ask which.
 */
export function buildHistoryPayload(conversations, { activeId = null, query = '', now = Date.now() } = {}) {
  const intent = detectHistoryIntent(query);
  const ranked = rankConversations(conversations, { activeId, query, now });

  const index = ranked.slice(0, HISTORY_INDEX_LIMIT).map((entry) => ({
    title: conversationTitle(entry.conversation),
    updatedAt: updatedAt(entry.conversation),
    messageCount: entry.messages.length,
  }));

  const payload = {
    intent: intent.kind,
    isHistory: intent.isHistory,
    query: typeof query === 'string' ? query.slice(0, 300) : '',
    index,
    excerpts: [],
    ambiguous: false,
  };

  if (!intent.isHistory) return payload;

  let messageBudget = HISTORY_EXCERPT_MESSAGES;
  let charBudget = HISTORY_BLOCK_CHARS;

  for (const entry of ranked.slice(0, HISTORY_EXCERPT_CONVERSATIONS)) {
    if (messageBudget <= 0 || charBudget <= 0) break;
    const messages = [];
    for (const message of entry.messages) {
      if (messageBudget <= 0 || charBudget <= 0) break;
      const content = message.content.trim().slice(0, HISTORY_MESSAGE_CHARS);
      if (!content) continue;
      if (content.length > charBudget) break;
      messages.push({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content,
      });
      messageBudget -= 1;
      charBudget -= content.length;
    }
    if (messages.length > 0) {
      payload.excerpts.push({
        title: conversationTitle(entry.conversation),
        updatedAt: updatedAt(entry.conversation),
        messages,
      });
    }
  }

  // Several plausible chats: the assistant should name them and ask, not dump
  // six transcripts at the user.
  payload.ambiguous = payload.excerpts.length > 1;
  return payload;
}
