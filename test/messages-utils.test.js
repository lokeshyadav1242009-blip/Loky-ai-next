import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AVATAR_COLORS,
  DEFAULT_THREAD_NAME,
  EMOJI_PALETTE,
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGES_PER_THREAD,
  MAX_THREADS,
  MESSAGES_STORAGE_KEY,
  avatarColorFor,
  createThread,
  createThreadId,
  filterThreads,
  formatClockTime,
  formatFileSize,
  initialsFor,
  normalizeThreads,
  sampleThreads,
  serializeThreads,
  sortThreads,
  threadMatches,
  threadPreview,
} from '../public/messages-utils.js';

/* ------------------------------- storage key ------------------------------ */

test('messages use a storage key separate from the assistant history', () => {
  assert.equal(MESSAGES_STORAGE_KEY, 'loky.ai.next.messages.v1');
  assert.notEqual(MESSAGES_STORAGE_KEY, 'loky.ai.next.v1');
});

/* --------------------------------- ids ----------------------------------- */

test('thread ids are unique and prefixed', () => {
  const a = createThreadId();
  const b = createThreadId();
  assert.match(a, /^m_/);
  assert.notEqual(a, b);
});

/* -------------------------------- avatars --------------------------------- */

test('initials are derived from the contact name', () => {
  assert.equal(initialsFor('Aarav Mehta'), 'AM');
  assert.equal(initialsFor('  priya   nair '), 'PN');
  assert.equal(initialsFor('Cher'), 'C');
  assert.equal(initialsFor(''), '?');
  assert.equal(initialsFor(null), '?');
});

test('avatar colours are deterministic and come from the palette', () => {
  assert.equal(avatarColorFor('Aarav Mehta'), avatarColorFor('Aarav Mehta'));
  assert.ok(AVATAR_COLORS.includes(avatarColorFor('Aarav Mehta')));
  assert.ok(AVATAR_COLORS.includes(avatarColorFor('')));
});

/* -------------------------------- threads --------------------------------- */

test('a new thread starts empty and is not flagged as a demo', () => {
  const thread = createThread('Team standup');
  assert.equal(thread.name, 'Team standup');
  assert.equal(thread.demo, false);
  assert.equal(thread.unread, 0);
  assert.deepEqual(thread.messages, []);
  assert.ok(thread.id.startsWith('m_'));
});

test('a blank thread name falls back to the default', () => {
  assert.equal(createThread('   ').name, DEFAULT_THREAD_NAME);
});

test('a thread name is trimmed and length limited', () => {
  const thread = createThread(`  ${'x'.repeat(200)}  `);
  assert.ok(thread.name.length <= 80);
});

/* ------------------------------ normalising ------------------------------- */

test('normalising drops malformed threads instead of throwing', () => {
  const threads = normalizeThreads([
    null,
    'nope',
    { id: '' },
    { id: 'ok', name: 'Valid', messages: [{ text: 'hi', direction: 'in', at: 10 }] },
  ]);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, 'ok');
  assert.equal(threads[0].messages.length, 1);
});

test('normalising repairs a thread with a missing name and messages', () => {
  const [thread] = normalizeThreads([{ id: 'x' }]);
  assert.equal(thread.name, DEFAULT_THREAD_NAME);
  assert.deepEqual(thread.messages, []);
  assert.ok(thread.createdAt > 0);
  assert.ok(thread.updatedAt > 0);
});

test('normalising clamps the unread counter', () => {
  const [thread] = normalizeThreads([{ id: 'x', unread: 5000 }]);
  assert.equal(thread.unread, 999);
  const [neg] = normalizeThreads([{ id: 'y', unread: -5 }]);
  assert.equal(neg.unread, 0);
});

test('normalising keeps the demo flag', () => {
  const [thread] = normalizeThreads([{ id: 'x', demo: true }]);
  assert.equal(thread.demo, true);
});

test('messages without text and without an attachment are dropped', () => {
  const [thread] = normalizeThreads([
    { id: 'x', messages: [{ text: '', direction: 'in', at: 1 }, { text: 'kept', direction: 'in', at: 2 }] },
  ]);
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].text, 'kept');
});

test('normalising caps the number of messages per thread', () => {
  const many = Array.from({ length: MAX_MESSAGES_PER_THREAD + 40 }, (_, i) => ({
    text: `m${i}`,
    direction: 'in',
    at: i + 1,
  }));
  const [thread] = normalizeThreads([{ id: 'x', messages: many }]);
  assert.equal(thread.messages.length, MAX_MESSAGES_PER_THREAD);
});

test('an invalid timestamp is replaced with now', () => {
  const [thread] = normalizeThreads([{ id: 'x', messages: [{ text: 'hi', direction: 'in', at: 'nope' }] }]);
  assert.ok(thread.messages[0].at > 0);
});

test('the message direction is normalised to in/out', () => {
  const [thread] = normalizeThreads([
    { id: 'x', messages: [{ text: 'a', direction: 'weird', at: 1 }, { text: 'b', direction: 'out', at: 2 }] },
  ]);
  assert.equal(thread.messages[0].direction, 'in');
  assert.equal(thread.messages[1].direction, 'out');
});

/* ------------------------------ serialising ------------------------------- */

test('serialising round-trips through normalising', () => {
  const thread = createThread('Round trip');
  thread.messages.push({ id: 'm1', direction: 'out', text: 'hello', at: 123, attachment: null });
  const raw = JSON.parse(serializeThreads([thread], thread.id));
  assert.equal(raw.activeId, thread.id);
  const [restored] = normalizeThreads(raw.threads);
  assert.equal(restored.name, 'Round trip');
  assert.equal(restored.messages[0].text, 'hello');
});

test('serialising only keeps the whitelisted fields', () => {
  const raw = JSON.parse(
    serializeThreads([{ id: 'a', name: 'A', messages: [], secret: 'nope', token: 'nope' }]),
  );
  assert.equal(raw.threads[0].secret, undefined);
  assert.equal(raw.threads[0].token, undefined);
});

test('serialising caps the number of threads', () => {
  const many = Array.from({ length: MAX_THREADS + 10 }, (_, i) => ({
    id: `t${i}`,
    name: `T${i}`,
    messages: [],
  }));
  const raw = JSON.parse(serializeThreads(many));
  assert.equal(raw.threads.length, MAX_THREADS);
});

test('serialising tolerates junk input', () => {
  assert.deepEqual(JSON.parse(serializeThreads(null)), { activeId: null, threads: [] });
  assert.doesNotThrow(() => serializeThreads([{ id: 'a' }]));
});

/* -------------------------------- ordering -------------------------------- */

test('sorting puts the most recently updated conversation first', () => {
  const list = [
    { id: 'a', updatedAt: 10 },
    { id: 'b', updatedAt: 30 },
    { id: 'c', updatedAt: 20 },
  ];
  assert.deepEqual(
    sortThreads(list).map((t) => t.id),
    ['b', 'c', 'a'],
  );
});

test('sorting does not mutate the input array', () => {
  const list = [{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 2 }];
  sortThreads(list);
  assert.deepEqual(list.map((t) => t.id), ['a', 'b']);
});

/* --------------------------------- search --------------------------------- */

test('search matches the conversation name, case-insensitively', () => {
  const thread = { id: 'a', name: 'Aarav Mehta', messages: [] };
  assert.equal(threadMatches(thread, 'aarav'), true);
  assert.equal(threadMatches(thread, 'mehta'), true);
  assert.equal(threadMatches(thread, 'priya'), false);
});

test('search matches the text of any message in the conversation', () => {
  const thread = { id: 'a', name: 'Aarav', messages: [{ text: 'deployment checklist' }] };
  assert.equal(threadMatches(thread, 'checklist'), true);
});

test('an empty query matches everything', () => {
  assert.equal(threadMatches({ id: 'a', name: 'x', messages: [] }, ''), true);
  assert.equal(threadMatches({ id: 'a', name: 'x', messages: [] }, '   '), true);
});

test('filtering combines search and ordering', () => {
  const list = [
    { id: 'a', name: 'Anna', messages: [], updatedAt: 10 },
    { id: 'b', name: 'Bob', messages: [{ text: 'anna likes this' }], updatedAt: 30 },
    { id: 'c', name: 'Cara', messages: [], updatedAt: 20 },
  ];
  const result = filterThreads(list, 'anna');
  assert.deepEqual(result.map((t) => t.id), ['b', 'a']);
});

test('filtering with no query returns every conversation, newest first', () => {
  const list = [
    { id: 'a', name: 'A', messages: [], updatedAt: 1 },
    { id: 'b', name: 'B', messages: [], updatedAt: 2 },
  ];
  assert.deepEqual(
    filterThreads(list, '').map((t) => t.id),
    ['b', 'a'],
  );
});

/* -------------------------------- preview --------------------------------- */

test('the preview shows the last message and marks outgoing ones', () => {
  const thread = { messages: [{ direction: 'in', text: 'hi there' }] };
  assert.equal(threadPreview(thread), 'hi there');

  const out = { messages: [{ direction: 'out', text: 'hello' }] };
  assert.equal(threadPreview(out), 'You: hello');
});

test('the preview of an empty conversation explains it has no messages', () => {
  assert.equal(threadPreview({ messages: [] }), 'No messages yet');
});

test('the preview of an attachment-only message names the file', () => {
  const thread = { messages: [{ direction: 'in', text: '', attachment: { name: 'report.pdf', size: 10 } }] };
  assert.match(threadPreview(thread), /report\.pdf/);
});

/* --------------------------------- format --------------------------------- */

test('clock time is empty for an invalid timestamp', () => {
  assert.equal(formatClockTime(0), '');
  assert.equal(formatClockTime('nope'), '');
  assert.notEqual(formatClockTime(Date.now()), '');
});

test('file sizes are human readable', () => {
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(2048), '2 KB');
  assert.match(formatFileSize(5 * 1024 * 1024), /MB$/);
  assert.equal(formatFileSize(0), '');
});

/* --------------------------------- samples -------------------------------- */

test('the demo samples are clearly flagged and shaped correctly', () => {
  const samples = sampleThreads();
  assert.ok(samples.length > 0);
  for (const sample of samples) {
    assert.equal(sample.demo, true);
    assert.ok(sample.name.length > 0);
    assert.ok(sample.messages.length > 0);
    for (const message of sample.messages) {
      assert.ok(message.text.length > 0);
      assert.ok(['in', 'out'].includes(message.direction));
    }
  }
});

test('the demo samples include unread badges', () => {
  const samples = sampleThreads();
  assert.ok(samples.some((s) => s.unread > 0));
  assert.ok(samples.some((s) => s.unread === 0));
});

test('the demo samples survive a normalise/serialise round trip', () => {
  const raw = JSON.parse(serializeThreads(sampleThreads()));
  const restored = normalizeThreads(raw.threads);
  assert.equal(restored.length, raw.threads.length);
  assert.ok(restored.every((t) => t.demo === true));
});

test('the emoji palette is a non-empty list of strings', () => {
  assert.ok(EMOJI_PALETTE.length > 0);
  for (const emoji of EMOJI_PALETTE) {
    assert.equal(typeof emoji, 'string');
    assert.ok(Array.from(emoji).length >= 1);
  }
});

test('the maximum message length is enforced by the helpers', () => {
  assert.ok(MAX_MESSAGE_LENGTH > 0);
  const [thread] = normalizeThreads([
    { id: 'x', messages: [{ text: 'a'.repeat(MAX_MESSAGE_LENGTH + 500), direction: 'in', at: 1 }] },
  ]);
  assert.equal(thread.messages[0].text.length, MAX_MESSAGE_LENGTH);
});
