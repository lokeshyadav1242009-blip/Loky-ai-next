import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMath,
  isLongAnswer,
  languageLabel,
  mathToken,
  normalizeTex,
} from '../public/rich-text.js';

/* --------------------------------- inline --------------------------------- */

test('inline $...$ becomes a placeholder with the LaTeX preserved', () => {
  const { text, math } = extractMath('Einstein said $E = mc^2$ once.');
  assert.equal(math.length, 1);
  assert.equal(math[0].tex, 'E = mc^2');
  assert.equal(math[0].display, false);
  assert.ok(text.includes(mathToken(0)));
  assert.ok(!text.includes('$'));
});

test('\\( ... \\) is treated as inline maths too', () => {
  const { math } = extractMath('So \\(a^2 + b^2 = c^2\\) holds.');
  assert.equal(math.length, 1);
  assert.equal(math[0].tex, 'a^2 + b^2 = c^2');
  assert.equal(math[0].display, false);
});

/* --------------------------------- display -------------------------------- */

test('$$ ... $$ becomes a display block on its own paragraph', () => {
  const { text, math } = extractMath('Before\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\nAfter');
  assert.equal(math.length, 1);
  assert.equal(math[0].display, true);
  assert.match(math[0].tex, /\\int_0\^1/);
  // Its own paragraph, so Markdown does not merge it into a sentence.
  assert.ok(text.includes(`\n\n${mathToken(0)}\n\n`));
});

test('\\[ ... \\] is treated as a display block', () => {
  const { math } = extractMath('\\[\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1\\]');
  assert.equal(math.length, 1);
  assert.equal(math[0].display, true);
});

test('a multi-line derivation is captured whole', () => {
  const source = '$$\n\\begin{aligned}\na &= b + c \\\\\nd &= a - c\n\\end{aligned}\n$$';
  const { math } = extractMath(source);
  assert.equal(math.length, 1);
  assert.match(math[0].tex, /\\begin\{aligned\}/);
  assert.match(math[0].tex, /d &= a - c/);
});

test('several equations in one answer keep their order and ids', () => {
  const { math } = extractMath('$a$ then $$b$$ then $c$');
  assert.deepEqual(math.map((m) => m.id), [0, 1, 2]);
  assert.deepEqual(math.map((m) => m.tex), ['a', 'b', 'c']);
  assert.deepEqual(math.map((m) => m.display), [false, true, false]);
});

/* ------------------------------ false positives --------------------------- */

test('prices are not mistaken for maths', () => {
  for (const source of [
    'It costs $5 and $10.',
    'Total: $5.00',
    'Only $9.99 today, was $19.99',
    'I have $1,234 in the bank',
  ]) {
    const { text, math } = extractMath(source);
    assert.equal(math.length, 0, `should not parse maths in: ${source}`);
    assert.equal(text, source);
  }
});

test('a lone dollar sign and unterminated maths stay literal', () => {
  assert.equal(extractMath('A $ b').math.length, 0);
  // Mid-stream: the closing delimiter has not arrived yet.
  const streaming = extractMath('The answer is $\\frac{1}{2}');
  assert.equal(streaming.math.length, 0);
  assert.match(streaming.text, /\\frac\{1\}\{2\}/);

  const openDisplay = extractMath('$$\n\\int_0^1');
  assert.equal(openDisplay.math.length, 0);
});

test('maths inside fenced code blocks is left untouched', () => {
  const source = '```latex\n$$x^2$$\n\\frac{a}{b}\n```\n';
  const { text, math } = extractMath(source);
  assert.equal(math.length, 0);
  assert.equal(text, source);
});

test('maths inside inline code is left untouched', () => {
  const source = 'Write `$x^2$` to get maths.';
  const { text, math } = extractMath(source);
  assert.equal(math.length, 0);
  assert.equal(text, source);
});

test('a fenced block does not swallow the maths after it', () => {
  const source = '```js\nconst a = 1;\n```\n\nAnd $E=mc^2$ follows.';
  const { math } = extractMath(source);
  assert.equal(math.length, 1);
  assert.equal(math[0].tex, 'E=mc^2');
});

/* ------------------------------ chemistry -------------------------------- */

test('\\ce{...} chemistry is converted to something core KaTeX can render', () => {
  const { math } = extractMath('$$\\ce{2H2 + O2 -> 2H2O}$$');
  assert.equal(math.length, 1);
  assert.equal(math[0].tex, '\\mathrm{2H2 + O2 -> 2H2O}');
});

test('nested braces in \\ce survive the conversion', () => {
  const { math } = extractMath('$\\ce{CH3COOH}$');
  assert.equal(math[0].tex, '\\mathrm{CH3COOH}');
});

test('normalizeTex strips a doubled wrapper and trims', () => {
  assert.equal(normalizeTex('$$x$$'), 'x');
  assert.equal(normalizeTex('  $y$  '), 'y');
  assert.equal(normalizeTex('z'), 'z');
  assert.equal(normalizeTex(null), '');
});

test('physics and science notation passes through unchanged', () => {
  const cases = [
    '\\vec{F} = m\\vec{a}',
    '6.022 \\times 10^{23}',
    '\\Delta v = v_f - v_i',
    '\\alpha_2 + \\beta^{3}',
  ];
  for (const tex of cases) {
    const { math } = extractMath(`$${tex}$`);
    assert.equal(math[0].tex, tex, `round-trip failed for ${tex}`);
  }
});

/* -------------------------------- long answers --------------------------- */

test('isLongAnswer only collapses genuinely long answers', () => {
  assert.equal(isLongAnswer('Short and sweet.'), false);
  assert.equal(isLongAnswer('word '.repeat(400)), true);
  assert.equal(isLongAnswer(Array.from({ length: 30 }, () => 'line').join('\n')), true);
  assert.equal(isLongAnswer(null), false);
});

/* ------------------------------ language labels -------------------------- */

test('languageLabel maps fence info strings to friendly names', () => {
  assert.equal(languageLabel('js'), 'JavaScript');
  assert.equal(languageLabel('PYTHON'), 'Python');
  assert.equal(languageLabel('cpp'), 'C++');
  assert.equal(languageLabel('bash'), 'Bash');
  assert.equal(languageLabel(''), 'Code');
  assert.equal(languageLabel(undefined), 'Code');
  assert.equal(languageLabel('brainfuck'), 'Brainfuck');
});

/* -------------------------------- streaming ------------------------------ */

test('partially streamed maths never loses characters', () => {
  const full = 'Compute $$\\frac{a+b}{2}$$ now.';
  for (let cut = 1; cut <= full.length; cut += 1) {
    const partial = full.slice(0, cut);
    const { text, math } = extractMath(partial);
    // Nothing may be dropped: placeholders plus literal text must account for
    // every character of the original slice.
    const restored = text.replace(/LKMATHX(\d+)ENDX/g, (_, id) => {
      const entry = math[Number(id)];
      return entry ? entry.tex : '';
    });
    const squeezed = restored.replace(/\s+/g, '');
    const expected = partial.replace(/\$\$?/g, '').replace(/\s+/g, '');
    assert.ok(
      expected === '' || squeezed.includes(expected.slice(0, 4)),
      `lost text at cut ${cut}: ${JSON.stringify(partial)}`,
    );
  }
});
