import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHistoryPayload } from '../public/history-retrieval.js';
import { extractFacts } from '../public/user-context.js';
import { historyBlock, normalizeHistoryInput } from '../server/history.js';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

function conv(id, title, updatedAt, pairs) {
  return {
    id,
    title,
    updatedAt,
    messages: pairs.map(([role, content]) => ({ role, content })),
  };
}

/** Chat A: the earlier conversation that holds the fact. */
function classChat() {
  return conv('a', 'JEE preparation', NOW - 5000, [
    ['user', 'bhai me jee aspirant hu... me abhi 11th class me hu...'],
    ['assistant', 'Samajh gaya — JEE ke liye Physics, Chemistry aur Maths par focus karo.'],
  ]);
}

/** The exact reproduction from the bug report. */
const REPRO_QUERY = 'me konsi class me hu';

function flatten(payload) {
  return payload.excerpts.flatMap((excerpt) => excerpt.messages.map((m) => m.content));
}

function factValues(payload) {
  return payload.facts.map((fact) => fact.value);
}

test('repro: "me konsi class me hu" now carries the message that answers it', () => {
  const payload = buildHistoryPayload([classChat()], { activeId: 'b', query: REPRO_QUERY, now: NOW });

  // It is a question about the user, not a request for chat history...
  assert.equal(payload.isHistory, false);
  // ...but it is no longer answered with titles alone.
  assert.equal(payload.retrieval.mode, 'messages');
  assert.ok(payload.excerpts.length > 0, 'no excerpts retrieved');
  assert.ok(
    flatten(payload).some((content) => content.includes('11th class')),
    `the class message was not retrieved: ${flatten(payload).join(' | ')}`,
  );
  assert.ok(factValues(payload).includes('Class 11'), `facts: ${factValues(payload).join(', ')}`);
  assert.ok(factValues(payload).includes('JEE'));
});

test('repro: the server block states the class instead of "unavailable"', () => {
  const payload = buildHistoryPayload([classChat()], { activeId: 'b', query: REPRO_QUERY, now: NOW });
  const block = historyBlock(normalizeHistoryInput(payload));

  assert.match(block, /Class \/ grade: Class 11/);
  assert.match(block, /Exam goal: JEE/);
  assert.match(block, /RULES FOR USING THIS/);
  assert.match(block, /Never say you cannot see/);
  assert.match(block, /ask the user instead of guessing/);
  // Facts were found, so the "titles only" escape hatch must not be offered.
  assert.doesNotMatch(block, /Only the titles were retrieved/);
});

test('acceptance: "Which class am I in?" answers from the earlier chat', () => {
  const earlier = conv('a', 'Intro', NOW - 5000, [
    ['user', 'I am a Class 11 JEE aspirant studying online through Mission JEE.'],
    ['assistant', 'Got it. We will focus on JEE Physics, Chemistry and Maths.'],
  ]);
  const payload = buildHistoryPayload([earlier], {
    activeId: 'b',
    query: 'Which class am I in?',
    now: NOW,
  });

  assert.equal(payload.retrieval.mode, 'messages');
  assert.ok(flatten(payload).some((content) => content.includes('Class 11')));
  assert.ok(factValues(payload).includes('Class 11'));
  assert.ok(factValues(payload).includes('JEE'));
});

test('retrieves a previous chapter from message content', () => {
  const earlier = conv('a', 'Physics', NOW - 5000, [
    ['user', 'kal humne physics ka chapter 3 motion in a straight line finish kiya'],
    ['assistant', 'Chapter 3 done. Next is chapter 4.'],
  ]);
  const payload = buildHistoryPayload([earlier], {
    activeId: 'b',
    query: 'konsa chapter kiya tha',
    now: NOW,
  });

  assert.ok(payload.excerpts.length > 0, 'no excerpts for a chapter question');
  assert.ok(flatten(payload).some((content) => content.includes('chapter 3')));
});

test('retrieves previous maths questions through the history path', () => {
  const earlier = conv('a', 'Maths doubts', NOW - 5000, [
    ['user', 'Solve: integral of x^2 dx'],
    ['assistant', 'The answer is x^3/3 + C.'],
  ]);
  const payload = buildHistoryPayload([earlier], {
    activeId: 'b',
    query: 'pichle maths questions bhejo',
    now: NOW,
  });

  assert.equal(payload.isHistory, true);
  assert.ok(flatten(payload).some((content) => content.includes('integral of x^2')));
});

test('retrieves previously written code', () => {
  const earlier = conv('a', 'Code', NOW - 5000, [
    ['user', 'ye mera code hai: function add(a, b) { return a + b; }'],
    ['assistant', 'Ye sahi hai, par input validate karo.'],
  ]);
  const payload = buildHistoryPayload([earlier], {
    activeId: 'b',
    query: 'mera code kaha hai',
    now: NOW,
  });

  assert.ok(flatten(payload).some((content) => content.includes('function add')));
});

test('remembers a project decision stated in Hinglish', () => {
  const earlier = conv('a', 'Plan', NOW - 5000, [
    ['user', 'Project ke liye humne decided ki Supabase use karenge'],
    ['assistant', 'Theek hai, Supabase se messaging banayenge.'],
  ]);
  const payload = buildHistoryPayload([earlier], {
    activeId: 'b',
    query: 'humne project ke liye kya decide kiya tha',
    now: NOW,
  });

  const decision = payload.facts.find((fact) => fact.kind === 'decision');
  assert.ok(decision, `decision fact missing: ${factValues(payload).join(', ')}`);
  assert.match(decision.value, /Supabase/i);
  assert.equal(decision.conversationTitle, 'Plan');
});

test('combines facts from several different chats', () => {
  const conversations = [
    classChat(),
    conv('p', 'LOKY AI', NOW - 1000, [
      ['user', 'I am building a LOKY AI chat app with React'],
    ]),
  ];
  const payload = buildHistoryPayload(conversations, {
    activeId: 'b',
    query: 'mera project aur class batao',
    now: NOW,
  });

  const values = factValues(payload);
  assert.ok(values.includes('Class 11'), `class missing: ${values.join(', ')}`);
  assert.ok(
    values.some((value) => /LOKY AI/i.test(value)),
    `project missing: ${values.join(', ')}`,
  );
});

test('a newer statement overrides an older conflicting fact', () => {
  const conversations = [
    conv('old', 'School', NOW - 100000, [['user', 'me 11th class me hu']]),
    conv('new', 'School now', NOW - 1000, [['user', 'ab me 12th class me hu']]),
  ];
  const payload = buildHistoryPayload(conversations, {
    activeId: 'b',
    query: REPRO_QUERY,
    now: NOW,
  });

  const classes = payload.facts.filter((fact) => fact.slot === 'education:class');
  assert.equal(classes.length, 1, 'conflicting class facts must collapse to the newest');
  assert.equal(classes[0].value, 'Class 12');

  const block = historyBlock(normalizeHistoryInput(payload));
  assert.match(block, /Class \/ grade: Class 12/);
});

test('an unrelated question still attaches no transcripts', () => {
  const payload = buildHistoryPayload([classChat()], {
    activeId: 'b',
    query: 'Write a python function to reverse a string',
    now: NOW,
  });

  assert.equal(payload.excerpts.length, 0);
  assert.equal(payload.retrieval.mode, 'index');
});

test('the current conversation is never used as its own memory source', () => {
  const current = conv('b', 'Now', NOW, [['user', 'me 9th class me hu']]);
  const payload = buildHistoryPayload([classChat(), current], {
    activeId: 'b',
    query: REPRO_QUERY,
    now: NOW,
  });

  assert.ok(payload.facts.every((fact) => fact.conversationId === 'a'));
  assert.ok(flatten(payload).every((content) => !content.includes('9th class')));
});

test('extractFacts keeps working when given junk', () => {
  for (const input of [null, undefined, 'nope', 42, [null, {}, { messages: 'x' }]]) {
    assert.ok(Array.isArray(extractFacts(input)));
  }
});

test('normalizeHistoryInput drops malformed facts and clamps long ones', () => {
  const normalized = normalizeHistoryInput({
    index: [],
    excerpts: [],
    facts: [
      null,
      'junk',
      { label: '', value: 'no label' },
      { label: 'Class / grade' },
      { label: 'Class / grade', value: 'Class 11', conversationTitle: 'Intro', messageIndex: 0 },
      { label: 'Goal', value: 'x'.repeat(500) },
    ],
  });

  assert.equal(normalized.facts.length, 2);
  assert.equal(normalized.facts[0].value, 'Class 11');
  assert.ok(Number.isFinite(normalized.facts[0].messageIndex));
  assert.ok(Number.isFinite(normalized.facts[0].updatedAt));
  assert.ok(normalized.facts[1].value.length <= 120);
});

test('the facts section precedes the excerpts so truncation keeps the answer', () => {
  const payload = buildHistoryPayload([classChat()], { activeId: 'b', query: REPRO_QUERY, now: NOW });
  const block = historyBlock(normalizeHistoryInput(payload));

  const factsAt = block.indexOf('WHAT YOU ALREADY KNOW ABOUT THIS USER');
  const excerptsAt = block.indexOf('REAL EXCERPTS');
  assert.ok(factsAt >= 0, 'facts section missing');
  assert.ok(excerptsAt > factsAt, 'facts must come before excerpts');
});
