import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSearchTerm,
  isSearchable,
  isSelfResult,
  excludeSelf,
  friendStateLabel,
  describeSearchState,
  SEARCH_MIN_LENGTH,
} from '../public/search-utils.js';

test('normalizeSearchTerm trims, strips @, and lowercases', () => {
  assert.equal(normalizeSearchTerm('  @Sunita  '), 'sunita');
  assert.equal(normalizeSearchTerm('@@Sunita'), 'sunita');
  assert.equal(normalizeSearchTerm('   sunita sharma   '), 'sunita sharma');
  assert.equal(normalizeSearchTerm('SUNITA'), 'sunita');
});

test('normalizeSearchTerm tolerates non-strings', () => {
  assert.equal(normalizeSearchTerm(null), '');
  assert.equal(normalizeSearchTerm(undefined), '');
  assert.equal(normalizeSearchTerm(42), '');
});

test('isSearchable enforces the minimum term length', () => {
  assert.equal(SEARCH_MIN_LENGTH, 2);
  assert.equal(isSearchable('su'), true);
  assert.equal(isSearchable(' @su '), true);
  assert.equal(isSearchable('s'), false);
  assert.equal(isSearchable('  '), false);
  assert.equal(isSearchable('@'), false);
});

test('isSelfResult detects the signed-in user by id or user_id', () => {
  assert.equal(isSelfResult({ id: 'abc' }, 'abc'), true);
  assert.equal(isSelfResult({ user_id: 'abc' }, 'abc'), true);
  assert.equal(isSelfResult({ id: 'xyz' }, 'abc'), false);
  assert.equal(isSelfResult(null, 'abc'), false);
  assert.equal(isSelfResult({ id: 'abc' }, null), false);
});

test('excludeSelf removes only the caller', () => {
  const rows = [{ id: 'me' }, { id: 'other' }, { user_id: 'third' }];
  assert.deepEqual(excludeSelf(rows, 'me'), [{ id: 'other' }, { user_id: 'third' }]);
  assert.deepEqual(excludeSelf(null, 'me'), []);
});

test('friendStateLabel maps every relationship to readable text', () => {
  assert.equal(friendStateLabel('friends'), 'Friends');
  assert.equal(friendStateLabel('friend'), 'Friends');
  assert.equal(friendStateLabel('accepted'), 'Friends');
  assert.equal(friendStateLabel('pending_out'), 'Request pending');
  assert.equal(friendStateLabel('pending_in'), 'Wants to connect');
  assert.equal(friendStateLabel('self'), 'You');
  assert.equal(friendStateLabel('none'), '');
  assert.equal(friendStateLabel(undefined), '');
});

test('describeSearchState shows the searching state first', () => {
  assert.deepEqual(describeSearchState({ term: 'sunita', count: 0, searching: true }), {
    kind: 'searching',
    message: 'Searching…',
  });
});

test('describeSearchState surfaces search failures', () => {
  assert.deepEqual(describeSearchState({ term: 'sunita', count: 0, error: 'Network problem.' }), {
    kind: 'error',
    message: 'Network problem.',
  });
  assert.deepEqual(describeSearchState({ term: 'sunita', count: 0, error: '' }), {
    kind: 'idle',
    message: 'Search a username to find people.',
  });
});

test('describeSearchState asks for input when the term is too short', () => {
  assert.deepEqual(describeSearchState({ term: '', count: 0 }), {
    kind: 'idle',
    message: 'Search a username to find people.',
  });
  assert.equal(describeSearchState({ term: 's', count: 0 }).kind, 'idle');
});

test('describeSearchState reports an empty result set by name', () => {
  const view = describeSearchState({ term: ' @Nobody ', count: 0 });
  assert.equal(view.kind, 'empty');
  assert.match(view.message, /No users found/);
  assert.match(view.message, /@nobody/);
});

test('describeSearchState reports results without a message', () => {
  assert.deepEqual(describeSearchState({ term: 'sunita', count: 2 }), {
    kind: 'results',
    message: '',
  });
});

test('an existing user is found by full, partial and mixed-case terms', () => {
  // Mirrors the SQL contract: exact OR case-insensitive substring match.
  const stored = 'sunita_sharma';
  const matches = (term) => {
    const q = normalizeSearchTerm(term);
    if (q.length < SEARCH_MIN_LENGTH) return false;
    return stored === q || stored.includes(q);
  };

  assert.equal(matches('sunita_sharma'), true, 'exact username');
  assert.equal(matches('@Sunita_Sharma'), true, 'exact, @ and mixed case');
  assert.equal(matches('sunita'), true, 'prefix');
  assert.equal(matches('sharma'), true, 'suffix only — the old LIKE could not do this');
  assert.equal(matches('nita_sh'), true, 'middle substring');
  assert.equal(matches('  @SUNITA  '), true, 'padded and uppercase');
  assert.equal(matches('s'), false, 'below minimum length');
  assert.equal(matches('someone_else'), false, 'genuinely absent');
});
