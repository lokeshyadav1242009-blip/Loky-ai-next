/**
 * Cross-chat memory retrieval.
 *
 * The product promise is that a user never repeats themselves. That is a
 * retrieval guarantee, not a UI one, so these tests pin the selection rules:
 * a vague question in a brand-new chat must still carry the durable facts,
 * while the prompt must stay bounded no matter how much an account has saved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BASELINE_MEMORIES,
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_MEMORIES,
  buildMemoryBlock,
  durableRank,
  memoryImportance,
  selectForContext,
  similarity,
} from '../public/memory-model.js';

const memory = (id, content, category = 'personal', extra = {}) => ({
  id,
  content,
  category,
  ...extra,
});

/** The exact scenario from the product brief. */
const jeeProfile = [
  memory('m1', 'The user is a Class 11 JEE aspirant.', 'study', { pinned: true, importance: 0.95 }),
  memory('m2', 'The user studies Physics, Chemistry and Mathematics.', 'study'),
  memory('m3', 'The user prefers one-shot lectures and PYQ practice.', 'preferences'),
  memory('m4', 'The user is building an AI project.', 'projects'),
];

test('a vague question in a brand-new chat still receives the saved profile', () => {
  const picked = selectForContext(jeeProfile, 'What should I study today?');
  const ids = picked.map((entry) => entry.id);
  assert.ok(ids.includes('m1'), 'the pinned JEE fact must reach the prompt');
  assert.ok(picked.length >= 2, 'related study notes should come along too');
});

test('a question with no shared vocabulary still carries a small baseline', () => {
  const unrelated = Array.from({ length: 40 }, (_, index) =>
    memory(`x${index}`, `Filler fact number ${index} about topic ${index}.`),
  );
  const picked = selectForContext(unrelated, 'Write a short poem about rain.');
  assert.equal(picked.length, MAX_BASELINE_MEMORIES);
});

test('a specific question ranks its matching memory first', () => {
  const picked = selectForContext(jeeProfile, 'Which physics chapters should I revise for JEE?');
  assert.equal(picked[0].id, 'm1');
});

test('selection never exceeds the context limit', () => {
  const many = Array.from({ length: 80 }, (_, index) =>
    memory(`y${index}`, `The user studies physics topic ${index} for JEE.`, 'study'),
  );
  const picked = selectForContext(many, 'physics JEE study plan');
  assert.ok(picked.length <= MAX_CONTEXT_MEMORIES);
});

test('the rendered block stays inside the prompt character budget', () => {
  const many = Array.from({ length: 60 }, (_, index) =>
    memory(`z${index}`, `${'The user studies physics for JEE. '.repeat(6)}note ${index}`, 'study'),
  );
  const block = buildMemoryBlock(selectForContext(many, 'physics JEE study plan'));
  assert.ok(block.length <= MAX_CONTEXT_CHARS, `block was ${block.length} chars`);
});

test('a deleted memory cannot reach a later prompt', () => {
  const withoutPinned = jeeProfile.filter((entry) => entry.id !== 'm1');
  const block = buildMemoryBlock(selectForContext(withoutPinned, 'What should I study today?'));
  assert.ok(!block.includes('Class 11 JEE aspirant'));
});

test('selectForContext does not mutate its input', () => {
  const snapshot = JSON.stringify(jeeProfile);
  selectForContext(jeeProfile, 'JEE study plan');
  assert.equal(JSON.stringify(jeeProfile), snapshot);
});

test('an empty or missing list yields an empty selection', () => {
  assert.deepEqual(selectForContext([], 'hello'), []);
  assert.deepEqual(selectForContext(null, 'hello'), []);
});

test('importance falls back sensibly for rows written before the column existed', () => {
  assert.equal(memoryImportance({ pinned: true }), 0.9);
  assert.equal(memoryImportance({}), 0.5);
  assert.equal(memoryImportance({ importance: 0.72 }), 0.72);
  assert.equal(memoryImportance({ importance: 5 }), 1);
});

test('durableRank puts pinned and important notes first', () => {
  const rows = [
    memory('a', 'low', 'personal', { importance: 0.2 }),
    memory('b', 'pinned', 'personal', { pinned: true, importance: 0.1 }),
    memory('c', 'high', 'personal', { importance: 0.9 }),
  ].sort(durableRank);
  assert.deepEqual(rows.map((row) => row.id), ['b', 'c', 'a']);
});

test('similarity is symmetric and zero for unrelated text', () => {
  const a = 'The user prefers one-shot lectures for physics.';
  const b = 'The user prefers one shot lectures for physics revision.';
  assert.ok(similarity(a, b) > 0.5);
  assert.equal(similarity(a, b), similarity(b, a));
  assert.equal(similarity('alpha beta', 'gamma delta'), 0);
});
