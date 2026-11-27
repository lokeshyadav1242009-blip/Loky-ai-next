/**
 * Regression tests for the outgoing friend-request cancellation bug.
 *
 * Reported bug: pressing Cancel on a sent request did not remove the person
 * from the Sent list.
 *
 * Root cause is a contract mismatch, not a styling slip:
 *   - public.my_friend_requests() returns EVERY request involving the user,
 *     with no status filter.
 *   - public.cancel_friend_request() marks the row status='cancelled'
 *     instead of deleting it.
 *   - renderRequests() split rows by direction only, so the cancelled row
 *     came straight back from the refresh and looked still pending.
 *
 * These tests pin the two things that make Cancel actually stick:
 *   1. only still-pending rows may be listed (splitPendingRequests), and
 *   2. cancelRequest() drops the row locally before the refresh re-reads it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isPendingRequest, splitPendingRequests, pendingIncoming } from '../public/connect-model.js';

const SUNITA = 'bbbbbbbb-0000-0000-0000-000000000002';
const RAHUL = 'cccccccc-0000-0000-0000-000000000003';

const row = (over = {}) => ({
  request_id: 'req-1',
  direction: 'outgoing',
  other_id: SUNITA,
  other_username: 'sunita',
  other_display_name: 'Sunita Yadav',
  status: 'pending',
  note: null,
  created_at: '2026-11-27T10:00:00.000Z',
  responded_at: null,
  ...over,
});

const connectSource = () => readFileSync(new URL('../public/connect.js', import.meta.url), 'utf8');

const functionSource = (name) => {
  const source = connectSource();
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name}() must exist in public/connect.js`);
  // Slice to the next top-level function declaration.
  const rest = source.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function [A-Za-z0-9_$]+\(/);
  return nextFn === -1 ? rest : rest.slice(0, nextFn);
};

test('isPendingRequest accepts only a pending status', () => {
  assert.equal(isPendingRequest(row()), true);
  assert.equal(isPendingRequest(row({ status: 'cancelled' })), false);
  assert.equal(isPendingRequest(row({ status: 'accepted' })), false);
  assert.equal(isPendingRequest(row({ status: 'rejected' })), false);
  assert.equal(isPendingRequest(null), false);
  assert.equal(isPendingRequest(undefined), false);
});

test('isPendingRequest is case-insensitive so a changed payload still lists', () => {
  assert.equal(isPendingRequest(row({ status: 'PENDING' })), true);
  assert.equal(isPendingRequest(row({ status: 'Pending' })), true);
});

test('a cancelled outgoing request is not listed in Sent', () => {
  const { incoming, outgoing } = splitPendingRequests([
    row({ request_id: 'req-1', direction: 'outgoing', status: 'cancelled' }),
  ]);
  assert.deepEqual(incoming, []);
  assert.deepEqual(outgoing, []);
});

test('an accepted or rejected request leaves both lists', () => {
  const { incoming, outgoing } = splitPendingRequests([
    row({ request_id: 'req-a', direction: 'incoming', status: 'accepted' }),
    row({ request_id: 'req-b', direction: 'incoming', status: 'rejected' }),
    row({ request_id: 'req-c', direction: 'outgoing', status: 'accepted' }),
  ]);
  assert.deepEqual(incoming, []);
  assert.deepEqual(outgoing, []);
});

test('pending requests are split by direction', () => {
  const incomingRow = row({ request_id: 'req-in', direction: 'incoming', other_id: RAHUL });
  const outgoingRow = row({ request_id: 'req-out', direction: 'outgoing', other_id: SUNITA });
  const { incoming, outgoing } = splitPendingRequests([incomingRow, outgoingRow]);
  assert.deepEqual(incoming.map((r) => r.request_id), ['req-in']);
  assert.deepEqual(outgoing.map((r) => r.request_id), ['req-out']);
});

test('the short direction forms are still tolerated', () => {
  const { incoming, outgoing } = splitPendingRequests([
    row({ request_id: 'req-in', direction: 'in' }),
    row({ request_id: 'req-out', direction: 'out' }),
  ]);
  assert.deepEqual(incoming.map((r) => r.request_id), ['req-in']);
  assert.deepEqual(outgoing.map((r) => r.request_id), ['req-out']);
});

test('a row with a missing or unknown status is never listed as pending', () => {
  const { incoming, outgoing } = splitPendingRequests([
    row({ request_id: 'req-x', direction: 'outgoing', status: undefined }),
    row({ request_id: 'req-y', direction: 'outgoing', status: 'expired' }),
  ]);
  assert.deepEqual(incoming, []);
  assert.deepEqual(outgoing, []);
});

test('non-array input cannot throw', () => {
  assert.deepEqual(splitPendingRequests(null), { incoming: [], outgoing: [] });
  assert.deepEqual(splitPendingRequests(undefined), { incoming: [], outgoing: [] });
  assert.deepEqual(splitPendingRequests({}), { incoming: [], outgoing: [] });
});

test('the Requests badge counts only pending incoming rows', () => {
  const rows = [
    row({ request_id: 'req-1', direction: 'incoming', status: 'pending' }),
    row({ request_id: 'req-2', direction: 'incoming', status: 'accepted' }),
    row({ request_id: 'req-3', direction: 'incoming', status: 'rejected' }),
    row({ request_id: 'req-4', direction: 'outgoing', status: 'pending' }),
    row({ request_id: 'req-5', direction: 'incoming', status: 'cancelled' }),
  ];
  assert.equal(pendingIncoming(rows), 1);
});

test('renderRequests filters by pending status, not direction alone', () => {
  const source = functionSource('renderRequests');
  assert.match(
    source,
    /splitPendingRequests\(state\.requestRows\)/,
    'renderRequests must derive both lists through splitPendingRequests so finished requests cannot linger'
  );
  assert.doesNotMatch(
    source,
    /state\.requestRows\.filter\(is(?:Incoming|Outgoing)\)/,
    'direction-only filtering is the bug: it re-renders cancelled and answered requests'
  );
});

test('cancelRequest drops the cancelled row before refreshing from the server', () => {
  const source = functionSource('cancelRequest');
  assert.match(source, /await cancelFriendRequest\(req\.request_id\)/, 'must call the real Supabase RPC');
  assert.match(
    source,
    /state\.requestRows\s*=\s*state\.requestRows\.filter\([^)]*request_id\s*!==\s*req\.request_id/,
    'the cancelled row must be removed locally: the RPC keeps it with status cancelled'
  );
  assert.match(source, /refreshRequestRows\(\)/, 'server state must still be re-read after cancelling');
});

test('cancelRequest reverts the Discover result so the request can be sent again', () => {
  const source = functionSource('cancelRequest');
  assert.match(
    source,
    /friend_state\s*=\s*'none'/,
    "Discover must go back to 'Add friend' instead of staying on 'Request Sent'"
  );
  assert.match(source, /renderResults\(\)/, 'Discover has to repaint after the status change');
});

test('cancelRequest restores the real state when cancellation fails', () => {
  const source = functionSource('cancelRequest');
  const catchBlock = source.slice(source.indexOf('catch'));
  assert.match(
    catchBlock,
    /refreshRequestRows\(\)/,
    'a failed cancel must re-read the server instead of leaving the list half-updated'
  );
  assert.match(catchBlock, /say\(/, 'the failure must be reported to the user');
});
