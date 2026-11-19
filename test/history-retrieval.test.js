import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHistoryPayload,
  conversationTitle,
  detectHistoryIntent,
  rankConversations,
} from '../public/history-retrieval.js';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

function conv(id, title, updatedAt, pairs) {
  return {
    id,
    title,
    updatedAt,
    messages: pairs.map(([role, content]) => ({ role, content })),
  };
}

function baseConversations() {
  return [
    conv('c1', 'Maths doubts', NOW - 3000, [
      ['user', 'Solve 2x + 5 = 15'],
      ['assistant', 'x = 5'],
    ]),
    conv('c2', 'Python help', NOW - 2000, [
      ['user', 'Write a python function to sort a list'],
      ['assistant', 'def sort_list(items): return sorted(items)'],
    ]),
    conv('c3', 'Current chat', NOW - 1000, [['user', 'hello there']]),
  ];
}

test('detects the exact Hinglish request from the bug report', () => {
  const intent = detectHistoryIntent('pichle chat me jo que diye the wapis de');
  assert.equal(intent.isHistory, true);
  assert.equal(intent.kind, 'questions');
});

test('detects the documented history phrasings', () => {
  const cases = [
    ['Pichle chat ke questions dikhao.', 'questions'],
    ['Previous chat ka code wapas do.', 'code'],
    ['Pichle Maths questions bhejo.', 'math'],
    ['Continue where we left off.', 'continue'],
  ];
  for (const [query, kind] of cases) {
    const intent = detectHistoryIntent(query);
    assert.equal(intent.isHistory, true, `should be a history request: ${query}`);
    assert.equal(intent.kind, kind, `wrong kind for: ${query}`);
  }
});

test('detects past-tense history questions without a chat keyword', () => {
  assert.equal(detectHistoryIntent('Kal kya discuss kiya tha?').isHistory, true);
  assert.equal(detectHistoryIntent('Maine last time kya poocha tha?').isHistory, true);
  assert.equal(detectHistoryIntent('Humne project mein kya changes kiye the?').isHistory, true);
});

test('does not treat ordinary questions as history requests', () => {
  const ordinary = [
    'Write a python function to sort a list',
    'What is the capital of France?',
    'Explain photosynthesis in simple words',
    '2 + 2 kitna hota hai',
  ];
  for (const query of ordinary) {
    assert.equal(detectHistoryIntent(query).isHistory, false, `false positive: ${query}`);
  }
});

test('retrieves the real earlier conversation that matches the question', () => {
  const payload = buildHistoryPayload(baseConversations(), {
    activeId: 'c3',
    query: 'pichle chat ke maths questions dikhao',
    now: NOW,
  });

  assert.equal(payload.isHistory, true);
  assert.equal(payload.kind, undefined); // intent lives in payload.intent
  assert.equal(payload.intent, 'math');
  assert.equal(payload.excerpts.length, 1);
  assert.equal(payload.excerpts[0].title, 'Maths doubts');

  const [first, second] = payload.excerpts[0].messages;
  assert.equal(first.role, 'user');
  assert.equal(first.content, 'Solve 2x + 5 = 15');
  assert.equal(second.role, 'assistant');
  assert.equal(second.content, 'x = 5');
});

test('keeps the original order of the user questions', () => {
  const conversations = [
    conv('c1', 'Exam revision', NOW - 5000, [
      ['user', 'Q1: define velocity'],
      ['assistant', 'Velocity is displacement over time.'],
      ['user', 'Q2: define acceleration'],
      ['assistant', 'Acceleration is the rate of change of velocity.'],
    ]),
  ];

  const payload = buildHistoryPayload(conversations, {
    query: 'pichle chat ke questions dikhao',
    now: NOW,
  });

  const questions = payload.excerpts[0].messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content);

  assert.deepEqual(questions, ['Q1: define velocity', 'Q2: define acceleration']);
});

test('never includes the active conversation in the retrieved history', () => {
  const payload = buildHistoryPayload(baseConversations(), {
    activeId: 'c3',
    query: 'pichle chat me jo que diye the wapis de',
    now: NOW,
  });

  const titles = payload.index.map((entry) => entry.title);
  assert.ok(!titles.includes('Current chat'));
  for (const excerpt of payload.excerpts) {
    assert.notEqual(excerpt.title, 'Current chat');
  }
});

test('falls back to the most recent chat when the request names nothing', () => {
  const payload = buildHistoryPayload(baseConversations(), {
    activeId: 'c3',
    query: 'pichle chat me jo que diye the wapis de',
    now: NOW,
  });

  assert.equal(payload.isHistory, true);
  assert.equal(payload.excerpts.length, 1);
  assert.equal(payload.excerpts[0].title, 'Python help');
});

test('sends only the title index for a non-history question', () => {
  const payload = buildHistoryPayload(baseConversations(), {
    activeId: 'c3',
    query: 'Explain recursion in detail',
    now: NOW,
  });

  assert.equal(payload.isHistory, false);
  assert.deepEqual(payload.excerpts, []);
  assert.equal(payload.index.length, 2);
  assert.ok(payload.index.every((entry) => typeof entry.title === 'string'));
});

test('marks several plausible chats as ambiguous so the model can ask', () => {
  const conversations = [
    conv('a', 'Maths doubts', NOW - 1000, [['user', 'trigonometry question']]),
    conv('b', 'Maths homework', NOW - 2000, [['user', 'maths formula list']]),
  ];

  const payload = buildHistoryPayload(conversations, {
    query: 'pichle maths questions bhejo',
    now: NOW,
  });

  assert.equal(payload.excerpts.length, 2);
  assert.equal(payload.ambiguous, true);
});

test('a single match is not ambiguous', () => {
  const conversations = [conv('a', 'Maths doubts', NOW - 1000, [['user', 'trigonometry question']])];

  const payload = buildHistoryPayload(conversations, {
    query: 'pichle maths questions bhejo',
    now: NOW,
  });

  assert.equal(payload.excerpts.length, 1);
  assert.equal(payload.ambiguous, false);
});

test('retrieved text is always verbatim — nothing is invented', () => {
  const conversations = baseConversations();
  const real = new Set(
    conversations.flatMap((entry) => entry.messages.map((message) => message.content)),
  );

  const payload = buildHistoryPayload(conversations, {
    activeId: 'c3',
    query: 'previous chat ka code wapas do',
    now: NOW,
  });

  assert.ok(payload.excerpts.length > 0);
  for (const excerpt of payload.excerpts) {
    for (const message of excerpt.messages) {
      assert.ok(
        real.has(message.content),
        `fabricated content: ${JSON.stringify(message.content)}`,
      );
    }
  }
});

test('caps how much history is shipped for a huge conversation', () => {
  const messages = [];
  for (let index = 0; index < 100; index += 1) {
    messages.push([index % 2 === 0 ? 'user' : 'assistant', `message number ${index}`]);
  }

  const payload = buildHistoryPayload([conv('big', 'Huge chat', NOW - 100, messages)], {
    query: 'pichle chat ke questions dikhao',
    now: NOW,
  });

  const total = payload.excerpts.reduce((sum, excerpt) => sum + excerpt.messages.length, 0);
  assert.ok(total <= 40, `too many messages shipped: ${total}`);
  assert.ok(payload.excerpts[0].messages.length > 0);
});

test('handles an empty or malformed conversation list without throwing', () => {
  for (const input of [[], null, undefined, 'nope', [{}], [{ id: 'x' }]]) {
    const payload = buildHistoryPayload(input, { query: 'pichle chat ke questions dikhao' });
    assert.ok(Array.isArray(payload.index));
    assert.ok(Array.isArray(payload.excerpts));
  }
});

test('ranking excludes the active chat and prefers keyword matches', () => {
  const ranked = rankConversations(baseConversations(), {
    activeId: 'c3',
    query: 'python function',
    now: NOW,
  });

  assert.ok(ranked.length > 0);
  assert.ok(!ranked.some((entry) => entry.conversation.id === 'c3'));
  assert.equal(ranked[0].conversation.id, 'c2');
});

test('titles fall back gracefully when a conversation has no name', () => {
  assert.equal(conversationTitle({ title: '  Named chat  ' }), 'Named chat');
  assert.ok(conversationTitle({}).length > 0);
  assert.ok(conversationTitle({ title: 'x'.repeat(500) }).length <= 80);
});
