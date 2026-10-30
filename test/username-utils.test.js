import test from 'node:test';
import assert from 'node:assert/strict';

import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  directConversationKey,
  displayUsername,
  isSameUsername,
  normalizeUsername,
  validateUsername,
} from '../public/username-utils.js';

test('normalizeUsername lowercases, trims and strips a leading @', () => {
  assert.equal(normalizeUsername('  Alice  '), 'alice');
  assert.equal(normalizeUsername('@Bob_99'), 'bob_99');
  assert.equal(normalizeUsername('ALREADY'), 'already');
  assert.equal(normalizeUsername('@  spaced '), 'spaced');
  assert.equal(normalizeUsername(''), '');
  assert.equal(normalizeUsername(null), '');
  assert.equal(normalizeUsername(42), '');
});

test('case variations collapse to one canonical username', () => {
  assert.equal(normalizeUsername('LoKy'), normalizeUsername('LOKY'));
  assert.equal(normalizeUsername('@LoKy'), 'loky');
});

test('accepts letters, numbers and underscores at the length limits', () => {
  assert.equal(validateUsername('abc').ok, true);
  assert.equal(validateUsername('a'.repeat(USERNAME_MAX_LENGTH)).ok, true);
  assert.equal(validateUsername('user_123').ok, true);
  assert.equal(validateUsername('@User_123').value, 'user_123');
});

test('rejects usernames that are too short or too long', () => {
  assert.equal(validateUsername('ab').code, 'too_short');
  assert.equal(validateUsername('a'.repeat(USERNAME_MAX_LENGTH + 1)).code, 'too_long');
  assert.equal(validateUsername(`${'a'.repeat(USERNAME_MIN_LENGTH - 1)}`).ok, false);
});

test('rejects empty input and unsupported characters', () => {
  assert.equal(validateUsername('').code, 'empty');
  assert.equal(validateUsername('   ').code, 'empty');
  assert.equal(validateUsername('has space').code, 'invalid_chars');
  assert.equal(validateUsername('dash-name').code, 'invalid_chars');
  assert.equal(validateUsername('dot.name').code, 'invalid_chars');
  assert.equal(validateUsername('emoji😀').code, 'invalid_chars');
  assert.equal(validateUsername('sla/sh').code, 'invalid_chars');
});

test('rejects reserved names in any case', () => {
  assert.equal(validateUsername('admin').code, 'reserved');
  assert.equal(validateUsername('ADMIN').code, 'reserved');
  assert.equal(validateUsername('@Support').code, 'reserved');
  assert.equal(validateUsername('loky').code, 'reserved');
});

test('every failure carries a non-empty human message', () => {
  for (const raw of ['', 'ab', 'a'.repeat(30), 'bad name', 'admin']) {
    const result = validateUsername(raw);
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.length > 0, `missing message for ${JSON.stringify(raw)}`);
  }
});

test('successful validation returns the normalised value and no error', () => {
  const result = validateUsername('  @New_User  ');
  assert.deepEqual(result, { ok: true, value: 'new_user', code: null, error: null });
});

test('isSameUsername ignores case and a leading @', () => {
  assert.equal(isSameUsername('Alice', '@alice'), true);
  assert.equal(isSameUsername('alice', 'bob'), false);
  assert.equal(isSameUsername('', ''), false);
});

test('displayUsername renders a single @ prefix', () => {
  assert.equal(displayUsername('Alice'), '@alice');
  assert.equal(displayUsername('@alice'), '@alice');
  assert.equal(displayUsername(''), '');
});

test('directConversationKey is stable for a pair regardless of order', () => {
  const a = '11111111-1111-1111-1111-111111111111';
  const b = '22222222-2222-2222-2222-222222222222';
  assert.equal(directConversationKey(a, b), directConversationKey(b, a));
  assert.equal(directConversationKey(a, a), `${a}:${a}`);
  assert.equal(directConversationKey(a, ''), '');
  assert.equal(directConversationKey(null, b), '');
});
