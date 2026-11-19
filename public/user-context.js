/**
 * USER CONTEXT — structured facts extracted from the user's OWN saved chats.
 *
 * Why this exists
 * ---------------
 * Title matching alone cannot answer "me konsi class me hu": the answer lives
 * inside a message body ("me abhi 11th class me hu"). Ranking conversations
 * gives the model a chat NAME, not the fact.
 *
 * This module reads the messages the user already has in this browser and turns
 * the durable ones into a small, structured list:
 *
 *   { kind, slot, label, value, text, conversationId, conversationTitle,
 *     messageIndex, updatedAt }
 *
 * Every fact keeps its source (conversation id + title + message index) so the
 * server block can cite it and so nothing is invented. Only USER messages are
 * read: the assistant's own earlier wording must never become "memory".
 *
 * Conflict handling: singular attributes (class, stream, course, exam, target,
 * study mode) keep the most recent reliable statement only. Additive facts
 * (projects, preferences, decisions, technologies) are deduplicated by value and
 * all kept, newest first.
 *
 * Pure, deterministic, dependency-free — testable in Node.
 */

/** Facts sent with a request. Compact enough to ride along on every message. */
export const FACT_LIMIT = 12;

/** Verbatim source snippet kept with each fact. */
export const FACT_TEXT_CHARS = 220;

/** Attributes where a newer statement replaces the older one. */
const SINGULAR_SLOTS = new Set([
  'education:class',
  'education:stream',
  'education:course',
  'goal:exam',
  'goal:target',
  'study:mode',
]);

const EXAMS = [
  ['jee advanced', 'JEE Advanced'],
  ['jee mains', 'JEE Main'],
  ['jee main', 'JEE Main'],
  ['jee', 'JEE'],
  ['neet', 'NEET'],
  ['cuet', 'CUET'],
  ['upsc', 'UPSC'],
  ['bitsat', 'BITSAT'],
  ['gate', 'GATE'],
  ['olympiad', 'Olympiad'],
  ['board exams', 'Board exams'],
];

const STREAMS = [
  ['pcmb', 'PCMB'],
  ['pcm', 'PCM'],
  ['pcb', 'PCB'],
  ['science', 'Science'],
  ['commerce', 'Commerce'],
  ['humanities', 'Humanities'],
  ['arts', 'Arts'],
];

const COURSES = [
  ['b.tech', 'B.Tech'],
  ['btech', 'B.Tech'],
  ['b.e.', 'B.E.'],
  ['bca', 'BCA'],
  ['mca', 'MCA'],
  ['b.sc', 'B.Sc'],
  ['m.sc', 'M.Sc'],
  ['b.com', 'B.Com'],
  ['mba', 'MBA'],
  ['mbbs', 'MBBS'],
  ['b.ed', 'B.Ed'],
];

/** Canonical display names for technologies the user mentions. */
const TECHNOLOGIES = [
  ['next.js', 'Next.js'],
  ['nextjs', 'Next.js'],
  ['react', 'React'],
  ['node.js', 'Node.js'],
  ['nodejs', 'Node.js'],
  ['express', 'Express'],
  ['typescript', 'TypeScript'],
  ['javascript', 'JavaScript'],
  ['python', 'Python'],
  ['java', 'Java'],
  ['kotlin', 'Kotlin'],
  ['swift', 'Swift'],
  ['php', 'PHP'],
  ['laravel', 'Laravel'],
  ['django', 'Django'],
  ['flask', 'Flask'],
  ['supabase', 'Supabase'],
  ['postgresql', 'PostgreSQL'],
  ['postgres', 'PostgreSQL'],
  ['mongodb', 'MongoDB'],
  ['mysql', 'MySQL'],
  ['tailwind', 'Tailwind CSS'],
  ['gemini', 'Gemini'],
  ['openai', 'OpenAI'],
  ['docker', 'Docker'],
  ['vercel', 'Vercel'],
  ['firebase', 'Firebase'],
  ['flutter', 'Flutter'],
];

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'was', 'were', 'that', 'this', 'with', 'from',
  'what', 'did', 'does', 'have', 'has', 'had', 'are', 'but', 'not', 'all', 'can',
  'mein', 'me', 'ka', 'ki', 'ke', 'ko', 'se', 'tha', 'hai', 'ho', 'de', 'do',
  'kya', 'wapis', 'wapas', 'pichle', 'pichli', 'previous', 'earlier', 'last',
]);

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function clamp(value, max) {
  const text = clean(value);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function terms(text) {
  const words = lower(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
  const found = new Set();
  for (const word of words) {
    if (word.length >= 3 && !STOPWORDS.has(word)) found.add(word);
  }
  return found;
}

function stamp(conversation) {
  const value = Number(conversation?.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

function title(conversation) {
  const raw = clean(conversation?.title);
  return raw ? clamp(raw, 80) : 'Untitled chat';
}

/** "class 11", "11th class", "in 11th" — but never a stray number. */
function classFact(text) {
  const match =
    /\b(?:class|kaksha|kakshaa|std|standard|grade)\s*[-:]?\s*(\d{1,2})(?:\s*(?:th|st|nd|rd))?\b/.exec(text) ||
    /\b(\d{1,2})\s*(?:th|st|nd|rd)\s*(?:class|grade|std|standard|kaksha)\b/.exec(text) ||
    /\b(?:in|me)\s+(\d{1,2})(?:th|st|nd|rd)\b/.exec(text);
  if (!match) return null;
  const grade = Number(match[1]);
  if (!(grade >= 1 && grade <= 12)) return null;
  return { kind: 'education', slot: 'education:class', label: 'Class / grade', value: `Class ${grade}` };
}

function examFact(text) {
  for (const [needle, display] of EXAMS) {
    const pattern = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (pattern.test(text)) {
      return { kind: 'goal', slot: 'goal:exam', label: 'Exam goal', value: display };
    }
  }
  return null;
}

function streamFact(text) {
  for (const [needle, display] of STREAMS) {
    if (new RegExp(`\\b${needle}\\b`).test(text)) {
      return { kind: 'education', slot: 'education:stream', label: 'Stream', value: display };
    }
  }
  return null;
}

function courseFact(text) {
  for (const [needle, display] of COURSES) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}(?![a-z])`).test(text)) {
      return { kind: 'education', slot: 'education:course', label: 'Course', value: display };
    }
  }
  return null;
}

function studyModeFact(text) {
  const online = /\bonline\b/.test(text) ? 'Online' : /\boffline\b/.test(text) ? 'Offline' : '';
  const mission = /mission\s+jee/.test(text) ? 'Mission JEE' : '';
  const coaching = /(?:coaching|classes|institute|academy)\s+(?:from|at|se|mein)?\s*([^.,\n!?]{3,40})/.exec(text);
  const source = mission || (coaching ? clean(coaching[1]) : '');
  const parts = [online, source].filter(Boolean);
  if (parts.length === 0) return null;
  return { kind: 'education', slot: 'study:mode', label: 'Study mode', value: parts.join(' · ') };
}

function targetFact(text) {
  const match =
    /(?:my (?:goal|target|aim) is|i want to|i wanna|target(?:ing)?|crack)\s+([^.,\n!?]{3,70})/i.exec(text);
  if (!match) return null;
  const value = clean(match[1]).replace(/^(?:a|an|the|to)\s+/i, '');
  if (!value) return null;
  return { kind: 'goal', slot: 'goal:target', label: 'Goal', value };
}

function projectFact(text) {
  const match =
    /(?:building|developing|making|creating|working on|bana raha|bana rahi|bana rahe)\s+([^.,\n!?]{3,70})/i.exec(text) ||
    /my (?:project|app|website|startup|game)\s*(?:is|:)?\s*([^.,\n!?]{3,70})/i.exec(text);
  if (!match) return null;
  const value = clean(match[1]).replace(/^(?:a|an|the)\s+/i, '');
  if (!value) return null;
  return { kind: 'project', slot: `project:${lower(value).slice(0, 40)}`, label: 'Project', value };
}

function preferenceFact(text) {
  const hinglish = /mujhe\s+([^.,\n!?]{3,50}?)\s+pasand/i.exec(text);
  const english =
    /(?:i prefer|i like|i love|i enjoy|favourite|favorite)\s+([^.,\n!?]{3,60})/i.exec(text);
  const match = hinglish || english;
  if (!match) return null;
  const value = clean(match[1]).replace(/^(?:a|an|the|to)\s+/i, '');
  if (!value) return null;
  return { kind: 'preference', slot: `preference:${lower(value).slice(0, 40)}`, label: 'Preference', value };
}

function decisionFact(text) {
  const match = /(?:we|i)\s+(?:decided|finali[sz]ed|finali[sz]e|chose|chosen|settled on|went with)\s+([^.,\n!?]{3,70})/i.exec(text);
  if (!match) return null;
  const value = clean(match[1]).replace(/^(?:a|an|the|to)\s+/i, '');
  if (!value) return null;
  return { kind: 'decision', slot: `decision:${lower(value).slice(0, 40)}`, label: 'Decision', value };
}

function technologyFacts(text) {
  const found = [];
  for (const [needle, display] of TECHNOLOGIES) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}(?![a-z])`).test(text)) {
      found.push({ kind: 'technical', slot: `technical:${lower(display)}`, label: 'Technology', value: display });
    }
  }
  return found;
}

/** Every fact a single user message states. */
export function extractFromMessage(raw) {
  const text = lower(clean(raw));
  if (!text) return [];
  const found = [
    classFact(text),
    examFact(text),
    streamFact(text),
    courseFact(text),
    studyModeFact(text),
    targetFact(text),
    projectFact(text),
    preferenceFact(text),
    decisionFact(text),
    ...technologyFacts(text),
  ].filter(Boolean);

  const seen = new Set();
  return found.filter((fact) => {
    const key = `${fact.kind}:${lower(fact.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function newestFirst(a, b) {
  return b.updatedAt - a.updatedAt || b.messageIndex - a.messageIndex;
}

/**
 * All durable facts from the user's other conversations, newest first.
 * The active conversation is skipped: its messages are already in the request.
 */
export function extractFacts(conversations, { activeId = null, limit = FACT_LIMIT } = {}) {
  const list = Array.isArray(conversations) ? conversations : [];
  const candidates = [];

  for (const conversation of list) {
    if (!conversation || conversation.id === activeId) continue;
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    messages.forEach((message, messageIndex) => {
      if (!message || message.role !== 'user' || typeof message.content !== 'string') return;
      if (message.error) return;
      const text = clean(message.content);
      if (!text) return;
      for (const fact of extractFromMessage(text)) {
        candidates.push({
          ...fact,
          text: clamp(text, FACT_TEXT_CHARS),
          conversationId: typeof conversation.id === 'string' ? conversation.id : '',
          conversationTitle: title(conversation),
          messageIndex,
          updatedAt: stamp(conversation),
        });
      }
    });
  }

  candidates.sort(newestFirst);

  const singular = new Map();
  const additive = new Map();
  for (const fact of candidates) {
    if (SINGULAR_SLOTS.has(fact.slot)) {
      // Newest statement wins: "class 11" then later "class 12" keeps 12.
      if (!singular.has(fact.slot)) singular.set(fact.slot, fact);
      continue;
    }
    const key = `${fact.kind}:${lower(fact.value)}`;
    if (!additive.has(key)) additive.set(key, fact);
  }

  return [...singular.values(), ...additive.values()].sort(newestFirst).slice(0, limit);
}

/**
 * Facts that plausibly answer this question: keyword overlap first, then core
 * identity facts (education/goals) so "which class am I in" always has the
 * class even when the wording does not literally match a label.
 */
export function relevantFacts(facts, query, { limit = FACT_LIMIT, core = ['education', 'goal'] } = {}) {
  const list = Array.isArray(facts) ? facts : [];
  const queryTerms = terms(query);

  const scored = list.map((fact) => {
    const label = `${fact.label} ${fact.value}`.toLowerCase();
    const haystack = `${label} ${lower(fact.text)}`;
    let score = 0;
    for (const term of queryTerms) {
      if (label.includes(term)) score += 2;
      else if (haystack.includes(term)) score += 1;
    }
    return { fact, score };
  });

  const matched = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || newestFirst(a.fact, b.fact))
    .map((entry) => entry.fact);

  const seen = new Set(matched.map((fact) => `${fact.slot}|${lower(fact.value)}`));
  const fillers = list.filter(
    (fact) => core.includes(fact.kind) && !seen.has(`${fact.slot}|${lower(fact.value)}`),
  );

  return [...matched, ...fillers].slice(0, limit);
}
