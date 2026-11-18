/**
 * RICH RESPONSE ENGINE — pure text analysis.
 *
 * The renderer in public/app.js needs to do two things that a plain
 * Markdown -> HTML pipeline cannot:
 *
 *  1. Hand maths to KaTeX instead of letting Markdown eat it. `$x_1$` and
 *     `\frac{a}{b}` would otherwise lose their underscores and backslashes to
 *     emphasis and escaping rules.
 *  2. Know when an answer is long enough to be worth collapsing.
 *
 * Both decisions are made here, as string transformations, so they are
 * testable in Node without a DOM. The KaTeX call itself stays in app.js
 * because it needs real elements.
 *
 * Delimiters supported: $...$, $$...$$, \( ... \), \[ ... \]
 */

/** Token that survives Markdown + DOMPurify untouched, then becomes maths. */
export const MATH_TOKEN_PREFIX = 'LKMATHX';
export const MATH_TOKEN_SUFFIX = 'ENDX';
const MATH_TOKEN_RE = /LKMATHX(\d+)ENDX/g;

export function mathToken(id) {
  return `${MATH_TOKEN_PREFIX}${id}${MATH_TOKEN_SUFFIX}`;
}

/** Matches one placeholder token in already-rendered HTML. */
export function mathTokenPattern() {
  return MATH_TOKEN_RE;
}

/**
 * Normalise a LaTeX fragment before it reaches KaTeX.
 *
 * - `\ce{H2O}` (mhchem, not in core KaTeX) becomes `\mathrm{H2O}` so chemistry
 *   written that way still renders instead of throwing a parse error.
 * - Stray surrounding `$` / `\[` that a model sometimes nests are stripped.
 * - `\text{...}` with real newlines is preserved; nothing else is rewritten,
 *   because KaTeX understands the rest.
 */
export function normalizeTex(tex) {
  let out = String(tex ?? '').trim();

  // Strip a redundant wrapper the model may have double-added.
  out = out.replace(/^\$\$?([\s\S]*?)\$\$?$/, '$1').trim();

  // \ce{...} -> \mathrm{...} (balanced-brace aware, so \ce{H2O} works and
  // nested braces such as \ce{CH3COOH} do not truncate).
  out = replaceBraced(out, '\\ce', (inner) => `\\mathrm{${inner}}`);
  out = replaceBraced(out, '\\pu', (inner) => `\\mathrm{${inner}}`);

  return out;
}

/**
 * Replace every `\name{...}` occurrence, keeping the braces balanced.
 * KaTeX is fed the result, so malformed input must not throw here.
 */
function replaceBraced(text, name, transform) {
  let out = '';
  let index = 0;
  for (;;) {
    const start = text.indexOf(name, index);
    if (start === -1) {
      out += text.slice(index);
      return out;
    }
    // Guard against \cel or \pu being a prefix of a longer command.
    const after = text[start + name.length];
    if (after !== '{') {
      out += text.slice(index, start + name.length);
      index = start + name.length;
      continue;
    }

    let depth = 0;
    let cursor = start + name.length;
    let end = -1;
    for (; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (char === '\\') {
        cursor += 1;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = cursor;
          break;
        }
      }
    }
    if (end === -1) {
      // Unbalanced (still streaming) — leave it alone for this pass.
      out += text.slice(index);
      return out;
    }

    const inner = text.slice(start + name.length + 1, end);
    out += text.slice(index, start) + transform(inner);
    index = end + 1;
  }
}

/**
 * Pull maths out of Markdown and replace it with inert placeholders.
 *
 * Fenced code blocks and inline code spans are skipped entirely: maths inside
 * a code sample must stay literal, which is exactly the case a naive regex
 * gets wrong.
 *
 * @param {string} source raw model output (possibly mid-stream)
 * @returns {{ text: string, math: Array<{ id: number, tex: string, display: boolean }> }}
 */
export function extractMath(source) {
  const text = typeof source === 'string' ? source : '';
  const math = [];
  let out = '';
  let index = 0;
  let fence = null; // '```' or '~~~' while inside a fenced block

  const push = (tex, display) => {
    const cleaned = normalizeTex(tex);
    if (!cleaned) return false;
    const id = math.length;
    math.push({ id, tex: cleaned, display });
    // Display maths gets its own paragraph so it is not glued to a sentence.
    out += display ? `\n\n${mathToken(id)}\n\n` : mathToken(id);
    return true;
  };

  while (index < text.length) {
    const lineStart = index === 0 || text[index - 1] === '\n';

    // ---- fenced code blocks ------------------------------------------------
    if (lineStart) {
      const rest = text.slice(index);
      const fenceMatch = rest.match(/^([ \t]{0,3})(```+|~~~+)/);
      if (fenceMatch) {
        const marker = fenceMatch[2][0].repeat(3);
        if (fence === null) {
          fence = marker;
        } else if (marker === fence) {
          fence = null;
        }
        const newline = rest.indexOf('\n');
        const chunk = newline === -1 ? rest : rest.slice(0, newline + 1);
        out += chunk;
        index += chunk.length;
        continue;
      }
    }

    if (fence !== null) {
      // Inside a fence: copy verbatim until the closing marker line.
      const nextLine = text.indexOf('\n', index);
      const chunk = nextLine === -1 ? text.slice(index) : text.slice(index, nextLine + 1);
      out += chunk;
      index += chunk.length;
      continue;
    }

    // ---- inline code spans -------------------------------------------------
    if (text[index] === '`') {
      let ticks = 1;
      while (text[index + ticks] === '`') ticks += 1;
      const closeAt = text.indexOf('`'.repeat(ticks), index + ticks);
      if (closeAt !== -1) {
        const chunk = text.slice(index, closeAt + ticks);
        out += chunk;
        index += chunk.length;
        continue;
      }
    }

    // ---- display maths: $$ ... $$ and \[ ... \] ---------------------------
    if (text.startsWith('$$', index)) {
      const close = text.indexOf('$$', index + 2);
      if (close !== -1) {
        const tex = text.slice(index + 2, close);
        if (push(tex, true)) {
          index = close + 2;
          continue;
        }
      }
      // Unterminated (still streaming): emit literally for now.
      out += '$$';
      index += 2;
      continue;
    }

    if (text.startsWith('\\[', index)) {
      const close = text.indexOf('\\]', index + 2);
      if (close !== -1) {
        const tex = text.slice(index + 2, close);
        if (push(tex, true)) {
          index = close + 2;
          continue;
        }
      }
      out += '\\[';
      index += 2;
      continue;
    }

    // ---- inline maths: \( ... \) and $ ... $ ------------------------------
    if (text.startsWith('\\(', index)) {
      const close = text.indexOf('\\)', index + 2);
      if (close !== -1) {
        const tex = text.slice(index + 2, close);
        if (push(tex, false)) {
          index = close + 2;
          continue;
        }
      }
      out += '\\(';
      index += 2;
      continue;
    }

    if (text[index] === '$' && text[index - 1] !== '\\') {
      const found = findInlineDollarClose(text, index);
      if (found !== -1) {
        const tex = text.slice(index + 1, found);
        if (push(tex, false)) {
          index = found + 1;
          continue;
        }
      }
      out += '$';
      index += 1;
      continue;
    }

    out += text[index];
    index += 1;
  }

  return { text: out, math };
}

/**
 * Locate the closing `$` of an inline equation starting at `open`.
 * Returns -1 when this is not really maths (currency, unterminated, multiline).
 */
function findInlineDollarClose(text, open) {
  const first = text[open + 1];
  // "$5 and $10" is money, not an equation.
  if (first === undefined || /\s/.test(first) || first === '$') return -1;

  for (let i = open + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\n') return -1; // inline maths never spans lines
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '$') {
      const before = text[i - 1];
      if (/\s/.test(before)) return -1; // "$ x $" is not maths either
      const tex = text.slice(open + 1, i);
      if (tex.trim().length === 0) return -1;
      // A bare number in dollars is almost always a price.
      if (/^\d[\d,.]*$/.test(tex.trim()) && !/[\\^_=+\-*/]/.test(tex)) return -1;
      return i;
    }
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Long answers                                                               */
/* -------------------------------------------------------------------------- */

export const LONG_ANSWER_CHARS = 1800;
export const LONG_ANSWER_LINES = 26;

/**
 * Should this answer start collapsed behind a "Show more" control?
 * Short answers, and answers that are mostly a single code block, stay open.
 */
export function isLongAnswer(text, { chars = LONG_ANSWER_CHARS, lines = LONG_ANSWER_LINES } = {}) {
  const source = typeof text === 'string' ? text : '';
  if (source.length > chars) return true;
  return source.split('\n').length > lines;
}

/* -------------------------------------------------------------------------- */
/* Code fences                                                                */
/* -------------------------------------------------------------------------- */

const LANG_ALIASES = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  mjs: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  jsx: 'JSX',
  py: 'Python',
  python: 'Python',
  rb: 'Ruby',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  'c++': 'C++',
  cs: 'C#',
  go: 'Go',
  rust: 'Rust',
  rs: 'Rust',
  php: 'PHP',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Shell',
  sql: 'SQL',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  html: 'HTML',
  css: 'CSS',
  md: 'Markdown',
  tex: 'LaTeX',
  latex: 'LaTeX',
  r: 'R',
  kt: 'Kotlin',
  swift: 'Swift',
  dart: 'Dart',
};

/** Human label for a fence info string ("js" -> "JavaScript"). */
export function languageLabel(raw) {
  const key = String(raw ?? '').trim().toLowerCase().split(/\s+/)[0];
  if (!key) return 'Code';
  return LANG_ALIASES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
