import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUMMARY_MAX_CHARS,
  buildSummaryMessages,
  clampTranscript,
  conversationTokens,
  estimateTokens,
  normalizeSummary,
  normalizeSummaryInput,
  selectWindow,
  summaryBlock,
  validateSummaryRequest,
} from '../server/context.js';

const msg = (role, content, extra = {}) => ({ role, content, ...extra });

const many = (count, chars = 400) => {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(msg(i % 2 === 0 ? 'user' : 'assistant', 'w'.repeat(chars)));
  }
  return out;
};

/* --------------------------------- tokens -------------------------------- */

test('estimateTokens ignores non-strings and grows with length', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(123), 0);
  assert.ok(estimateTokens('x'.repeat(320)) > estimateTokens('x'.repeat(32)));
});

test('conversationTokens charges attached images like the provider does', () => {
  const textOnly = conversationTokens([msg('user', 'hello')]);
  const withImage = conversationTokens([msg('user', 'hello', { images: ['data:image/png;base64,x'] })]);
  assert.ok(withImage > textOnly + 1000);
  assert.equal(conversationTokens(null), 0);
});

/* ------------------------------- the window ------------------------------- */

test('selectWindow keeps the newest turns and reports what it trimmed', () => {
  const messages = many(40);
  const { recent, older, trimmed } = selectWindow(messages, 2000);

  assert.equal(trimmed, true);
  assert.ok(older.length > 0, 'the over-budget turns must be handed to the summariser');
  assert.ok(recent.length > 0);
  // The turn the user just sent must always reach the model.
  assert.equal(recent[recent.length - 1], messages[messages.length - 1]);
  assert.equal(recent.length + older.length, messages.length);
});

test('selectWindow never returns an empty window for a non-empty conversation', () => {
  const { recent } = selectWindow([msg('user', 'z'.repeat(200000))], 100);
  assert.equal(recent.length, 1);
});

test('selectWindow keeps at least the configured number of recent turns', () => {
  const { recent } = selectWindow(many(30, 500), 1, { minRecent: 8 });
  assert.equal(recent.length, 8);
});

test('selectWindow returns an empty result for an empty conversation', () => {
  assert.deepEqual(selectWindow([], 1000), { recent: [], older: [], trimmed: false });
});

/* -------------------------------- summarising ----------------------------- */

test('buildSummaryMessages folds the previous summary into a rolling request', () => {
  const built = buildSummaryMessages(
    [msg('user', 'I am a JEE aspirant.'), msg('assistant', 'Noted.')],
    'User is preparing for JEE.',
  );

  assert.equal(built.length, 1);
  assert.equal(built[0].role, 'user');
  assert.match(built[0].content, /SUMMARY SO FAR/);
  assert.match(built[0].content, /JEE aspirant/);
  assert.match(built[0].content, /Return ONLY the updated summary/);
});

test('buildSummaryMessages works without a previous summary', () => {
  const built = buildSummaryMessages([msg('user', 'hello')]);
  assert.doesNotMatch(built[0].content, /SUMMARY SO FAR/);
  assert.match(built[0].content, /NEW MESSAGES TO FOLD IN/);
});

test('normalizeSummary strips fences and labels and caps the length', () => {
  assert.equal(normalizeSummary('```\n- point\n```'), '- point');
  assert.equal(normalizeSummary('Summary: - point'), '- point');
  assert.equal(normalizeSummary('   '), '');
  assert.equal(normalizeSummary(null), '');
  assert.equal(normalizeSummary({ text: 'x' }), '');

  const long = normalizeSummary('a'.repeat(SUMMARY_MAX_CHARS + 500));
  assert.ok(long.length <= SUMMARY_MAX_CHARS);
});

test('summaryBlock is empty without a summary and never claims one exists', () => {
  assert.equal(summaryBlock(''), '');
  assert.equal(summaryBlock(null), '');

  const block = summaryBlock('User is in Class 11.');
  assert.match(block, /User is in Class 11\./);
  assert.match(block, /Do not mention that a summary exists/);
});

test('normalizeSummaryInput only accepts strings', () => {
  assert.equal(normalizeSummaryInput({ evil: true }), '');
  assert.equal(normalizeSummaryInput(42), '');
  assert.equal(normalizeSummaryInput(' ok '), 'ok');
});

test('clampTranscript keeps the head and the tail when the transcript is too long', () => {
  const messages = many(40, 200);
  const clamped = clampTranscript(messages, 800);

  assert.ok(clamped.length < 1200);
  assert.match(clamped, /omitted for length/);
  assert.match(clamped, /w{50}/);
});

/* -------------------------- summary request validation -------------------- */

test('validateSummaryRequest rejects unusable bodies', () => {
  assert.match(validateSummaryRequest(null).error, /JSON object/);
  assert.match(validateSummaryRequest([]).error, /JSON object/);
  assert.match(validateSummaryRequest({ messages: [] }).error, /nothing to summarise/i);
  assert.match(
    validateSummaryRequest({ messages: [{ role: 'system', content: 'x' }] }).error,
    /nothing to summarise/i,
  );
});

test('validateSummaryRequest keeps valid turns and drops unknown fields', () => {
  const result = validateSummaryRequest({
    previousSummary: 'prior',
    messages: [
      { role: 'user', content: 'hi', secret: 'must not leak' },
      { role: 'assistant', content: 'yo', images: ['a', 'b'] },
      { role: 'system', content: 'drop me' },
      { role: 'user', content: '   ' },
    ],
  });

  assert.equal(result.error, null);
  assert.equal(result.previousSummary, 'prior');
  assert.equal(result.messages.length, 2);
  assert.deepEqual(Object.keys(result.messages[0]).sort(), ['content', 'role']);
  assert.equal(result.messages[1].images, 2);
});
