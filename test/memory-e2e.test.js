/**
 * LOKY MEMORY — end-to-end cross-chat behaviour.
 *
 * The real store (server/memory.js) runs against an in-memory PostgREST that
 * enforces the same boundary Supabase RLS does: a request may only see rows
 * belonging to the token's own user, and a request carrying no valid token is
 * refused. Nothing is stubbed above the HTTP layer, so a regression in column
 * selection, scoping or prompt building shows up here.
 *
 * Two schema modes are covered:
 *   extended = true   -> migration 0005 columns exist
 *   extended = false  -> only the live 0004 columns exist (today's production
 *                        state until the additive migration is applied)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../server/memory.js';
import {
  createExtractionQueue,
  runMemoryExtraction,
  scheduleMemoryExtraction,
} from '../server/memory-extract.js';

const settings = { enabled: true, timeoutMs: 2000, maxConcurrent: 2 };
const config = { provider: 'openai', apiKey: 'test-key', model: 'test-model' };
const tokens = { 'token-a': 'user-a', 'token-b': 'user-b' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function project(row, select) {
  const out = {};
  for (const column of select.split(',').map((part) => part.trim()).filter(Boolean)) {
    out[column] = row[column] ?? null;
  }
  return out;
}

/** In-memory PostgREST with user-scoped rows. */
function fakeSupabase({ extended = true } = {}) {
  const tables = { memories: [], memory_settings: [] };
  const calls = [];
  let seq = 0;

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').filter(Boolean).pop();
    const method = init.method ?? 'GET';
    const token = String(init.headers?.Authorization ?? '').replace(/^Bearer\s+/i, '');
    const userId = tokens[token];
    calls.push({ table, method, token, select: parsed.searchParams.get('select') ?? '' });

    // Exactly what PostgREST does with a missing/expired JWT.
    if (!userId) return json({ message: 'invalid claim: missing sub claim' }, 401);

    if (table === 'memory_settings') {
      const existing = tables.memory_settings.find((row) => row.user_id === userId);
      if (method === 'GET') return json(existing ? [{ enabled: existing.enabled }] : []);
      const payload = init.body ? JSON.parse(init.body) : {};
      const next = Array.isArray(payload) ? payload[0] : payload;
      const enabled = next?.enabled !== false;
      if (existing) existing.enabled = enabled;
      else tables.memory_settings.push({ user_id: userId, enabled });
      return json([{ enabled }]);
    }

    if (table !== 'memories') return json({ message: 'not found' }, 404);

    const select = parsed.searchParams.get('select') ?? '';
    const wantsExtras = /importance|confidence|source_conversation_id/.test(select);
    if (wantsExtras && !extended) {
      // The real PostgREST reply for a column the schema cache does not have.
      return new Response(
        JSON.stringify({
          code: 'PGRST204',
          message: "Could not find the 'importance' column of 'memories' in the schema cache",
        }),
        { status: 400 },
      );
    }

    const idMatch = /[?&]id=eq\.([^&]+)/.exec(parsed.search);

    if (method === 'GET') {
      const limit = Number(parsed.searchParams.get('limit') ?? 300);
      const mine = tables.memories
        .filter((row) => row.user_id === userId)
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            String(b.updated_at).localeCompare(String(a.updated_at)),
        )
        .slice(0, limit);
      return json(mine.map((row) => project(row, select)));
    }

    if (method === 'POST') {
      const payload = JSON.parse(init.body);
      const input = Array.isArray(payload) ? payload[0] : payload;
      const duplicate = tables.memories.some(
        (row) =>
          row.user_id === userId &&
          String(row.content).trim().toLowerCase() === String(input.content).trim().toLowerCase(),
      );
      if (duplicate) return json({ code: '23505', message: 'duplicate key value' }, 409);
      seq += 1;
      const stamp = new Date(Date.now() + seq).toISOString();
      const row = {
        id: `mem-${seq}`,
        user_id: userId,
        pinned: false,
        importance: null,
        confidence: null,
        source_conversation_id: null,
        created_at: stamp,
        updated_at: stamp,
        ...input,
      };
      tables.memories.push(row);
      return json([project(row, select)]);
    }

    if (method === 'PATCH') {
      const id = decodeURIComponent(idMatch?.[1] ?? '');
      const row = tables.memories.find((entry) => entry.id === id && entry.user_id === userId);
      if (!row) return json([]);
      Object.assign(row, JSON.parse(init.body), { updated_at: new Date().toISOString() });
      return json([project(row, select)]);
    }

    if (method === 'DELETE') {
      const id = decodeURIComponent(idMatch?.[1] ?? '');
      tables.memories = tables.memories.filter(
        (entry) => !(entry.id === id && entry.user_id === userId),
      );
      // A null body: undici rejects a 204 response that carries one, which is
      // exactly the reply real PostgREST sends for a DELETE.
      return new Response(null, { status: 204 });
    }

    return json({ message: 'unsupported' }, 405);
  };

  return { fetchImpl, tables, calls, creds: { url: 'https://demo.supabase.co', key: 'anon-key', fetchImpl } };
}

const jeeTurn = {
  messages: [
    {
      role: 'user',
      content:
        'I am a Class 11 JEE aspirant. I study Physics, Chemistry and Mathematics. My target exam is JEE. I prefer one-shot lectures and PYQs. I am also developing an AI project.',
    },
    { role: 'assistant', content: 'Understood — I will keep that in mind.' },
  ],
  conversationId: 'chat-1',
};

const jeeReply = JSON.stringify({
  memories: [
    { content: 'The user is a Class 11 JEE aspirant.', category: 'study', importance: 0.95, confidence: 0.9 },
    {
      content: 'The user studies Physics, Chemistry and Mathematics.',
      category: 'study',
      importance: 0.9,
      confidence: 0.9,
    },
    { content: "The user's target exam is JEE.", category: 'study', importance: 0.9, confidence: 0.9 },
    {
      content: 'The user prefers one-shot lectures and PYQ practice.',
      category: 'preferences',
      importance: 0.8,
      confidence: 0.85,
    },
    { content: 'The user is building an AI project.', category: 'projects', importance: 0.8, confidence: 0.85 },
  ],
});

function extract(
  supabase,
  { token = 'token-a', reply = jeeReply, messages = jeeTurn.messages, storeFactory } = {},
) {
  return runMemoryExtraction({
    config,
    token,
    creds: supabase.creds,
    messages,
    conversationId: jeeTurn.conversationId,
    settings,
    complete: async () => reply,
    ...(storeFactory ? { storeFactory } : {}),
    log: () => {},
  });
}

test('the brief scenario: facts learned in chat 1 are present in a brand-new chat', async () => {
  const supabase = fakeSupabase();

  const learned = await extract(supabase);
  assert.equal(learned.saved, 5, 'all five durable facts should be stored');
  assert.equal(supabase.tables.memories.length, 5);

  // New conversation, vague question, no shared vocabulary with most notes.
  const store = createMemoryStore({ ...supabase.creds, token: 'token-a' });
  const context = await store.contextFor('What should I study today?');

  assert.equal(context.enabled, true);
  assert.match(context.block, /Class 11 JEE aspirant/);
  assert.match(context.block, /Physics, Chemistry and Mathematics/);
  assert.ok(context.count <= 8, 'the prompt must stay bounded');
});

test('a second turn in the same chat does not duplicate what is already saved', async () => {
  const supabase = fakeSupabase();
  await extract(supabase);
  const again = await extract(supabase, {
    messages: [
      ...jeeTurn.messages,
      { role: 'user', content: 'Remind me what I am preparing for.' },
      { role: 'assistant', content: 'JEE.' },
    ],
  });

  assert.equal(again.saved, 0);
  assert.ok(again.skipped >= 5);
  assert.equal(supabase.tables.memories.length, 5);
});

test('memories never leak between accounts', async () => {
  const supabase = fakeSupabase();
  await extract(supabase);

  const other = createMemoryStore({ ...supabase.creds, token: 'token-b' });
  const context = await other.contextFor('What should I study today?');

  assert.equal(context.count, 0);
  assert.equal(context.block, '');

  const otherRows = await other.list();
  assert.deepEqual(otherRows, []);

  // Every call used the caller's own token; the anon key is only ever the
  // apikey header, never the identity PostgREST authorises on.
  assert.ok(supabase.calls.length > 0);
  assert.ok(supabase.calls.every((call) => call.token === 'token-a' || call.token === 'token-b'));
});

test('an invalid session is refused instead of falling back to anonymous access', async () => {
  const supabase = fakeSupabase();
  const store = createMemoryStore({ ...supabase.creds, token: 'expired-token' });

  await assert.rejects(() => store.list(), (error) => error.code === 'auth_required');
  // A store cannot be constructed without a session at all.
  assert.throws(
    () => createMemoryStore({ ...supabase.creds, token: '' }),
    (error) => error.code === 'auth_required',
  );
});

test('memory OFF stops extraction and injects nothing', async () => {
  const supabase = fakeSupabase();
  const store = createMemoryStore({ ...supabase.creds, token: 'token-a' });
  await store.setEnabled(false);

  let modelCalls = 0;
  const result = await runMemoryExtraction({
    config,
    token: 'token-a',
    creds: supabase.creds,
    messages: jeeTurn.messages,
    conversationId: 'chat-1',
    settings,
    complete: async () => {
      modelCalls += 1;
      return jeeReply;
    },
    log: () => {},
  });

  assert.equal(result.reason, 'disabled');
  assert.equal(modelCalls, 0);
  assert.equal(supabase.tables.memories.length, 0);

  const context = await store.contextFor('What should I study today?');
  assert.deepEqual({ enabled: context.enabled, block: context.block }, { enabled: false, block: '' });
});

test('a deleted memory is gone from later prompts', async () => {
  const supabase = fakeSupabase();
  await extract(supabase);
  const store = createMemoryStore({ ...supabase.creds, token: 'token-a' });

  const rows = await store.list();
  const jee = rows.find((row) => /Class 11 JEE aspirant/.test(row.content));
  await store.remove(jee.id);

  const context = await store.contextFor('What should I study today?');
  assert.ok(!context.block.includes('Class 11 JEE aspirant'));
});

test('the extended schema stores importance, confidence and the source chat', async () => {
  const supabase = fakeSupabase({ extended: true });
  const store = createMemoryStore({ ...supabase.creds, token: 'token-a' });
  assert.equal(store.supportsExtendedColumns(), true);

  const learned = await extract(supabase);
  assert.equal(learned.saved, 5);

  const jee = supabase.tables.memories.find((row) => /Class 11 JEE aspirant/.test(row.content));
  assert.equal(jee.importance, 0.95);
  assert.equal(jee.confidence, 0.9);
  assert.equal(jee.source_conversation_id, 'chat-1');
  assert.equal(jee.source, 'auto');
});

test('the live 0004 schema keeps working: missing columns fall back, nothing is lost', async () => {
  const supabase = fakeSupabase({ extended: false });
  const store = createMemoryStore({ ...supabase.creds, token: 'token-a' });
  assert.equal(store.supportsExtendedColumns(), true, 'no query has run yet');

  // Exercise the very store the app would use, so the sticky downgrade on it is
  // what gets asserted below.
  const learned = await extract(supabase, { storeFactory: () => store });
  assert.equal(learned.saved, 5, 'the fallback path must still save every fact');
  assert.equal(store.supportsExtendedColumns(), false, 'the store should remember the downgrade');
  assert.ok(
    supabase.calls.some((call) => /importance/.test(call.select)),
    'the extended select was attempted before falling back',
  );

  // Later reads must not keep retrying the rejected column set.
  const extendedAttempts = supabase.calls.filter((call) => /importance/.test(call.select)).length;
  await store.list();
  await store.list();
  assert.equal(
    supabase.calls.filter((call) => /importance/.test(call.select)).length,
    extendedAttempts,
    'the downgrade is sticky, not retried per request',
  );

  const context = await store.contextFor('What should I study today?');
  assert.match(context.block, /Class 11 JEE aspirant/);
});

test('a provider outage leaves the account untouched', async () => {
  const supabase = fakeSupabase();
  const result = await runMemoryExtraction({
    config,
    token: 'token-a',
    creds: supabase.creds,
    messages: jeeTurn.messages,
    conversationId: 'chat-1',
    settings,
    complete: async () => {
      throw new Error('502 from provider');
    },
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(supabase.tables.memories.length, 0);
});

test('the scheduled pipeline saves after a real reply without blocking it', async () => {
  const supabase = fakeSupabase();
  const queue = createExtractionQueue();
  const started = Date.now();

  const accepted = scheduleMemoryExtraction({
    config,
    token: 'token-a',
    messages: jeeTurn.messages,
    reply: 'Got it — JEE preparation noted.',
    conversationId: 'chat-1',
    settings,
    queue,
    run: (args) =>
      runMemoryExtraction({ ...args, creds: supabase.creds, complete: async () => jeeReply }),
    log: () => {},
  });

  assert.equal(accepted, true);
  assert.ok(Date.now() - started < 100, 'scheduling must return immediately');

  for (let attempt = 0; attempt < 40 && supabase.tables.memories.length < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(supabase.tables.memories.length, 5);
});
