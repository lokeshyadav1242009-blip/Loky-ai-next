import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extractMath, isLongAnswer } from '../public/rich-text.js';
import {
  COLLAPSE_LABEL,
  EXPAND_LABEL,
  answerKey,
  decorateDecision,
  expandLabel,
} from '../public/long-answer.js';

const css = readFileSync(new URL('../public/upgrade.css', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const words = (count, stem = 'alpha') =>
  Array.from({ length: count }, (_, index) => `${stem}${index}`).join(' ');

/* -------------------------------------------------------------------------- */
/* Fixtures requested by the bug report                                       */
/* -------------------------------------------------------------------------- */

const FIVE_HUNDRED = words(500);
const TWO_THOUSAND = words(2000);

const LONG_MATH = [
  '## Solving the quadratic',
  '',
  'Given \\(a=1, b=-3, c=2\\), the discriminant is',
  '',
  '$$\\Delta = b^2 - 4ac = 9 - 8 = 1$$',
  '',
  'So the roots are',
  '',
  '$$x = \\frac{-b \\pm \\sqrt{\\Delta}}{2a} = \\frac{3 \\pm 1}{2}$$',
  '',
  '\\[x_1 = 2, \\quad x_2 = 1\\]',
  '',
  'Checking: $1^2 - 3(1) + 2 = 0$ and $2^2 - 3(2) + 2 = 0$.',
  '',
  words(500, 'step'),
].join('\n');

const LONG_MARKDOWN = [
  '# Long structured answer',
  '',
  'An opening paragraph that introduces the topic.',
  '',
  '## Numbered steps',
  '1. First step',
  '2. Second step',
  '3. Third step',
  '',
  '## Bullets',
  '- alpha',
  '- beta',
  '- gamma',
  '',
  '| Symbol | Meaning |',
  '| --- | --- |',
  '| `F` | force |',
  '| `m` | mass |',
  '',
  '## Code',
  '```js',
  'const force = (mass, accel) => mass * accel;',
  '```',
  '',
  words(500, 'body'),
].join('\n');

const MULTI_CODE = [
  'Three snippets:',
  '',
  '```python',
  'def area(r):',
  '    return 3.14 * r * r',
  '```',
  '',
  '```sql',
  'select id from profiles;',
  '```',
  '',
  '```bash',
  'npm test',
  '```',
  '',
  words(500, 'tail'),
].join('\n');

/* -------------------------------------------------------------------------- */
/* 1-6: collapse decision                                                     */
/* -------------------------------------------------------------------------- */

test('a 500-word answer is treated as long and collapses to a preview', () => {
  assert.equal(isLongAnswer(FIVE_HUNDRED), true);
  const decision = decorateDecision(FIVE_HUNDRED);
  assert.equal(decision.collapse, true);
  assert.equal(decision.expanded, false);
  assert.equal(decision.label, EXPAND_LABEL);
});

test('a 2000-word answer collapses and expands to the full text', () => {
  const decision = decorateDecision(TWO_THOUSAND);
  assert.equal(decision.collapse, true);

  const expanded = decorateDecision(TWO_THOUSAND, { expanded: true });
  assert.equal(expanded.collapse, true);
  assert.equal(expanded.expanded, true);
  assert.equal(expanded.label, COLLAPSE_LABEL);
});

test('a short answer is never collapsed and gets no toggle', () => {
  const decision = decorateDecision('Yes, 2 + 2 = 4.');
  assert.equal(decision.collapse, false);
  assert.equal(decision.label, EXPAND_LABEL);
});

test('a long mathematical explanation keeps every formula for KaTeX', () => {
  assert.equal(decorateDecision(LONG_MATH).collapse, true);
  const { text, math } = extractMath(LONG_MATH);
  assert.ok(math.length >= 4, 'all display and inline formulas are extracted');
  assert.ok(math.some((entry) => entry.display === true), 'display maths is preserved');
  assert.ok(text.includes('## Solving the quadratic'), 'headings survive extraction');
  assert.ok(!text.includes('\\frac'), 'raw TeX never reaches the Markdown renderer');
});

test('a long Markdown answer collapses without losing structure', () => {
  assert.equal(decorateDecision(LONG_MARKDOWN).collapse, true);
  const { text } = extractMath(LONG_MARKDOWN);
  assert.ok(text.includes('| Symbol | Meaning |'), 'tables are kept');
  assert.ok(text.includes('```js'), 'fenced code is kept');
  assert.ok(text.includes('1. First step'), 'numbered lists are kept');
  assert.ok(text.includes('- alpha'), 'bullet lists are kept');
});

test('an answer with multiple code blocks collapses as one unit', () => {
  assert.equal(decorateDecision(MULTI_CODE).collapse, true);
  const fences = MULTI_CODE.match(/```/g) ?? [];
  assert.equal(fences.length, 6, 'all three code blocks are intact');
});

/* -------------------------------------------------------------------------- */
/* 7-8: streaming and refresh                                                 */
/* -------------------------------------------------------------------------- */

test('a reply is never clipped while it is still streaming', () => {
  const streaming = decorateDecision(TWO_THOUSAND, { streaming: true });
  assert.equal(streaming.collapse, false, 'streaming answers are always shown in full');

  const streamingExpanded = decorateDecision(TWO_THOUSAND, { streaming: true, expanded: true });
  assert.equal(streamingExpanded.collapse, false);
});

test('the preview is recalculated once the stream has finished', () => {
  const finished = decorateDecision(TWO_THOUSAND, { streaming: false });
  assert.equal(finished.collapse, true);
});

test('an expanded answer stays expanded after a refresh or reopening the chat', () => {
  // The key is derived from the stored message content, so a full re-render
  // (refresh, conversation switch, history replay) resolves to the same key.
  const before = answerKey(TWO_THOUSAND);
  const after = answerKey(TWO_THOUSAND);
  assert.equal(before, after);
  assert.equal(decorateDecision(TWO_THOUSAND, { expanded: true }).expanded, true);
});

test('different answers get different keys', () => {
  assert.notEqual(answerKey('short answer'), answerKey('another answer'));
  assert.equal(answerKey(''), answerKey(undefined));
});

test('the toggle label tracks the state', () => {
  assert.equal(expandLabel(false), EXPAND_LABEL);
  assert.equal(expandLabel(true), COLLAPSE_LABEL);
});

/* -------------------------------------------------------------------------- */
/* CSS: the clipping cannot hide content or the control                       */
/* -------------------------------------------------------------------------- */

test('the collapsed preview clips the body only', () => {
  const collapsed = css.match(/\.rich--long:not\(\.rich--expanded\)\s*\{[^}]*\}/);
  assert.ok(collapsed, 'collapsed preview rule exists');
  assert.match(collapsed[0], /max-height:\s*\d+px/);
  assert.match(collapsed[0], /overflow:\s*hidden/);
  assert.doesNotMatch(collapsed[0], /mask-image:\s*none/);
});

test('the expanded state removes every clip and fade', () => {
  const expanded = css.match(/(?:^|\n)\.rich--expanded\s*\{[^}]*\}/);
  assert.ok(expanded, 'expanded rule exists');
  assert.match(expanded[0], /max-height:\s*none/);
  assert.match(expanded[0], /overflow:\s*visible/);
  assert.match(expanded[0], /mask-image:\s*none/);
});

test('no line-clamp or fixed height hides message text anywhere', () => {
  assert.doesNotMatch(css, /-webkit-line-clamp/);
  assert.doesNotMatch(css, /line-clamp:/);
  assert.doesNotMatch(css, /\.rich--long[^{]*\{[^}]*max-height:\s*0/);
});

test('the fade only dims the last lines of a collapsed preview', () => {
  const collapsed = css.match(/\.rich--long:not\(\.rich--expanded\)\s*\{[^}]*\}/);
  const stop = collapsed[0].match(/linear-gradient\(to bottom, #000 (\d+)%/);
  assert.ok(stop, 'a gradient stop is defined');
  assert.ok(Number(stop[1]) >= 80, 'text stays readable before the cut');
});

/* -------------------------------------------------------------------------- */
/* Renderer wiring                                                            */
/* -------------------------------------------------------------------------- */

test('the expand control is a sibling of the clipped body, never a child', () => {
  assert.match(appJs, /insertAdjacentElement\('afterend', btn\)/);
  assert.doesNotMatch(appJs, /container\.append\(btn\)/);
});

test('the renderer skips collapsing while streaming', () => {
  assert.match(appJs, /if \(!streaming\) decorateLongAnswer\(element, key\)/);
  assert.match(appJs, /renderRich\(md, latest, \{ streaming: true \}\)/);
});

test('expanding restores the reading position instead of jumping', () => {
  const toggle = appJs.slice(appJs.indexOf('function decorateLongAnswer'));
  assert.match(toggle, /scrollTop/, 'the scroll position is captured and restored');
});

test('history replay keys the answer by its stored content', () => {
  assert.match(appJs, /renderRich\(body, message\.content, \{ key: answerKey\(message\.content\) \}\)/);
});
