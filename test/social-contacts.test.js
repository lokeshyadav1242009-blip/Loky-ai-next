/**
 * Phase 1 regression tests for the merged social contact list.
 *
 * The requirement that broke before: users visible in Chats never appeared in
 * Friends. These tests pin the merge rules — both kinds are listed, an accepted
 * friendship wins over the same person as a chat contact, nothing is listed
 * twice, and the labels stay distinguishable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildContacts,
  contactKindLabel,
  contactSummary,
  filterContacts,
  isFriendContact,
  CONTACT_KIND_CHAT,
  CONTACT_KIND_FRIEND,
} from '../public/social-contacts.js';

const ME = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUNITA = 'bbbbbbbb-0000-0000-0000-000000000002';
const RAHUL = 'cccccccc-0000-0000-0000-000000000003';

const friendRow = (over = {}) => ({
  user_id: SUNITA,
  username: 'sunita',
  display_name: 'Sunita Yadav',
  avatar_seed: 'sunita',
  friends_since: '2026-11-01T10:00:00.000Z',
  ...over,
});

const threadRow = (over = {}) => ({
  conversation_id: 'conv-1',
  peer_id: RAHUL,
  peer_username: 'rahul',
  peer_display_name: 'Rahul',
  peer_avatar_url: 'rahul',
  last_body: 'hello',
  last_at: '2026-11-20T10:00:00.000Z',
  last_sender_id: SUNITA,
  unread_count: 2,
  ...over,
});

test('a chat-only contact is listed next to an accepted friend', () => {
  const contacts = buildContacts({ friends: [friendRow()], threads: [threadRow()], meId: ME });

  assert.equal(contacts.length, 2);
  const byName = new Map(contacts.map((c) => [c.username, c]));

  assert.equal(byName.get('sunita').kind, CONTACT_KIND_FRIEND, 'accepted friend stays a friend');
  assert.equal(byName.get('rahul').kind, CONTACT_KIND_CHAT, 'a messageable contact is not a friend');
});

test('an accepted friend wins over the same person as a chat contact', () => {
  const contacts = buildContacts({
    friends: [friendRow()],
    threads: [threadRow({ peer_id: SUNITA, peer_username: 'sunita' })],
    meId: ME,
  });

  assert.equal(contacts.length, 1, 'the same user must not be listed twice');
  assert.equal(contacts[0].kind, CONTACT_KIND_FRIEND);
  assert.equal(contacts[0].conversationId, 'conv-1', 'the existing conversation is still reachable');
});

test('the same chat contact is never duplicated across threads', () => {
  const contacts = buildContacts({
    threads: [threadRow(), threadRow({ conversation_id: 'conv-2' })],
    meId: ME,
  });

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].userId, RAHUL);
});

test('the signed-in user is never listed as their own contact', () => {
  const contacts = buildContacts({
    friends: [friendRow({ user_id: ME, username: 'lokesh' })],
    threads: [threadRow({ peer_id: ME, peer_username: 'lokesh' })],
    meId: ME,
  });

  assert.equal(contacts.length, 0);
});

test('a chat contact keeps its conversation so selecting it opens that thread', () => {
  const contacts = buildContacts({ threads: [threadRow()], meId: ME });
  const rahul = contacts[0];

  assert.equal(rahul.conversationId, 'conv-1');
  assert.ok(rahul.threadRow, 'the original thread row is kept for openThread()');
  assert.equal(rahul.unreadCount, 2);
  assert.equal(rahul.lastAt, '2026-11-20T10:00:00.000Z');
});

test('a friend without a conversation is still listed and can be messaged', () => {
  const contacts = buildContacts({ friends: [friendRow()], meId: ME });

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].conversationId, null);
  assert.equal(contacts[0].userId, SUNITA);
  assert.ok(contacts[0].friendRow, 'the raw friend row is kept for remove/block');
});

test('labels distinguish a friend from a chat contact', () => {
  assert.equal(contactKindLabel(CONTACT_KIND_FRIEND), 'Friend');
  assert.equal(contactKindLabel(CONTACT_KIND_CHAT), 'Chat contact');
  assert.equal(contactKindLabel(undefined), 'Chat contact');
});

test('friends are listed before chat contacts', () => {
  const contacts = buildContacts({ friends: [friendRow()], threads: [threadRow()], meId: ME });

  assert.equal(contacts[0].kind, CONTACT_KIND_FRIEND);
  assert.equal(contacts[1].kind, CONTACT_KIND_CHAT);
});

test('isFriendContact only accepts real friendships', () => {
  assert.equal(isFriendContact({ kind: CONTACT_KIND_FRIEND }), true);
  assert.equal(isFriendContact({ kind: CONTACT_KIND_CHAT }), false);
  assert.equal(isFriendContact(null), false);
});

test('contactSummary counts each kind', () => {
  const contacts = buildContacts({ friends: [friendRow()], threads: [threadRow()], meId: ME });

  assert.equal(contactSummary(contacts), '1 friend · 1 chat contact');
  assert.equal(contactSummary([]), '');
});

test('filterContacts matches username and display name', () => {
  const contacts = buildContacts({ friends: [friendRow()], threads: [threadRow()], meId: ME });

  assert.equal(filterContacts(contacts, '@SUN').length, 1);
  assert.equal(filterContacts(contacts, 'rahul').length, 1);
  assert.equal(filterContacts(contacts, 'nobody').length, 0);
  assert.equal(filterContacts(contacts, '').length, 2);
});

test('a failed friend load still lists chat contacts', () => {
  // state.friendRows is empty when my_friends() errors; the chat contacts must
  // survive that so the pane is never blank.
  const contacts = buildContacts({ friends: [], threads: [threadRow()], meId: ME });

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].kind, CONTACT_KIND_CHAT);
});
