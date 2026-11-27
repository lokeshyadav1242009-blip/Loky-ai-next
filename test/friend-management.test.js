import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  FRIEND_MENU_ITEMS,
  friendMenuModel,
  removeFriendConfirmText,
  blockUserConfirmText,
  describeFriendError,
  withoutPerson,
  blockedListModel,
} from '../public/friends-utils.js';

/**
 * Friend management: the three-dot menu, the two destructive actions and the
 * block enforcement contract.
 *
 * Two kinds of assertion here:
 *  1. pure UI rules (what the menu shows, what the dialog promises), and
 *  2. the SQL contract in 0007_friend_blocks.sql — that blocks are enforced in
 *     the database, not in the browser. The second kind matters most: a block
 *     that only hides buttons can be bypassed by calling PostgREST directly, so
 *     these tests fail if the triggers/policies are ever removed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(HERE, '..', 'supabase', 'migrations', '0007_friend_blocks.sql'), 'utf8');

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/* --------------------------------- menu ---------------------------------- */

test('a friend row exposes exactly Remove friend and Block user', () => {
  const model = friendMenuModel('friends');
  assert.equal(model.visible, true);
  assert.deepEqual(
    model.items.map((item) => item.label),
    ['Remove friend', 'Block user'],
  );
  assert.equal(model.items.length, 2);
  // Blocking is the destructive one, so the UI can style it apart.
  assert.equal(model.items.find((item) => item.id === 'block').danger, true);
  assert.equal(model.items.find((item) => item.id === 'remove').danger, false);
  assert.deepEqual(FRIEND_MENU_ITEMS.map((i) => i.id), ['remove', 'block']);
});

test('nobody who is not a friend gets the menu', () => {
  for (const status of ['self', 'none', 'pending_out', 'pending_in', 'unknown']) {
    const model = friendMenuModel(status);
    assert.equal(model.visible, false, `${status} must not show a menu`);
    assert.deepEqual(model.items, []);
  }
});

test('menu models are copies, so one row cannot mutate another', () => {
  const first = friendMenuModel('friends');
  first.items[0].label = 'tampered';
  assert.equal(friendMenuModel('friends').items[0].label, 'Remove friend');
});

/* ------------------------------- confirmations ---------------------------- */

test('removing a friend confirms and says the person is not blocked', () => {
  const copy = removeFriendConfirmText('@sunita');
  assert.match(copy.title, /remove/i);
  assert.match(copy.body, /@sunita/);
  assert.match(copy.body, /not be blocked/i);
  assert.equal(copy.confirmLabel, 'Remove friend');
  assert.equal(copy.danger, false);
});

test('blocking a user confirms and spells out the consequences', () => {
  const copy = blockUserConfirmText('sunita');
  assert.match(copy.title, /block/i);
  assert.match(copy.body, /@sunita/, 'a bare username is rendered with an @');
  assert.match(copy.body, /cannot message/i);
  assert.match(copy.body, /friend requests/i);
  assert.equal(copy.confirmLabel, 'Block user');
  assert.equal(copy.danger, true);
});

test('confirm copy never fabricates a name when the handle is missing', () => {
  assert.match(removeFriendConfirmText('').body, /this person/);
  assert.match(blockUserConfirmText(undefined).body, /this person/);
});

/* --------------------------- immediate UI updates ------------------------- */

test('a removed friend disappears from the list without a reload', () => {
  const friends = [
    { user_id: ME, username: 'me' },
    { user_id: OTHER, username: 'sunita' },
  ];
  const left = withoutPerson(friends, OTHER);
  assert.equal(left.length, 1);
  assert.equal(left[0].user_id, ME);
  // Unknown ids and junk input must not throw.
  assert.equal(withoutPerson(friends, 'nobody').length, 2);
  assert.deepEqual(withoutPerson(null, OTHER), []);
});

test('the blocked list never renders yourself or empty rows', () => {
  const rows = [
    { id: ME, username: 'me' },
    { id: OTHER, username: 'sunita' },
    { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', username: null },
    null,
  ];
  const model = blockedListModel(rows, ME);
  assert.equal(model.length, 1);
  assert.equal(model[0].id, OTHER);
  assert.deepEqual(blockedListModel(undefined, ME), []);
});

test('block and unblock errors are explained in plain language', () => {
  assert.match(describeFriendError('user_blocked'), /blocked/i);
  assert.match(describeFriendError('cannot_block_self'), /block yourself/i);
  assert.match(describeFriendError('block_not_found'), /blocked list/i);
  assert.match(describeFriendError('not_friends'), /not friends/i);
});

/* ---------------------------- database contract --------------------------- */

test('user_blocks stores one row per direction-free pair and self-blocks are rejected', () => {
  assert.match(MIGRATION, /create table if not exists public\.user_blocks/);
  assert.match(MIGRATION, /primary key \(blocker_id, blocked_id\)/);
  assert.match(MIGRATION, /constraint user_blocks_not_self check \(blocker_id <> blocked_id\)/);
  assert.match(MIGRATION, /references auth\.users \(id\) on delete cascade/);
});

test('blocks are readable by their owner only and never writable from the client', () => {
  assert.match(MIGRATION, /alter table public\.user_blocks enable row level security/);
  assert.match(MIGRATION, /create policy "blocks: read own"[\s\S]*?using \(blocker_id = auth\.uid\(\)\)/);

  // No INSERT/UPDATE/DELETE policy may exist on user_blocks: writes are RPC-only.
  const writePolicies = MIGRATION.match(/on public\.user_blocks for (insert|update|delete)/g) || [];
  assert.deepEqual(writePolicies, [], 'a client-writable block table could be forged');
});

test('a block is enforced symmetrically, whichever way it was created', () => {
  const helper = MIGRATION.slice(MIGRATION.indexOf('function public.is_blocked'));
  assert.match(helper, /blocker_id = a and bl\.blocked_id = b/);
  assert.match(helper, /blocker_id = b and bl\.blocked_id = a/);
  assert.match(MIGRATION, /security definer/);
});

test('blocking also removes the friendship and cancels pending requests', () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf('function public.block_user'));
  assert.match(fn, /insert into public\.user_blocks/);
  assert.match(fn, /delete from public\.friendships/);
  assert.match(fn, /status = 'cancelled'/);
  assert.match(fn, /cannot_block_self/);
});

test('removing a friend deletes the friendship for both users and never blocks', () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf('function public.remove_friend'), MIGRATION.indexOf('function public.block_user'));
  assert.match(fn, /delete from public\.friendships/);
  assert.match(fn, /\(f\.user_a = me and f\.user_b = other_user\)/);
  assert.match(fn, /\(f\.user_a = other_user and f\.user_b = me\)/);
  assert.equal(/insert into public\.user_blocks/.test(fn), false, 'remove friend must not block');
  assert.match(fn, /'blocked', false/);
});

test('only the blocker can unblock, and unblocking does not restore a friendship', () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf('function public.unblock_user'), MIGRATION.indexOf('function public.my_blocked_users'));
  assert.match(fn, /delete from public\.user_blocks bl\s+where bl\.blocker_id = me and bl\.blocked_id = other_user/);
  assert.match(fn, /block_not_found/);
  assert.equal(/insert into public\.friendships/.test(fn), false);
});

test('message inserts are refused in the database, not only in the UI', () => {
  assert.match(MIGRATION, /create trigger messages_block_guard\s+before insert on public\.messages/);
  assert.match(MIGRATION, /raise exception 'user_blocked'/);

  // Defence in depth: the RLS insert policy itself carries the block check.
  const policy = MIGRATION.slice(MIGRATION.indexOf('create policy "messages: insert as self"'));
  assert.match(policy, /sender_id = auth\.uid\(\)/);
  assert.match(policy, /public\.is_conversation_member\(conversation_id\)/);
  assert.match(policy, /not public\.conversation_blocked\(conversation_id\)/);
});

test('a blocked user cannot open or land a friend request either', () => {
  assert.match(MIGRATION, /create trigger friend_requests_block_guard\s+before insert or update on public\.friend_requests/);
  const guard = MIGRATION.slice(MIGRATION.indexOf('function public.enforce_no_blocked_requests'));
  assert.match(guard, /if tg_op = 'INSERT' then/);
  assert.match(guard, /new\.status = 'accepted'/);
  // Cancelling must stay allowed, otherwise block_user's own UPDATE would fail.
  assert.match(guard, /coalesce\(old\.status, ''\) <> 'accepted'/);
});

test('reactions and typing are blocked too, so Mini Chat interaction stops', () => {
  assert.match(MIGRATION, /create trigger reactions_block_guard\s+before insert on public\.message_reactions/);
  assert.match(MIGRATION, /create trigger typing_block_guard\s+before insert or update on public\.connect_typing/);
  const reactions = MIGRATION.slice(MIGRATION.indexOf('function public.enforce_no_blocked_reactions'));
  assert.match(reactions, /select m\.conversation_id into conv from public\.messages m where m\.id = new\.message_id/);
});

test('every management call is granted to authenticated users only', () => {
  for (const fn of [
    'public\\.remove_friend\\(uuid\\)',
    'public\\.block_user\\(uuid\\)',
    'public\\.unblock_user\\(uuid\\)',
    'public\\.my_blocked_users\\(\\)',
    'public\\.conversation_blocked\\(uuid\\)',
  ]) {
    assert.match(MIGRATION, new RegExp(`grant execute on function ${fn}\\s+to authenticated`), `${fn} must be callable by a signed-in user`);
  }
  assert.equal(/to anon/i.test(MIGRATION), false, 'blocks must never be exposed to anonymous visitors');
});

test('EXECUTE is least-privilege, so anonymous visitors cannot manage blocks', () => {
  const sql = MIGRATION.replace(/--[^\n]*/g, '');

  // is_blocked is internal: only SECURITY DEFINER code calls it, and that code
  // runs with the owner's privileges, so no client role may keep EXECUTE.
  assert.ok(
    sql.includes('revoke all on function public.is_blocked(uuid, uuid) from public, anon, authenticated;'),
    'is_blocked must be revoked from PUBLIC, anon and authenticated',
  );
  assert.equal(
    sql.includes('grant execute on function public.is_blocked'),
    false,
    'is_blocked must never be granted back to a client role',
  );

  // conversation_blocked is referenced by the messages INSERT policy, which is
  // evaluated as the invoking role, so authenticated must keep EXECUTE.
  assert.ok(sql.includes('revoke all on function public.conversation_blocked(uuid) from public, anon;'));
  assert.ok(sql.includes('grant execute on function public.conversation_blocked(uuid) to authenticated;'));

  for (const fn of ['remove_friend(uuid)', 'block_user(uuid)', 'unblock_user(uuid)', 'my_blocked_users()']) {
    assert.ok(
      sql.includes(`revoke all on function public.${fn} `) && /from public, anon, authenticated;/.test(sql),
      `${fn} must be revoked from PUBLIC and anon before being granted back`,
    );
    assert.ok(sql.includes(`grant execute on function public.${fn}`), `${fn} must stay callable by a signed-in user`);
  }

  // PUBLIC is the role PostgreSQL silently grants EXECUTE to on every function,
  // which is exactly how anon could reach these before this fix.
  assert.equal(/grant execute on function[^;]*to anon/i.test(sql), false, 'no function may be granted to anon');
});

test('the migration is additive: no user content is dropped or rewritten', () => {
  // Only executable SQL matters: the header comment deliberately uses words
  // like "truncates" to promise the opposite of a destructive statement.
  const sql = MIGRATION.replace(/--[^\n]*/g, '');
  assert.equal(/drop table/i.test(sql), false);
  assert.equal(/truncate/i.test(sql), false);
  assert.equal(/delete from public\.(messages|conversations|conversation_members|profiles|memories)/i.test(sql), false);
  assert.equal(/alter table public\.(messages|conversations|profiles)\s+drop/i.test(sql), false);
  assert.match(MIGRATION, /^begin;/m);
  assert.match(MIGRATION, /^commit;/m);
});

/* ------------- Friends list wiring (empty-section bug regression) ---------- */

const friendsConnectSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'connect.js'),
  'utf8',
);

/** Slice one top-level function out of connect.js by name. */
function friendsSliceFunction(name) {
  const head = new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\(`);
  const match = head.exec(friendsConnectSrc);
  if (!match) return '';
  const rest = friendsConnectSrc.slice(match.index + 1);
  const next = /\n(?:export )?(?:async )?function /.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

test('friends are refreshed on tab switch and on open, not only after a request action', () => {
  assert.match(friendsSliceFunction('setTab'), /refreshFriendRows\(\)/);
  assert.match(friendsSliceFunction('open'), /refreshFriendRows\(\)/);
});

test('the friends list is never derived from chat threads', () => {
  const render = friendsSliceFunction('renderFriends');
  assert.notEqual(render, '', 'renderFriends must exist');
  assert.equal(/state\.threads/.test(render), false, 'chats must not be relabelled as friends');
  assert.match(render, /state\.friendRows/);
});

test('a failed friends load is reported instead of silently becoming an empty list', () => {
  const refresh = friendsSliceFunction('refreshFriendRows');
  assert.match(refresh, /friendsError/, 'the failure reason must be kept');
  assert.match(refresh, /catch/);
  assert.equal(
    /catch \(error\) \{\s*state\.friendRows = \[\];\s*\}/.test(refresh),
    false,
    'swallowing the error into [] is the original bug',
  );
});

test('connect.js wires all four friend-management RPCs through the existing client', () => {
  for (const name of ['removeFriend', 'blockUser', 'unblockUser', 'listBlockedUsers']) {
    assert.match(friendsConnectSrc, new RegExp(`\\b${name}\\b`), `${name} must be wired`);
  }
});

test('every friend row renders the three-dot menu with both actions', () => {
  const row = friendsSliceFunction('friendRow');
  assert.notEqual(row, '', 'friendRow must exist');
  assert.match(row, /friendMenuModel\('friends'\)/);
  assert.match(row, /connect-friend__dots/);
  assert.match(row, /item\.id === 'remove'/);
  assert.match(row, /item\.id === 'block'/);
  // The menu only opens the flow; each destructive action confirms before running.
  assert.match(friendsSliceFunction('runRemoveFriend'), /confirmDialog/, 'remove must confirm first');
  assert.match(friendsSliceFunction('runBlockUser'), /confirmDialog/, 'block must confirm first');
});

test('the blocked users section lists blocked people and offers unblock', () => {
  assert.match(friendsConnectSrc, /blockedListModel\(/);
  const blocked = friendsSliceFunction('renderBlocked');
  assert.notEqual(blocked, '', 'renderBlocked must exist');
  assert.match(blocked, /Unblock/);
  assert.match(friendsSliceFunction('refreshBlocked'), /listBlockedUsers\(\)/);
});

test('remove and block refresh the affected lists after succeeding', () => {
  assert.match(friendsSliceFunction('runRemoveFriend'), /refreshFriendRows\(\)/);
  const block = friendsSliceFunction('runBlockUser');
  assert.match(block, /refreshFriendRows\(\)/);
  assert.match(block, /refreshBlocked\(\)/);
  assert.match(friendsSliceFunction('runUnblock'), /refreshBlocked\(\)/);
});
