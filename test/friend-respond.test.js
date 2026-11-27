/**
 * Regression tests for the friend-request Accept bug.
 *
 * Reported bug: pressing Accept in Incoming Requests returned `invalid_decision`
 * and the request stayed pending.
 *
 * Root cause is a vocabulary mismatch, not a permissions problem:
 *   - public.respond_friend_request(request_id uuid, decision text) accepts ONLY
 *     'accept' or 'reject' and raises invalid_decision (22023) otherwise
 *     (supabase/migrations/0002_friends_admin.sql).
 *   - renderRequests() handed the UI's status wording to the RPC
 *     ('accepted' / 'rejected'), so every Accept and Decline was refused before
 *     the row was touched.
 *
 * These tests pin the contract from both sides: the values the database accepts,
 * and the values the frontend actually sends.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { toRpcDecision } from '../public/connect-model.js';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function functionSource(path, name) {
  const text = source(path);
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() must exist in ${path}`);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n(?:async )?function [A-Za-z0-9_$]+\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

/* ------------------------- the database contract ------------------------- */

test('the RPC contract still accepts only accept/reject', () => {
  const migration = source('../supabase/migrations/0002_friends_admin.sql');
  assert.match(
    migration,
    /decision not in \('accept', 'reject'\)/,
    'respond_friend_request must keep the accept/reject vocabulary these tests assume'
  );
  assert.match(
    migration,
    /raise exception 'invalid_decision'/,
    'invalid_decision is the error this bug reported'
  );
});

test('the RPC still restricts answering to the request recipient', () => {
  const migration = source('../supabase/migrations/0002_friends_admin.sql');
  assert.match(
    migration,
    /req\.receiver_id <> me[\s\S]{0,80}raise exception 'not_your_request'/,
    'only the recipient may accept or decline; the fix must not move that check into the UI'
  );
});

/* --------------------- translation of the UI vocabulary -------------------- */

test("the reported values now map to the RPC's commands", () => {
  assert.equal(toRpcDecision('accepted'), 'accept');
  assert.equal(toRpcDecision('rejected'), 'reject');
});

test('canonical command values pass straight through', () => {
  assert.equal(toRpcDecision('accept'), 'accept');
  assert.equal(toRpcDecision('reject'), 'reject');
});

test('decline spellings are understood as reject', () => {
  assert.equal(toRpcDecision('decline'), 'reject');
  assert.equal(toRpcDecision('declined'), 'reject');
});

test('casing and stray whitespace do not break the decision', () => {
  assert.equal(toRpcDecision('  ACCEPTED '), 'accept');
  assert.equal(toRpcDecision('Rejected'), 'reject');
});

test('a value that is not a decision is refused instead of guessed', () => {
  for (const bad of [null, undefined, '', '   ', 'maybe', 0, {}, []]) {
    assert.equal(toRpcDecision(bad), null, `${JSON.stringify(bad)} must not become a decision`);
  }
});

/* -------------------------- what the frontend sends ------------------------ */

test('Accept and Decline send the RPC vocabulary, not the status wording', () => {
  const render = functionSource('../public/connect.js', 'renderRequests');
  assert.match(render, /respond\(req, 'accept', b\)/, 'Accept must send the command the RPC expects');
  assert.match(render, /respond\(req, 'reject', b\)/, 'Decline must send the command the RPC expects');
  assert.doesNotMatch(render, /respond\(req, 'accepted'/, "'accepted' is the bug: the RPC raises invalid_decision");
  assert.doesNotMatch(render, /respond\(req, 'rejected'/, "'rejected' is the bug: the RPC raises invalid_decision");
});

test('the request id travels with the decision', () => {
  const respond = functionSource('../public/connect.js', 'respond');
  assert.match(respond, /respondFriendRequest\(req\.request_id, decision\)/, 'the row id must be passed to the RPC');
});

test('respondFriendRequest translates and sends request_id + decision', () => {
  const fn = functionSource('../public/supabase-client.js', 'respondFriendRequest');
  assert.match(fn, /toRpcDecision\(decision\)/, 'the network layer must normalise the decision');
  assert.match(fn, /callRpc\('respond_friend_request'/, 'must call the real database function');
  assert.match(fn, /request_id: requestId/, 'parameter names must match the RPC signature');
  assert.match(fn, /decision: rpcDecision/, 'the translated value is what the RPC receives');
  assert.doesNotMatch(fn, /decision \}/, 'the raw UI value must never be forwarded untranslated');
});

/* ----------------------- failure and success handling ---------------------- */

test('a failed Accept/Decline is reported, never silently swallowed', () => {
  const respond = functionSource('../public/connect.js', 'respond');
  const catchBlock = respond.slice(respond.indexOf('catch'));
  assert.match(catchBlock, /say\(respondErrorText\(error\), 'bad'\)/, 'the failure must reach the user');
  assert.match(respond, /button\.disabled = false/, 'the button must be re-enabled so the user can retry');
});

test('a refusal the user cannot fix is explained in plain words', () => {
  const connect = source('../public/connect.js');
  assert.match(connect, /invalid_decision: 'That request could not be answered/, 'raw codes must not be shown');
  assert.match(connect, /not_your_request: 'Only the person who received this request can answer it\.'/);
  assert.match(connect, /request_already_answered:/, 'an answered request must say so');
});

test('a successful answer refreshes both lists from the database', () => {
  const respond = functionSource('../public/connect.js', 'respond');
  assert.match(respond, /refreshRequestRows\(\)/, 'the pending row must disappear');
  assert.match(respond, /refreshFriendRows\(\)/, 'the new friend must appear in Friends');
  assert.match(respond, /decision === 'accept'/, 'the confirmation copy must follow the command value');
});
