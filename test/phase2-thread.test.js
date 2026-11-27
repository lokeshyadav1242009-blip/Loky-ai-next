/**
 * Phase 2 — desktop navigation and block/unblock inside a conversation.
 *
 * The pure rules live in public/connect-model.js so they can be tested without
 * a DOM. The wiring assertions read public/connect.js because that module needs
 * a browser; they only prove the header menu, the labelled back control and the
 * blocked composer state are actually present in the shipped source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  threadMenuModel,
  isPersonBlocked,
  threadBlockedNotice,
} from '../public/connect-model.js';

const connectSource = readFileSync(new URL('../public/connect.js', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

const ids = (model) => model.items.map((item) => item.id);

/* ------------------------------ header menu ------------------------------- */

test('a friend conversation offers profile, remove and block', () => {
  const menu = threadMenuModel({ isFriend: true, isBlocked: false });
  assert.equal(menu.visible, true);
  assert.deepEqual(ids(menu), ['profile', 'remove', 'block']);
});

test('a chat-only contact offers profile and block but not remove', () => {
  const menu = threadMenuModel({ isFriend: false, isBlocked: false });
  assert.deepEqual(ids(menu), ['profile', 'block']);
});

test('a blocked peer offers unblock and never block or remove', () => {
  const menu = threadMenuModel({ isFriend: true, isBlocked: true });
  assert.deepEqual(ids(menu), ['profile', 'unblock']);
  assert.equal(
    menu.items.some((item) => item.id === 'block'),
    false,
    'blocking an already blocked user must not be offered'
  );
});

test('only the destructive block action is flagged as danger', () => {
  const menu = threadMenuModel({ isFriend: true });
  const danger = menu.items.filter((item) => item.danger).map((item) => item.id);
  assert.deepEqual(danger, ['block']);
});

test('a conversation with yourself has no menu at all', () => {
  const menu = threadMenuModel({ isFriend: false, isBlocked: false, isSelf: true });
  assert.equal(menu.visible, false);
  assert.deepEqual(menu.items, []);
});

test('every menu label is human readable', () => {
  const menu = threadMenuModel({ isFriend: true });
  for (const item of menu.items) {
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 3);
  }
});

/* ----------------------------- blocked helpers ---------------------------- */

test('isPersonBlocked matches only the signed-in user own block list', () => {
  const blocked = [{ id: 'peer-1' }, { id: 'peer-2' }];
  assert.equal(isPersonBlocked(blocked, 'peer-1'), true);
  assert.equal(isPersonBlocked(blocked, 'peer-9'), false);
});

test('isPersonBlocked is safe without an id or without a list', () => {
  assert.equal(isPersonBlocked([{ id: 'peer-1' }], null), false);
  assert.equal(isPersonBlocked(undefined, 'peer-1'), false);
  assert.equal(isPersonBlocked(null, 'peer-1'), false);
});

test('blocked notice names the handle and points at unblock', () => {
  const text = threadBlockedNotice('sunita');
  assert.match(text, /@sunita/);
  assert.match(text, /[Uu]nblock/);
  assert.match(text, /existing messages/i);
});

test('blocked notice does not double the @ prefix', () => {
  assert.match(threadBlockedNotice('@sunita'), /^You blocked @sunita\./);
  assert.doesNotMatch(threadBlockedNotice('@sunita'), /@@/);
});

test('blocked notice stays readable without a username', () => {
  const text = threadBlockedNotice('');
  assert.match(text, /this user/);
  assert.doesNotMatch(text, /@/);
});

/* ------------------------------- wiring ---------------------------------- */

test('the conversation header keeps a labelled back control for desktop', () => {
  assert.match(connectSource, /connect-back__label/);
  assert.match(connectSource, /Back to chats/);
  assert.match(connectSource, /connect-icon--back/);
  assert.match(connectSource, /addEventListener\('click', \(\) => closeThread\(\)\)/);
});

test('the back label is only hidden below 720px', () => {
  assert.match(stylesSource, /\.connect-back__label\s*\{[^}]*display:\s*none/);
  assert.match(
    stylesSource,
    /@media \(min-width: 720px\)\s*\{\s*\.connect-back__label\s*\{\s*display:\s*inline/,
    'the label must reappear on desktop and tablet widths'
  );
});

test('the conversation header mounts the peer menu', () => {
  assert.match(connectSource, /dom\.threadMore = h\('div', 'connect-friend__more connect-thread__more'\)/);
  assert.match(connectSource, /top\.append\(dom\.backBtn, dom\.threadAvatar, who, dom\.threadMore\)/);
  assert.match(connectSource, /threadMenuModel\(\{/);
});

test('header menu actions call the real friend RPC wrappers', () => {
  assert.match(connectSource, /item\.id === 'remove'\) await runRemoveFriend\(target, action\)/);
  assert.match(connectSource, /item\.id === 'block'\) await runBlockUser\(target, action\)/);
  assert.match(connectSource, /await runUnblock\(\{ id: peerId, username: state\.active\.username \}, action\)/);
  assert.match(connectSource, /item\.id === 'profile'\) openPeerProfile\(\)/);
});

test('a chat contact can still be blocked without being a friend', () => {
  assert.match(
    connectSource,
    /const target = friendRow \|\| \{ user_id: peerId, username: state\.active\.username \}/,
    'blocking must work for a conversation that has no accepted friendship'
  );
});

test('unblock asks for confirmation before calling the RPC', () => {
  const block = connectSource.slice(
    connectSource.indexOf('async function runUnblock'),
    connectSource.indexOf('async function refreshRequestRows')
  );
  assert.match(block, /confirmDialog\(unblockConfirmText\(person\.username\)\)/);
  assert.ok(
    block.indexOf('unblockConfirmText') < block.indexOf('await unblockUser('),
    'confirmation must happen before the unblock RPC'
  );
});

test('the conversation shows a blocked banner and disables the composer', () => {
  assert.match(connectSource, /connect-thread__blocked/);
  assert.match(connectSource, /threadBlockedNotice\(state\.active\.username\)/);
  assert.match(connectSource, /dom\.input\.disabled = isBlocked/);
  assert.match(connectSource, /dom\.sendBtn\.disabled = isBlocked/);
  assert.match(connectSource, /dom\.attachBtn\.disabled = isBlocked/);
  assert.match(stylesSource, /\.connect-thread__blocked\s*\{/);
  assert.match(stylesSource, /\.connect-thread__blocked\[hidden\]\s*\{\s*display:\s*none/);
});

test('sending is blocked before any upload starts', () => {
  const start = connectSource.indexOf('async function submit');
  assert.ok(start > 0, 'submit must exist');
  // Wide enough to reach the media upload branch inside the same function.
  const submit = connectSource.slice(start, start + 2000);
  assert.match(submit, /if \(!state\.active \|\| state\.active\.blocked\) return;/);
  const guardAt = submit.indexOf('state.active.blocked');
  const uploadAt = submit.indexOf('uploadConnectMedia');
  assert.ok(uploadAt > 0, 'submit still uploads attachments for unblocked chats');
  assert.ok(
    guardAt < uploadAt,
    'the blocked guard must run before media upload'
  );
});

test('opening a conversation records the peer id and refreshes block state', () => {
  assert.match(connectSource, /peerId: row\.peer_id \|\| null/);
  assert.match(connectSource, /refreshBlocked\(\)\.then\(renderThreadHead\)/);
});

test('the peer profile card is defined once and exposes no email', () => {
  const declarations = connectSource.match(/function openPeerProfile\(/g) || [];
  assert.equal(declarations.length, 1);
  const body = connectSource.slice(
    connectSource.indexOf('function openPeerProfile('),
    connectSource.indexOf('function renderThreads(')
  );
  assert.doesNotMatch(body, /email/i);
  assert.match(body, /Relationship: /);
});
