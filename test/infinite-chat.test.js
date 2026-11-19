import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTINUED_NOTICE,
  MIN_MESSAGES_BEFORE_SUMMARY,
  buildSummaryPayload,
  continuationLabel,
  continuationRecord,
  continuationTitle,
  pendingMessages,
  planContext,
} from '../public/chat-context.js';
import { normalizeConversations, serializeConversations } from '../public/chat-utils.js';

const msg = (role, content) => ({ role, content });

const conversation = (messages, extra = {}) => ({
  id: 'c1',
  title: 'Study plan',
  createdAt: 1,
  updatedAt: 2,
  messages,
  ...extra,
});

/** `count` turns of `chars` characters: ~125 tokens each at 3.2 chars/token. */
const filler = (count, chars = 400) => {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(msg(i % 2 === 0 ? 'user' : 'assistant', 'w'.repeat(chars)));
  }
  return out;
};

/* -------------------------------- planning -------------------------------- */

test('a short conversation needs neither a summary nor a continuation', () => {
  const plan = planContext(conversation(filler(4)), 24000);
  assert.equal(plan.needsSummary, false);
  assert.equal(plan.needsContinuation, false);
});

test('a conversation past the summary trigger asks for a rolling summary', () => {
  const plan = planContext(conversation(filler(12)), 1000);
  assert.equal(plan.needsSummary, true);
  assert.equal(plan.needsContinuation, false);
});

test('continuation requires a summary to inherit and a genuinely long chat', () => {
  const long = filler(20);

  assert.equal(planContext(conversation(long, { summary: 'x'.repeat(200) }), 1000).needsContinuation, true);
  // No summary yet: a new chat would start context-free, which is worse.
  assert.equal(planContext(conversation(long), 1000).needsContinuation, false);
  // Never split the same conversation twice.
  assert.equal(
    planContext(conversation(long, { summary: 'x'.repeat(200), continuedTo: 'c2' }), 1000).needsContinuation,
    false,
  );
});

test('pendingMessages skips turns already covered by the summary', () => {
  assert.equal(pendingMessages(conversation(filler(10), { summary: 'prior', summaryUpTo: 6 })).length, 4);
  assert.equal(pendingMessages(conversation([])).length, 0);
  assert.equal(pendingMessages(null).length, 0);
});

/* ------------------------------ summary payload --------------------------- */

test('buildSummaryPayload returns null when there is nothing worth folding', () => {
  assert.equal(buildSummaryPayload(conversation([])), null);
  assert.equal(buildSummaryPayload(conversation(filler(2))), null);
});

test('buildSummaryPayload carries the previous summary and the fold point', () => {
  const payload = buildSummaryPayload(conversation(filler(20), { summary: 'prior summary' }));

  assert.ok(payload, 'a long conversation must produce a summary request');
  assert.equal(payload.body.previousSummary, 'prior summary');
  assert.ok(payload.body.messages.length > 0);
  assert.equal(payload.upTo, 20 - 8);
  // Only role/content go to the provider.
  assert.deepEqual(Object.keys(payload.body.messages[0]).sort(), ['content', 'role']);
});

/* ------------------------------ continuation ------------------------------ */

test('a continuation chat copies no messages and links back to the original', () => {
  const previous = conversation(filler(20), { summary: 'prior summary' });
  const record = continuationRecord({ previous, id: 'c2', summary: 'prior summary', now: 5000 });

  assert.equal(record.id, 'c2');
  assert.deepEqual(record.messages, [], 'the transcript must not be duplicated');
  assert.equal(record.summary, 'prior summary');
  assert.equal(record.continuedFrom, 'c1');
  assert.equal(record.continuedFromTitle, 'Study plan');
  assert.match(record.title, /\(continued\)$/);
  assert.equal(record.createdAt, 5000);
});

test('continuationTitle stays inside the stored title limit', () => {
  assert.equal(continuationTitle('Physics'), 'Physics (continued)');
  assert.equal(continuationTitle(''), 'Conversation (continued)');

  const long = continuationTitle('x'.repeat(200));
  assert.ok(long.length <= 80);
  assert.match(long, /\(continued\)$/);
});

test('continuationLabel describes the link in both directions', () => {
  assert.equal(continuationLabel(null), '');
  assert.equal(continuationLabel(conversation([])), '');

  const from = continuationLabel({ continuedFrom: 'c1', continuedFromTitle: 'Study plan' });
  assert.ok(from.length > 0);
  assert.match(from, /Study plan/);

  assert.ok(continuationLabel({ continuedTo: 'c2' }).length > 0);
  assert.equal(CONTINUED_NOTICE, 'Conversation continued in a new chat.');
});

/* --------------------------------- storage -------------------------------- */

test('conversation metadata survives a storage round trip', () => {
  const original = conversation(filler(2), {
    summary: 'rolling summary',
    summaryUpTo: 1,
    continuedFrom: 'c0',
    continuedFromTitle: 'Earlier chat',
    continuedTo: 'c2',
  });

  const raw = serializeConversations([original]);
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const list = Array.isArray(parsed) ? parsed : parsed.conversations;
  const back = normalizeConversations(list)[0];

  assert.equal(back.summary, 'rolling summary');
  assert.equal(back.summaryUpTo, 1);
  assert.equal(back.continuedFrom, 'c0');
  assert.equal(back.continuedFromTitle, 'Earlier chat');
  assert.equal(back.continuedTo, 'c2');
  assert.equal(back.messages.length, 2);
});

test('the summary threshold is not accidentally tiny', () => {
  assert.ok(MIN_MESSAGES_BEFORE_SUMMARY >= 6);
});
