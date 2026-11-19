import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORY_LIMITS,
  formatHistoryDate,
  historyBlock,
  normalizeHistoryInput,
} from '../server/history.js';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

test('formatHistoryDate renders a stable ISO day', () => {
  assert.equal(formatHistoryDate(NOW), '2026-11-20');
  assert.equal(formatHistoryDate('2026-11-20T12:00:00.000Z'), '2026-11-20');
  assert.equal(formatHistoryDate(null), '');
  assert.equal(formatHistoryDate('not a date'), '');
});

test('normalizeHistoryInput tolerates missing or hostile input', () => {
  for (const input of [null, undefined, 'nope', 42, [], { index: 'x', excerpts: 5 }]) {
    const result = normalizeHistoryInput(input);
    assert.ok(Array.isArray(result.index), 'index must be an array');
    assert.ok(Array.isArray(result.excerpts), 'excerpts must be an array');
  }
});

test('normalizeHistoryInput drops unusable entries and keeps real ones', () => {
  const result = normalizeHistoryInput({
    index: [
      { title: 'Maths doubts', updatedAt: NOW, messageCount: 4 },
      { title: '', updatedAt: 'bad' },
      null,
    ],
    excerpts: [
      {
        title: 'Maths doubts',
        updatedAt: NOW,
        messages: [
          { role: 'user', content: 'Solve 2x + 5 = 15' },
          { role: 'assistant', content: 'x = 5' },
          { role: 'tool', content: 'ignored role' },
          { role: 'user', content: '   ' },
          { content: 'missing role' },
        ],
      },
      { title: 'empty', messages: [] },
    ],
  });

  assert.equal(result.index.length, 1);
  assert.equal(result.index[0].title, 'Maths doubts');

  assert.equal(result.excerpts.length, 1);
  const messages = result.excerpts[0].messages;
  assert.ok(messages.length >= 2);
  for (const message of messages) {
    assert.ok(['user', 'assistant'].includes(message.role), `bad role: ${message.role}`);
    assert.ok(message.content.length > 0);
  }
});

test('normalizeHistoryInput caps message size and count', () => {
  const huge = 'a'.repeat(5000);
  const messages = [];
  for (let index = 0; index < 100; index += 1) {
    messages.push({ role: 'user', content: `${huge}${index}` });
  }

  const result = normalizeHistoryInput({
    excerpts: [{ title: 'Huge', updatedAt: NOW, messages }],
  });

  const all = result.excerpts.flatMap((excerpt) => excerpt.messages);
  assert.ok(all.length <= 40, `too many messages kept: ${all.length}`);
  for (const message of all) {
    assert.ok(message.content.length <= 500, `message not clamped: ${message.content.length}`);
  }
});

test('historyBlock is empty when there is no history to show', () => {
  assert.equal(historyBlock(null), '');
  assert.equal(historyBlock({}), '');
  assert.equal(historyBlock({ index: [], excerpts: [] }), '');
});

test('historyBlock states that the chats exist and forbids denial', () => {
  const block = historyBlock(
    normalizeHistoryInput({
      index: [{ title: 'Maths doubts', updatedAt: NOW, messageCount: 4 }],
    }),
  );

  assert.ok(block.includes('Maths doubts'));
  assert.ok(block.includes('2026-11-20'));
  assert.ok(block.includes('Never say you cannot see'));
  assert.ok(block.includes('Only the titles were retrieved'));
});

test('historyBlock carries verbatim excerpts and the no-fabrication rule', () => {
  const block = historyBlock(
    normalizeHistoryInput({
      index: [{ title: 'Python help', updatedAt: NOW, messageCount: 2 }],
      excerpts: [
        {
          title: 'Python help',
          updatedAt: NOW,
          messages: [
            { role: 'user', content: 'Write a python function to sort a list' },
            { role: 'assistant', content: 'def sort_list(items): return sorted(items)' },
          ],
        },
      ],
    }),
  );

  assert.ok(block.includes('REAL EXCERPTS'));
  assert.ok(block.includes('Write a python function to sort a list'));
  assert.ok(block.includes('def sort_list(items): return sorted(items)'));
  assert.ok(block.includes('Never invent questions, answers, code, formulas or dates'));
  assert.ok(block.includes('RULES FOR USING THIS'));
});

test('historyBlock never exceeds the configured size budget', () => {
  const messages = [];
  for (let index = 0; index < 100; index += 1) {
    messages.push({ role: 'user', content: `${index}: ${'x'.repeat(400)}` });
  }

  const block = historyBlock(
    normalizeHistoryInput({ excerpts: [{ title: 'Huge', updatedAt: NOW, messages }] }),
  );

  assert.ok(block.length > 0);
  // Truncated to the configured budget rather than an arbitrary number.
  assert.ok(block.length <= HISTORY_LIMITS.blockChars, `block too large: ${block.length}`);
});
