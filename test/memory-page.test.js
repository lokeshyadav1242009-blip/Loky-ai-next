/**
 * LOKY MEMORY — page-level regression tests for the black-screen bug.
 *
 * The bug: opening Memory hid #appShell but nothing ever removed the `hidden`
 * attribute from #memory, so whether the page appeared depended on upgrade.css
 * having loaded. When it had not, both surfaces were display:none and the user
 * saw a blank black screen with no loading state and no error.
 *
 * These tests lock down the wiring, the CSS precedence and the state machine
 * that decides what the page paints.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { listState } from '../public/memory-model.js';
import { normaliseSection, sectionVisibility } from '../public/section-visibility.js';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

/* ------------------------------- visibility ------------------------------- */

test('opening Memory shows the Memory screen and hides the assistant', () => {
  assert.deepEqual(sectionVisibility('memory'), {
    assistant: false,
    messages: false,
    memory: true,
  });
});

test('every section always shows exactly one screen', () => {
  const inputs = ['assistant', 'messages', 'memory', 'nonsense', '', undefined, null];
  for (const input of inputs) {
    const shown = Object.values(sectionVisibility(input)).filter(Boolean);
    assert.equal(shown.length, 1, `${String(input)} must show exactly one screen`);
  }
});

test('an unknown section falls back to the assistant, never to nothing', () => {
  assert.equal(normaliseSection('nope'), 'assistant');
  assert.equal(sectionVisibility('nope').assistant, true);
});

/* ------------------------------ list states ------------------------------- */

test('a first load shows the loading state, not an empty account', () => {
  assert.equal(listState({ loading: true, total: 0, matches: 0 }), 'loading');
});

test('a failed load with no rows shows the error state, not "nothing saved yet"', () => {
  assert.equal(
    listState({ error: 'Could not reach LOKY AI.', total: 0, matches: 0 }),
    'error',
  );
});

test('a failed refresh keeps the rows already on screen', () => {
  assert.equal(listState({ error: 'boom', total: 3, matches: 3 }), 'list');
});

test('empty, needs-supabase and no-match states stay distinct', () => {
  assert.equal(listState({ total: 0, matches: 0 }), 'empty');
  assert.equal(listState({ configured: false, total: 0, matches: 0 }), 'needs-supabase');
  assert.equal(listState({ total: 3, matches: 0 }), 'no-matches');
});

test('listState defaults never throw on an empty call', () => {
  assert.equal(listState(), 'empty');
});

/* --------------------------- wiring regressions --------------------------- */

test('the Memory section is a sibling of the chat shell and ships hidden', () => {
  const html = read('public/index.html');
  const shellEnd = html.indexOf('</main>');
  const memoryAt = html.indexOf('id="memory"');
  assert.ok(memoryAt > 0, 'the Memory section must exist in the markup');
  assert.ok(memoryAt > shellEnd, 'the Memory section must not be nested in the chat shell');
  assert.match(html, /<section[^>]*id="memory"[^>]*hidden/);
});

test('the section switch toggles the Memory section explicitly', () => {
  const app = read('public/app.js');
  assert.match(app, /import \{ sectionVisibility \} from '\.\/section-visibility\.js';/);
  assert.match(app, /memory: document\.getElementById\('memory'\)/);
  assert.match(app, /el\.appShell\.hidden = !visible\.assistant/);
  assert.match(app, /el\.memory\.hidden = !visible\.memory/);
});

test('the hidden attribute wins over the .memory display rule', () => {
  const css = read('public/upgrade.css');
  assert.match(css, /\.memory\[hidden\][^{]*\{[^}]*display:\s*none/);
});

test('the Memory page paints a loading state and a friendly error state', () => {
  const ui = read('public/memory-ui.js');
  assert.match(ui, /Loading your memories/);
  assert.match(ui, /Could not reach LOKY AI/);
  assert.match(ui, /Your memories did not load/);
  assert.match(ui, /function renderFallback/);
  assert.match(ui, /import \{ listState \} from '\.\/memory-model\.js';/);
});

test('the Memory page never falls back to a browser prompt dialog', () => {
  const ui = read('public/memory-ui.js');
  assert.doesNotMatch(ui, /window\.(prompt|confirm)\s*\(/);
  assert.doesNotMatch(ui, /[^.\w](prompt|confirm)\s*\(\s*['"`]/);
});
