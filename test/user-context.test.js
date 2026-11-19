import test from 'node:test';
import assert from 'node:assert/strict';

import { extractFacts, extractFromMessage, relevantFacts } from '../public/user-context.js';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

function conv(id, title, updatedAt, pairs) {
  return {
    id,
    title,
    updatedAt,
    messages: pairs.map(([role, content]) => ({ role, content })),
  };
}

/** The exact Hinglish message from the bug report. */
const JEE_CHAT = () =>
  conv('a', 'JEE prep', NOW - 5000, [
    ['user', 'bhai me jee aspirant hu... me abhi 11th class me hu...'],
    ['assistant', 'Samajh gaya. JEE ke liye Physics, Chemistry aur Maths par focus karo.'],
  ]);

test('extracts class and exam from the reported Hinglish message', () => {
  const facts = extractFacts([JEE_CHAT()]);
  const labels = facts.map((fact) => `${fact.label}=${fact.value}`);

  assert.ok(labels.includes('Class / grade=Class 11'), `missing class: ${labels.join(', ')}`);
  assert.ok(labels.includes('Exam goal=JEE'), `missing exam: ${labels.join(', ')}`);
});

test('every fact keeps its source conversation and message reference', () => {
  const facts = extractFacts([JEE_CHAT()]);
  const classFact = facts.find((fact) => fact.slot === 'education:class');

  assert.ok(classFact);
  assert.equal(classFact.conversationId, 'a');
  assert.equal(classFact.conversationTitle, 'JEE prep');
  assert.equal(classFact.messageIndex, 0);
  assert.equal(classFact.updatedAt, NOW - 5000);
  // Verbatim support, not a paraphrase.
  assert.ok(classFact.text.includes('11th class'));
});

test('extracts the English phrasing used in the acceptance test', () => {
  const facts = extractFacts([
    conv('a', 'Intro', NOW - 1000, [
      ['user', 'I am a Class 11 JEE aspirant studying online through Mission JEE.'],
    ]),
  ]);

  const values = facts.map((fact) => fact.value);
  assert.ok(values.includes('Class 11'));
  assert.ok(values.includes('JEE'));
  assert.ok(values.some((value) => value.includes('Online')), `study mode missing: ${values.join(', ')}`);
});

test('assistant messages never become memories', () => {
  const facts = extractFacts([
    conv('a', 'Guess', NOW - 1000, [
      ['assistant', 'You are in class 12 and preparing for NEET.'],
      ['user', 'ok'],
    ]),
  ]);

  assert.deepEqual(facts, []);
});

test('a newer statement replaces an older one for singular attributes', () => {
  const conversations = [
    conv('old', 'School', NOW - 100000, [['user', 'me 11th class me hu']]),
    conv('new', 'School 2', NOW - 1000, [['user', 'ab me 12th class me hu']]),
  ];

  const facts = extractFacts(conversations);
  const classes = facts.filter((fact) => fact.slot === 'education:class');

  assert.equal(classes.length, 1, 'conflicting class facts must collapse to one');
  assert.equal(classes[0].value, 'Class 12');
  assert.equal(classes[0].conversationId, 'new');
});

test('additive facts from several chats are kept and deduplicated', () => {
  const conversations = [
    conv('p1', 'Project A', NOW - 5000, [['user', 'I am building a LOKY AI chat app with React']]),
    conv('p2', 'Project B', NOW - 2000, [['user', 'I am developing a portfolio website']]),
    conv('p3', 'Stack', NOW - 1000, [['user', 'React is what I use']]),
  ];

  const facts = extractFacts(conversations);
  const projects = facts.filter((fact) => fact.kind === 'project');
  const react = facts.filter((fact) => fact.kind === 'technical' && fact.value === 'React');

  assert.equal(projects.length, 2, 'both projects must survive');
  assert.equal(react.length, 1, 'the same technology must not be stored twice');
});

test('captures decisions and preferences stated in Hinglish', () => {
  const facts = extractFacts([
    conv('d', 'Plan', NOW - 1000, [
      ['user', 'Project ke liye humne decided ki Supabase use karenge'],
      ['user', 'mujhe one shot lectures pasand hai'],
    ]),
  ]);

  const decision = facts.find((fact) => fact.kind === 'decision');
  const preference = facts.find((fact) => fact.kind === 'preference');

  assert.ok(decision, 'decision missing');
  assert.ok(decision.value.toLowerCase().includes('supabase'), decision.value);
  assert.ok(preference, 'preference missing');
  assert.ok(preference.value.toLowerCase().includes('one shot'), preference.value);
});

test('the active conversation is excluded from extracted facts', () => {
  const conversations = [JEE_CHAT(), conv('current', 'Now', NOW, [['user', 'me 9th class me hu']])];
  const facts = extractFacts(conversations, { activeId: 'current' });

  assert.ok(facts.every((fact) => fact.conversationId !== 'current'));
});

test('relevant facts for "me konsi class me hu" put the class first', () => {
  const facts = extractFacts([JEE_CHAT()]);
  const ranked = relevantFacts(facts, 'me konsi class me hu');

  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].slot, 'education:class');
  assert.equal(ranked[0].value, 'Class 11');
});

test('core facts still ride along when the wording matches nothing', () => {
  const facts = extractFacts([JEE_CHAT()]);
  const ranked = relevantFacts(facts, 'kuch batao');

  // Nothing matched, so the core education/goal facts are used as fillers.
  assert.ok(ranked.some((fact) => fact.slot === 'education:class'));
});

test('extractFromMessage never throws on junk input', () => {
  for (const input of [null, undefined, '', 42, {}, 'a'.repeat(5000)]) {
    assert.ok(Array.isArray(extractFromMessage(input)));
  }
});
