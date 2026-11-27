/**
 * Regression tests for "delete message for everyone" in LOKY CONNECT.
 *
 * The feature is a soft delete. The row survives so both participants keep the
 * timeline position, and public.connect_delete_message() blanks the payload:
 *
 *   update public.messages
 *      set deleted_at = now(), body = '', media_path = null, media_type = null
 *    where id = ... and sender_id = auth.uid() and deleted_at is null;
 *
 * Two properties matter and both are pinned here:
 *
 *   1. Ownership is enforced in the database. The function is SECURITY DEFINER
 *      and matches sender_id = auth.uid(); public.messages has no UPDATE or
 *      DELETE policy at all, so the RPC is the only write path. The UI check in
 *      canDeleteMessage() is convenience and must never be treated as the guard.
 *
 *   2. A deleted row renders as a placeholder with no attachment, and that
 *      survives reload because connect_messages() returns deleted rows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  DELETED_TEXT,
  canDeleteMessage,
  deleteMessageErrorText,
  previewText,
} from '../public/connect-model.js';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function functionSource(path, name) {
  const text = source(path);
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() must exist in ${path}`);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n(?:async )?function [A-Za-z0-9_$]+\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The body of a single SQL function, from its create to the next one. */
function sqlFunction(name) {
  const migration = source('../supabase/migrations/0003_loky_connect.sql');
  const start = migration.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `public.${name}() must exist in 0003_loky_connect.sql`);
  const rest = migration.slice(start);
  const next = rest.indexOf('create or replace function', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

/* ---------------------------- the placeholder ---------------------------- */

test('the placeholder uses the exact agreed wording', () => {
  assert.equal(DELETED_TEXT, 'This message was deleted');
});

test('a deleted row previews as the placeholder, never as its old text', () => {
  assert.equal(previewText({ deleted_at: '2026-01-01T00:00:00Z', body: 'secret' }), DELETED_TEXT);
  assert.equal(
    previewText({ deleted_at: '2026-01-01T00:00:00Z', body: '', media_type: 'image' }),
    DELETED_TEXT,
    'a deleted photo must not preview as 📷 Photo'
  );
});

/* --------------------------- who may delete ------------------------------ */

test('only the sender is offered delete, and never twice', () => {
  const me = '11111111-1111-1111-1111-111111111111';
  const them = '22222222-2222-2222-2222-222222222222';

  assert.equal(canDeleteMessage({ sender_id: me }, me), true, 'own live message');
  assert.equal(canDeleteMessage({ sender_id: them }, me), false, "someone else's message");
  assert.equal(
    canDeleteMessage({ sender_id: me, deleted_at: '2026-01-01T00:00:00Z' }, me),
    false,
    'already deleted'
  );
  assert.equal(canDeleteMessage({ sender_id: me }, null), false, 'signed out');
  assert.equal(canDeleteMessage(null, me), false, 'no row');
});

/* ------------------------ the database is the guard ---------------------- */

test('connect_delete_message blanks the payload and keeps the row', () => {
  const fn = sqlFunction('connect_delete_message');
  assert.match(fn, /security definer/, 'must run as definer so RLS cannot be used to widen it');
  assert.match(fn, /set deleted_at = now\(\)/, 'soft delete, not a row delete');
  assert.doesNotMatch(fn, /delete from public\.messages/i, 'must never hard-delete history');
  assert.match(fn, /body = ''/, 'body is blanked so the old text is gone from the database');
  assert.match(fn, /media_path = null/, 'attachment reference is cleared');
  assert.match(fn, /media_type = null/, 'attachment type is cleared');
  assert.match(fn, /and sender_id = auth\.uid\(\)/, 'ownership is enforced on the server');
  assert.match(fn, /and deleted_at is null/, 'a second delete is a no-op, not a re-stamp');
});

test('a non-sender delete is refused with 42501', () => {
  const fn = sqlFunction('connect_delete_message');
  assert.match(fn, /if not found then/);
  assert.match(fn, /raise exception 'only the sender can delete their own message'/);
  assert.match(fn, /errcode = '42501'/);
});

test('the RPC is granted to authenticated users only', () => {
  const migration = source('../supabase/migrations/0003_loky_connect.sql');
  assert.match(
    migration,
    /grant execute on function public\.connect_delete_message\(uuid\)\s+to authenticated;/
  );
});

test('messages has no UPDATE or DELETE policy, so the RPC cannot be bypassed', () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const all = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => readFileSync(new URL(name, dir), 'utf8'))
    .join('\n');

  assert.doesNotMatch(
    all,
    /on public\.messages for (update|delete)/i,
    'a browser-side PATCH/DELETE must stay impossible; deletion goes through the RPC'
  );
});

/* ---------------------------- the client call ---------------------------- */

test('the client calls the RPC with the documented argument name', () => {
  const client = source('../public/supabase-client.js');
  assert.match(
    client,
    /export async function connectDeleteMessage\(messageId\) \{\s*return callRpc\('connect_delete_message', \{ message_id: messageId \}\);/,
    'the argument must stay message_id to match the SQL signature'
  );
});

/* ------------------------------ the bubble ------------------------------- */

test('a deleted bubble shows only the placeholder, never the attachment', () => {
  const bubble = functionSource('../public/connect.js', 'buildBubble');
  const deletedStart = bubble.indexOf('if (row.deleted_at)');
  const elseAt = bubble.indexOf('} else {');
  assert.notEqual(deletedStart, -1, 'buildBubble must branch on deleted_at');
  assert.ok(elseAt > deletedStart, 'the live branch must follow the deleted branch');

  const deletedBranch = bubble.slice(deletedStart, elseAt);
  assert.match(deletedBranch, /DELETED_TEXT/);
  assert.doesNotMatch(deletedBranch, /buildMedia/, 'no image/video preview may survive deletion');
  assert.doesNotMatch(deletedBranch, /row\.body/, 'no leftover text may survive deletion');

  const liveBranch = bubble.slice(elseAt, bubble.indexOf('const meta ='));
  assert.match(liveBranch, /buildMedia/, 'live messages still render media');
});

test('the ⋮ menu is guarded by canDeleteMessage, not by a local comparison', () => {
  const bubble = functionSource('../public/connect.js', 'buildBubble');
  assert.match(
    bubble,
    /if \(canDeleteMessage\(row, state\.me && state\.me\.id\)\)/,
    'the single UI gate must be the shared helper'
  );
  assert.match(bubble, /'⋮'/, 'a three-dot affordance, not a bare trash glyph');
  assert.match(bubble, /aria-haspopup/);
  assert.match(bubble, /'Delete Message'/, 'the menu item must be labelled');
  assert.doesNotMatch(
    bubble,
    /mine && !row\.deleted_at\) \{\s*const del/,
    'delete must not be gated on a hand-rolled comparison again'
  );
});

test('the menu opens, closes and cannot stack with other menus', () => {
  const closeMenus = functionSource('../public/connect.js', 'closeMenus');
  assert.match(closeMenus, /\.connect-bubble__actions/);
  assert.match(closeMenus, /\.connect-bubble__dots/);
});

/* ---------------------------- the confirmation --------------------------- */

test('deleting asks first, with the exact prompt and a Delete button', () => {
  const remove = functionSource('../public/connect.js', 'removeMessage');
  assert.match(remove, /await confirmDialog\(/, 'a confirmation step is required');
  assert.match(remove, /'Delete this message for everyone\?'/);
  assert.match(remove, /confirmLabel: 'Delete'/);
  assert.match(remove, /danger: true/);
  assert.match(remove, /if \(!confirmed\) return;/, 'Cancel must abort before any network call');
  assert.ok(
    remove.indexOf('confirmDialog') < remove.indexOf('connectDeleteMessage'),
    'the prompt must come before the RPC'
  );
});

test('a confirmed delete refreshes the thread so both sides see the placeholder', () => {
  const remove = functionSource('../public/connect.js', 'removeMessage');
  assert.match(remove, /await connectDeleteMessage\(row\.id\)/);
  assert.match(remove, /await refreshThread\(\)/);
  assert.match(remove, /await refreshThreads\(\)/);
});

test('a refused delete surfaces a readable reason instead of failing silently', () => {
  const remove = functionSource('../public/connect.js', 'removeMessage');
  assert.match(remove, /deleteMessageErrorText\(error\)/);
  assert.match(remove, /say\(deleteMessageErrorText\(error\), 'bad'\)/);

  assert.equal(
    deleteMessageErrorText({ code: '42501', message: 'only the sender can delete their own message' }),
    'You can only delete your own messages.'
  );
  assert.equal(
    deleteMessageErrorText({ message: 'only the sender can delete their own message' }),
    'You can only delete your own messages.'
  );
  assert.match(deleteMessageErrorText({ message: 'Failed to fetch' }), /Network problem/);
  assert.equal(deleteMessageErrorText({}), 'That message could not be deleted.');
});

/* ------------------------------ the styling ------------------------------ */

test('the menu has Emerald styling and a hidden state that actually hides', () => {
  const css = source('../public/styles.css');
  assert.match(css, /\.connect-bubble \{ position: relative; \}/);
  assert.match(css, /\.connect-bubble__actions\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.connect-bubble__action--danger/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]{0,200}\.connect-bubble__dots \{ width: 38px/);
});
