import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TITLE,
  MAX_STORED_CONVERSATIONS,
  STORAGE_KEY,
  formatAbsoluteTime,
  formatRelativeTime,
  formatTimestampLabel,
  newId,
  normalizeConversations,
  sanitizeTitle,
  serializeConversations,
  titleFrom,
} from '../public/chat-utils.js';

test('storage key and limits are stable', () => {
  assert.equal(STORAGE_KEY, 'loky.ai.next.v1');
  assert.equal(MAX_STORED_CONVERSATIONS, 50);
  assert.equal(DEFAULT_TITLE, 'New chat');
});

test('newId returns unique non-empty ids', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) {
    const id = newId();
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
    ids.add(id);
  }
  assert.equal(ids.size, 200);
});

test('sanitizeTitle collapses whitespace, trims and falls back', () => {
  assert.equal(sanitizeTitle('  hello   world  '), 'hello world');
  assert.equal(sanitizeTitle('hello\n\tworld'), 'hello world');
  assert.equal(sanitizeTitle(''), DEFAULT_TITLE);
  assert.equal(sanitizeTitle(null), DEFAULT_TITLE);
  assert.equal(sanitizeTitle(undefined), DEFAULT_TITLE);
  assert.equal(sanitizeTitle('   '), DEFAULT_TITLE);
  assert.equal(sanitizeTitle('x', 'fallback'), 'x');
  assert.equal(sanitizeTitle('', 'fallback'), 'fallback');
});

test('sanitizeTitle caps length with an ellipsis', () => {
  const long = 'a'.repeat(200);
  const out = sanitizeTitle(long, DEFAULT_TITLE, 20);
  assert.ok(out.length <= 20);
  assert.ok(out.endsWith('…'));
});

test('titleFrom derives a title from the first user message', () => {
  assert.equal(titleFrom('How do I stream an answer?'), 'How do I stream an answer?');
  assert.equal(titleFrom('   '), DEFAULT_TITLE);
  const capped = titleFrom('x'.repeat(200));
  assert.ok(capped.length <= 48);
});

test('formatRelativeTime renders friendly labels', () => {
  const now = Date.UTC(2025, 2, 12, 12, 0, 0);
  assert.equal(formatRelativeTime(now - 5_000, now), 'just now');
  assert.equal(formatRelativeTime(now - 12 * 60_000, now), '12m ago');
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(formatRelativeTime(now - 26 * 3_600_000, now), 'yesterday');
  assert.equal(formatRelativeTime(now - 4 * 86_400_000, now), '4d ago');
});

test('formatRelativeTime tolerates missing and future timestamps', () => {
  const now = Date.UTC(2025, 2, 12, 12, 0, 0);
  assert.equal(formatRelativeTime(0, now), '');
  assert.equal(formatRelativeTime(null, now), '');
  assert.equal(formatRelativeTime(undefined, now), '');
  assert.equal(formatRelativeTime('nope', now), '');
  assert.equal(formatRelativeTime(now + 60_000, now), 'just now');
});

test('formatRelativeTime falls back to a calendar date beyond a week', () => {
  const now = Date.UTC(2025, 2, 12, 12, 0, 0);
  const old = now - 40 * 86_400_000;
  const label = formatRelativeTime(old, now);
  assert.ok(label.length > 0);
  assert.match(label, /\d{4}/);
});

test('formatAbsoluteTime and formatTimestampLabel return readable values', () => {
  const stamp = Date.UTC(2025, 2, 12, 12, 30, 0);
  assert.match(formatAbsoluteTime(stamp), /2025/);
  assert.ok(formatTimestampLabel(stamp).length > 0);
  assert.equal(formatAbsoluteTime(0), '');
  assert.equal(formatTimestampLabel(0), '');
});

test('normalizeConversations drops invalid entries and repairs missing fields', () => {
  const now = Date.now();
  const out = normalizeConversations([
    null,
    'nope',
    { id: '', messages: [] },
    { id: 'a' },
    {
      id: 'ok',
      title: '  My   chat  ',
      createdAt: now,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'system', content: 'dropped' },
        { role: 'user', content: 42 },
        null,
      ],
    },
  ]);

  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'ok');
  assert.equal(out[0].title, 'My chat');
  assert.equal(out[0].messages.length, 2);
  assert.equal(out[0].messages[0].role, 'user');
  assert.equal(out[0].createdAt, now);
  assert.ok(out[0].updatedAt >= out[0].createdAt);
});

test('normalizeConversations returns an empty list for junk input', () => {
  assert.deepEqual(normalizeConversations(null), []);
  assert.deepEqual(normalizeConversations('nope'), []);
  assert.deepEqual(normalizeConversations(undefined), []);
  assert.deepEqual(normalizeConversations({}), []);
});

test('normalizeConversations gives untitled conversations a readable title', () => {
  const out = normalizeConversations([{ id: 'a', messages: [] }]);
  assert.equal(out[0].title, 'Untitled chat');
});

test('serializeConversations round-trips through normalizeConversations', () => {
  const conversations = [
    {
      id: 'c1',
      title: 'First chat',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [{ role: 'user', content: 'hello' }],
    },
    {
      id: 'c2',
      title: 'Second chat',
      createdAt: 3000,
      updatedAt: 4000,
      messages: [{ role: 'assistant', content: 'hi there' }],
    },
  ];

  const raw = JSON.parse(serializeConversations(conversations, 'c2'));
  assert.equal(raw.activeId, 'c2');
  assert.equal(raw.conversations.length, 2);

  const restored = normalizeConversations(raw.conversations);
  assert.equal(restored.length, 2);
  assert.equal(restored[0].title, 'First chat');
  assert.equal(restored[0].createdAt, 1000);
  assert.equal(restored[0].updatedAt, 2000);
  assert.equal(restored[1].messages[0].content, 'hi there');
});

test('serializeConversations caps the stored history', () => {
  const many = Array.from({ length: MAX_STORED_CONVERSATIONS + 20 }, (_, i) => ({
    id: `c${i}`,
    title: `Chat ${i}`,
    createdAt: i,
    updatedAt: i,
    messages: [],
  }));
  const raw = JSON.parse(serializeConversations(many, null));
  assert.equal(raw.conversations.length, MAX_STORED_CONVERSATIONS);
  assert.equal(raw.activeId, null);
});

test('serializeConversations never persists unexpected fields such as secrets', () => {
  const raw = JSON.parse(
    serializeConversations(
      [
        {
          id: 'c1',
          title: 'Chat',
          createdAt: 1,
          updatedAt: 2,
          messages: [{ role: 'user', content: 'hi', apiKey: 'sk-should-not-persist' }],
          apiKey: 'sk-should-not-persist',
        },
      ],
      'c1',
    ),
  );
  assert.equal(raw.conversations[0].apiKey, undefined);
  assert.equal(raw.conversations[0].messages[0].apiKey, undefined);
  assert.ok(!JSON.stringify(raw).includes('sk-should-not-persist'));
});

test('serializeConversations handles a non-array input', () => {
  const raw = JSON.parse(serializeConversations(null, undefined));
  assert.deepEqual(raw.conversations, []);
  assert.equal(raw.activeId, null);
});
