import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMORY_CATEGORIES,
  MAX_CONTEXT_MEMORIES,
  buildMemoryBlock,
  countByCategory,
  dedupeKey,
  detectSecret,
  filterMemories,
  findDuplicate,
  normaliseCategory,
  normaliseContent,
  scoreMemory,
  selectRelevant,
  sortMemories,
  tokenise,
  validateMemory,
} from '../public/memory-model.js';

/* ------------------------------- validation ------------------------------- */

test('validateMemory accepts a normal note and normalises whitespace', () => {
  const result = validateMemory({ content: '  I am   preparing for  JEE  ', category: 'study' });
  assert.equal(result.ok, true);
  assert.equal(result.value.content, 'I am preparing for JEE');
  assert.equal(result.value.category, 'study');
});

test('validateMemory rejects too short, too long and unknown categories fall back', () => {
  assert.equal(validateMemory({ content: 'hi' }).code, 'too_short');
  assert.equal(validateMemory({ content: '   ' }).code, 'too_short');
  assert.equal(validateMemory({ content: 'x'.repeat(601) }).code, 'too_long');

  // An unknown category must not throw or persist garbage — it defaults.
  assert.equal(validateMemory({ content: 'Likes tea', category: 'nonsense' }).value.category, 'personal');
  assert.equal(normaliseCategory(undefined), 'personal');
  assert.deepEqual(MEMORY_CATEGORIES, ['personal', 'study', 'projects', 'preferences']);
});

/* ------------------------------ secret guard ------------------------------ */

test('detectSecret catches credentials and ignores ordinary notes', () => {
  const secrets = [
    'my key is sk-abcdefghijklmnop1234',
    'AIzaSyD-1234567890abcdefghijklmnopqrs',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    '-----BEGIN RSA PRIVATE KEY-----',
    'password: hunter2secret',
    'postgres://admin:s3cretpw@db.example.com:5432/postgres',
    'the service_role key is in here',
  ];
  for (const text of secrets) {
    assert.equal(detectSecret(text).secret, true, `should flag: ${text}`);
  }

  const fine = [
    'I prefer short answers with code examples',
    'My physics exam is in March',
    'I am building LOKY AI with Node and Express',
    'I like chai and samosas',
    'Always answer in Hinglish',
  ];
  for (const text of fine) {
    assert.equal(detectSecret(text).secret, false, `should allow: ${text}`);
  }
});

test('validateMemory refuses to store anything secret-like', () => {
  const result = validateMemory({ content: 'my api key is sk-live-abcdefghijklmnop' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'secret');
  // The error must not echo the secret back.
  assert.ok(!result.error.includes('sk-live'));
});

/* --------------------------- duplicate prevention ------------------------- */

test('dedupeKey ignores case and repeated spaces', () => {
  assert.equal(dedupeKey('  Likes   Coffee '), 'likes coffee');
  assert.equal(dedupeKey('LIKES COFFEE'), dedupeKey('likes coffee'));
});

test('findDuplicate blocks a second identical note but allows editing itself', () => {
  const memories = [
    { id: 'a', content: 'I prefer Hinglish replies' },
    { id: 'b', content: 'My exam is in March' },
  ];

  assert.equal(findDuplicate(memories, 'i prefer   hinglish replies').id, 'a');
  assert.equal(findDuplicate(memories, 'Something new'), null);
  // Editing row b with its own unchanged text is not a duplicate.
  assert.equal(findDuplicate(memories, 'My exam is in March', 'b'), null);
});

/* -------------------------------- relevance ------------------------------- */

const sample = [
  { id: '1', content: 'I am preparing for the JEE physics exam in March', category: 'study' },
  { id: '2', content: 'My project LOKY AI uses Node, Express and Supabase', category: 'projects' },
  { id: '3', content: 'I prefer short answers with bullet points', category: 'preferences' },
  { id: '4', content: 'I live in Jaipur', category: 'personal' },
];

test('tokenise drops filler words so overlap means something', () => {
  assert.deepEqual(tokenise('What is the physics exam?'), ['physics', 'exam']);
});

test('selectRelevant returns matching memories and excludes unrelated ones', () => {
  const picked = selectRelevant(sample, 'When is my physics exam?');
  const ids = picked.map((m) => m.id);

  assert.equal(ids[0], '1', 'the physics memory must rank first');
  assert.ok(!ids.includes('4'), 'an unrelated memory must not be sent');
  assert.ok(!ids.includes('3'), 'a preference must not ride along on an exam question');
});

test('selectRelevant keeps project questions on project memories', () => {
  const picked = selectRelevant(sample, 'how is my LOKY AI project going?');
  const ids = picked.map((m) => m.id);
  assert.ok(ids.includes('2'));
  assert.ok(!ids.includes('4'));
});

test('selectRelevant caps the number of memories and never returns everything', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    content: `physics note number ${i}`,
    category: 'study',
  }));
  const picked = selectRelevant(many, 'physics');
  assert.equal(picked.length, MAX_CONTEXT_MEMORIES);
});

test('selectRelevant prefers pinned notes when there is no query', () => {
  const pinned = [
    { id: 'x', content: 'Always answer in Hinglish', pinned: true, updated_at: '2024-01-01T00:00:00Z' },
    { id: 'y', content: 'I like long essays', pinned: false, updated_at: '2025-01-01T00:00:00Z' },
  ];
  const picked = selectRelevant(pinned, '');
  assert.equal(picked[0].id, 'x');
});

test('selectRelevant is safe on empty or malformed input', () => {
  assert.deepEqual(selectRelevant([], 'anything'), []);
  assert.deepEqual(selectRelevant(null, 'anything'), []);
  assert.deepEqual(selectRelevant([{ content: null }], 'anything'), []);
});

test('scoreMemory rewards overlap and stays zero for unrelated text', () => {
  assert.equal(scoreMemory(sample[0], 'quantum chromodynamics'), 0);
  assert.ok(scoreMemory(sample[0], 'physics exam') > 0);
});

/* ------------------------------ prompt block ------------------------------ */

test('buildMemoryBlock labels categories and instructs cautious use', () => {
  const block = buildMemoryBlock([sample[0], sample[2]]);
  assert.match(block, /\[Study\] I am preparing for the JEE physics exam/);
  assert.match(block, /\[Preferences\] I prefer short answers/);
  assert.match(block, /never invent a memory/i);
  assert.ok(!block.includes('undefined'));
});

test('buildMemoryBlock is empty when there is nothing to say', () => {
  assert.equal(buildMemoryBlock([]), '');
  assert.equal(buildMemoryBlock(null), '');
  assert.equal(buildMemoryBlock([{ content: '   ' }]), '');
});

test('buildMemoryBlock respects its character budget', () => {
  const long = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    content: `${i} ${'x'.repeat(80)}`,
    category: 'personal',
  }));
  const block = buildMemoryBlock(long, { maxChars: 300 });
  assert.ok(block.length < 500, `block should stay small, got ${block.length}`);
  assert.match(block, /Saved notes about this user/);
});

/* ----------------------------- listing helpers ---------------------------- */

test('sortMemories puts pinned first, then newest', () => {
  const list = [
    { id: 'old', pinned: false, updated_at: '2024-01-01T00:00:00Z' },
    { id: 'pin', pinned: true, updated_at: '2023-01-01T00:00:00Z' },
    { id: 'new', pinned: false, updated_at: '2025-01-01T00:00:00Z' },
  ];
  assert.deepEqual(sortMemories(list).map((m) => m.id), ['pin', 'new', 'old']);
});

test('filterMemories searches text and filters by category', () => {
  assert.deepEqual(filterMemories(sample, { query: 'physics' }).map((m) => m.id), ['1']);
  assert.deepEqual(filterMemories(sample, { category: 'personal' }).map((m) => m.id), ['4']);
  assert.equal(filterMemories(sample, {}).length, 4);
  assert.equal(filterMemories(sample, { query: 'nothing here' }).length, 0);
});

test('countByCategory always reports every category', () => {
  const counts = countByCategory(sample);
  assert.deepEqual(counts, { personal: 1, study: 1, projects: 1, preferences: 1 });
  assert.deepEqual(countByCategory([]), { personal: 0, study: 0, projects: 0, preferences: 0 });
});

test('normaliseContent never returns undefined for junk input', () => {
  assert.equal(normaliseContent(null), '');
  assert.equal(normaliseContent(undefined), '');
  assert.equal(normaliseContent('  a \n b '), 'a b');
});
