/**
 * Automatic memory extraction.
 *
 * Everything that decides what gets remembered is pure, so it is asserted
 * directly: the parser (malformed model output must never throw), the write
 * planner (duplicates, superseded preferences, ambiguous changes, quota) and
 * the runner (user switch, provider failure, unconfirmed writes).
 *
 * The runner is exercised with an injected store and completion function, so no
 * network or database is involved and a failure here is a real logic bug.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CANDIDATES,
  buildTranscript,
  createExtractionQueue,
  parseExtraction,
  planMemoryWrites,
  runMemoryExtraction,
  scheduleMemoryExtraction,
} from '../server/memory-extract.js';

const enabledSettings = { enabled: true, timeoutMs: 1000, maxConcurrent: 2 };

const candidate = (content, category = 'study', importance = 0.8, confidence = 0.8) => ({
  content,
  category,
  importance,
  confidence,
});

/** Minimal in-memory stand-in for the PostgREST store. */
function fakeStore({ rows = [], enabled = true, createError = null, updateError = null } = {}) {
  const state = { rows: rows.map((row) => ({ ...row })), enabled, created: [], updated: [], reads: 0 };
  return {
    state,
    async getEnabled() {
      return state.enabled;
    },
    async list() {
      state.reads += 1;
      return state.rows.map((row) => ({ ...row }));
    },
    async create(input) {
      if (createError) throw createError;
      const row = { id: `new-${state.created.length + 1}`, ...input };
      state.created.push(input);
      state.rows.push(row);
      return row;
    },
    async update(id, patch) {
      if (updateError) throw updateError;
      state.updated.push({ id, patch });
      const row = state.rows.find((entry) => entry.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
  };
}

function runWith({ store, reply = '{"memories":[]}', complete = null, messages, settings = enabledSettings }) {
  return runMemoryExtraction({
    config: { provider: 'openai', apiKey: 'test', model: 'test' },
    token: 'token-a',
    creds: { url: 'https://example.supabase.co', key: 'anon' },
    messages: messages ?? [
      { role: 'user', content: 'I am a Class 11 JEE aspirant.' },
      { role: 'assistant', content: 'Got it.' },
    ],
    conversationId: 'chat-1',
    settings,
    storeFactory: () => store,
    complete: complete ?? (async () => reply),
    log: () => {},
  });
}

/* ------------------------------- parsing ---------------------------------- */

test('parseExtraction reads JSON wrapped in prose and code fences', () => {
  const raw = [
    'Here are the memories:',
    '```json',
    '{"memories":[{"content":"The user is a Class 11 JEE aspirant.","category":"study","importance":0.9,"confidence":0.85}]}',
    '```',
  ].join('\n');
  const parsed = parseExtraction(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].category, 'study');
  assert.equal(parsed[0].importance, 0.9);
});

test('parseExtraction accepts a bare array and clamps out-of-range scores', () => {
  const parsed = parseExtraction(
    '[{"content":"The user is preparing for JEE Advanced.","category":"study","importance":9,"confidence":-3}]',
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].importance, 1);
  assert.equal(parsed[0].confidence, 0);
});

test('parseExtraction returns nothing instead of throwing on bad output', () => {
  assert.deepEqual(parseExtraction('the model rambled and returned no json'), []);
  assert.deepEqual(parseExtraction('{"memories": [ }'), []);
  assert.deepEqual(parseExtraction(''), []);
  assert.deepEqual(parseExtraction(null), []);
});

test('parseExtraction drops trivial and credential-shaped entries', () => {
  const parsed = parseExtraction(
    JSON.stringify({
      memories: [
        { content: 'hi', category: 'personal' },
        { content: 'The user says hello every morning before studying.', category: 'personal' },
        {
          content: 'The user stores their OpenAI key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
          category: 'personal',
        },
      ],
    }),
  );
  assert.equal(parsed.length, 1);
  assert.ok(parsed.every((entry) => !/sk-proj/.test(entry.content)));
});

test('parseExtraction de-duplicates and caps the batch by importance', () => {
  const memories = Array.from({ length: 9 }, (_, index) => ({
    content: `The user is preparing for JEE subject number ${index}.`,
    category: 'study',
    importance: index / 10,
  }));
  memories.push({ content: 'The user is preparing for JEE subject number 8.', category: 'study' });

  const parsed = parseExtraction(JSON.stringify({ memories }));
  assert.equal(parsed.length, MAX_CANDIDATES);
  assert.ok(parsed[0].importance >= parsed[parsed.length - 1].importance);
});

/* ---------------------------- write planning ------------------------------ */

test('an identical fact is skipped, not duplicated', () => {
  const plan = planMemoryWrites(
    [candidate('The user is a Class 11 JEE aspirant.')],
    [{ id: 'm1', content: 'The user is a Class 11 JEE aspirant.', category: 'study' }],
  );
  assert.equal(plan.adds.length, 0);
  assert.equal(plan.skipped[0].reason, 'duplicate');
});

test('a punctuation-only rewording rewrites the row instead of adding one', () => {
  const plan = planMemoryWrites(
    [candidate('The user is a Class 11 JEE aspirant.')],
    [{ id: 'm1', content: 'the user is a class 11 jee aspirant', category: 'study' }],
  );
  assert.equal(plan.adds.length, 0, 'never a second row for the same fact');
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, 'm1');
});

test('a changed preference supersedes the existing row in place', () => {
  const plan = planMemoryWrites(
    [candidate('The user prefers detailed notes over one-shot lectures.', 'preferences', 0.8)],
    [
      {
        id: 'p1',
        content: 'The user prefers one-shot lectures over detailed notes.',
        category: 'preferences',
      },
    ],
  );
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, 'p1');
  assert.equal(plan.adds.length, 0);
});

test('an ambiguous change to an important fact is not written over the old one', () => {
  const plan = planMemoryWrites(
    [candidate('The user is preparing for JEE Advanced physics.', 'study', 0.9)],
    [{ id: 's1', content: 'The user is preparing for JEE Advanced chemistry.', category: 'study' }],
  );
  assert.equal(plan.adds.length, 0);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.skipped[0].reason, 'ambiguous');
});

test('a transient detail is not worth a row', () => {
  const plan = planMemoryWrites(
    [candidate('The user felt sleepy during the afternoon.', 'personal', 0.1)],
    [],
  );
  assert.equal(plan.adds.length, 0);
  assert.equal(plan.skipped[0].reason, 'low_importance');
});

test('the account quota and the per-run cap both stop new writes', () => {
  const full = Array.from({ length: 300 }, (_, index) => ({
    id: `m${index}`,
    content: `Existing fact ${index} about the user.`,
    category: 'personal',
  }));
  const quotaPlan = planMemoryWrites([candidate('The user is building an AI project.', 'projects')], full);
  assert.equal(quotaPlan.adds.length, 0);
  assert.equal(quotaPlan.skipped[0].reason, 'quota');

  const batchPlan = planMemoryWrites(
    Array.from({ length: 4 }, (_, index) =>
      candidate(`The user is building AI project number ${index}.`, 'projects'),
    ),
    [],
    { maxAdds: 2 },
  );
  assert.equal(batchPlan.adds.length, 2);
});

/* ------------------------------ transcript -------------------------------- */

test('the transcript keeps the newest turns and marks attached images', () => {
  const messages = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: '', images: ['data:image/png;base64,AAA'] },
    { role: 'assistant', content: 'new answer' },
  ];
  const transcript = buildTranscript(messages);
  assert.ok(transcript.includes('new answer'));
  assert.ok(transcript.includes('[image attached]'));
  assert.ok(
    transcript.indexOf('old question') < transcript.indexOf('new answer'),
    'turns must stay in chronological order',
  );
});

test('the transcript is bounded', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index} `.repeat(200),
  }));
  const transcript = buildTranscript(messages, { maxChars: 500 });
  assert.ok(transcript.length <= 500);
});

/* -------------------------------- runner ---------------------------------- */

test('facts from a finished turn are persisted and counted', async () => {
  const store = fakeStore();
  const result = await runWith({
    store,
    reply: JSON.stringify({
      memories: [
        {
          content: 'The user is a Class 11 JEE aspirant.',
          category: 'study',
          importance: 0.95,
          confidence: 0.9,
        },
        { content: 'The user is building an AI project.', category: 'projects', importance: 0.8 },
      ],
    }),
  });

  assert.deepEqual({ saved: result.saved, updated: result.updated }, { saved: 2, updated: 0 });
  assert.equal(store.state.created.length, 2);
  assert.equal(store.state.created[0].source, 'auto');
  assert.equal(store.state.created[0].sourceConversationId, 'chat-1');
  assert.equal(store.state.reads, 1, 'one read should serve the whole batch');
});

test('memory OFF performs no model call and no writes', async () => {
  const store = fakeStore({ enabled: false });
  let calls = 0;
  const result = await runWith({
    store,
    complete: async () => {
      calls += 1;
      return '{"memories":[]}';
    },
  });

  assert.equal(result.reason, 'disabled');
  assert.equal(calls, 0);
  assert.equal(store.state.created.length, 0);
});

test('a provider failure is contained and reported honestly', async () => {
  const store = fakeStore();
  const result = await runWith({
    store,
    complete: async () => {
      throw new Error('provider exploded');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'extract_failed');
  assert.equal(store.state.created.length, 0);
});

test('one transient provider failure is retried', async () => {
  const store = fakeStore();
  let attempts = 0;
  const result = await runWith({
    store,
    complete: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('429');
      return '{"memories":[{"content":"The user is preparing for JEE Advanced.","category":"study","importance":0.9}]}';
    },
  });

  assert.equal(attempts, 2);
  assert.equal(result.saved, 1);
});

test('a database duplicate is skipped without failing the run', async () => {
  const store = fakeStore({ createError: Object.assign(new Error('dup'), { code: 'duplicate' }) });
  const result = await runWith({
    store,
    reply: '{"memories":[{"content":"The user is a Class 11 JEE aspirant.","category":"study","importance":0.9}]}',
  });

  assert.equal(result.ok, true);
  assert.equal(result.saved, 0);
  assert.equal(result.skipped, 1);
});

test('a write the database did not confirm is never counted as saved', async () => {
  const store = fakeStore();
  store.create = async () => null;
  const result = await runWith({
    store,
    reply:
      '{"memories":[{"content":"The user is a Class 11 JEE aspirant.","category":"study","importance":0.9}]}',
  });

  assert.equal(result.ok, true);
  assert.equal(result.saved, 0);
  assert.equal(result.skipped, 1);
});

test('without Supabase credentials nothing is attempted', async () => {
  const result = await runMemoryExtraction({
    config: { provider: 'openai' },
    token: 'token-a',
    creds: null,
    messages: [{ role: 'user', content: 'I am a JEE aspirant.' }],
    settings: enabledSettings,
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

/* --------------------------------- queue ---------------------------------- */

test('the queue collapses a repeated conversation turn', () => {
  const queue = createExtractionQueue();
  const task = () => Promise.resolve();
  assert.equal(queue.push('user:chat-1:abc', task), true);
  assert.equal(queue.push('user:chat-1:abc', task), false);
});

test('the queue never exceeds its concurrency limit', async () => {
  const queue = createExtractionQueue({ maxConcurrent: 1 });
  let running = 0;
  let peak = 0;
  const task = () =>
    new Promise((resolve) => {
      running += 1;
      peak = Math.max(peak, running);
      setTimeout(() => {
        running -= 1;
        resolve();
      }, 5);
    });

  queue.push('a', task);
  queue.push('b', task);
  queue.push('c', task);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(peak, 1);
});

test('scheduling after a reply is fire-and-forget and idempotent', async () => {
  const queue = createExtractionQueue();
  let runs = 0;
  const base = {
    config: { provider: 'openai', apiKey: 'k', model: 'm' },
    token: 'token-a',
    messages: [{ role: 'user', content: 'I am a Class 11 JEE aspirant.' }],
    reply: 'Noted.',
    conversationId: 'chat-1',
    settings: enabledSettings,
    queue,
    run: async () => {
      runs += 1;
    },
    log: () => {},
  };

  assert.equal(scheduleMemoryExtraction(base), true);
  assert.equal(scheduleMemoryExtraction(base), false, 'the same turn must not extract twice');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs, 1);
});
