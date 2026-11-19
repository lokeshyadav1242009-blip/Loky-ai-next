/**
 * LOKY MEMORY — store and route-contract tests.
 *
 * The Memory page's black screen was a rendering bug, but the page can only be
 * trustworthy if the layer underneath it behaves: a create that silently no-ops,
 * a failed edit reported as success, or an OFF switch that still sends notes to
 * the model would all surface as a broken-looking page.
 *
 * These tests run the real store code against a stubbed PostgREST endpoint, so
 * the request shape, the auth header and the error mapping are all exercised.
 * Nothing is mocked inside server/memory.js itself.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as model from '../public/memory-model.js';
import {
  MemoryError,
  createMemoryStore,
  memoryBlockForRequest,
  supabaseCreds,
} from '../server/memory.js';
import { bearerToken } from '../server/memory-routes.js';

const URL_BASE = 'https://example.supabase.co';
const ANON_KEY = 'anon-key';
const USER_TOKEN = 'user-access-token';

const CONTENT = 'I am preparing for JEE Advanced 2026';
const CATEGORY = model.MEMORY_CATEGORIES?.[0] ?? 'study';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function storeWith(handler, options = {}) {
  const { fetchImpl, calls } = stubFetch(handler);
  const store = createMemoryStore({
    url: URL_BASE,
    key: ANON_KEY,
    token: USER_TOKEN,
    fetchImpl,
    timeoutMs: 50,
    ...options,
  });
  return { store, calls };
}

/* ------------------------------- credentials ------------------------------ */

test('supabaseCreds is null unless both url and key are configured', () => {
  assert.equal(supabaseCreds({}), null);
  assert.equal(supabaseCreds({ supabase: { url: URL_BASE } }), null);
  assert.deepEqual(supabaseCreds({ supabase: { url: `${URL_BASE}/`, key: ANON_KEY } }), {
    url: URL_BASE,
    key: ANON_KEY,
  });
});

test('a store refuses to build without a session or a configuration', () => {
  assert.throws(
    () => createMemoryStore({ url: '', key: '', token: USER_TOKEN }),
    (error) => error instanceof MemoryError && error.code === 'memory_not_configured',
  );
  assert.throws(
    () => createMemoryStore({ url: URL_BASE, key: ANON_KEY, token: '' }),
    (error) => error instanceof MemoryError && error.code === 'auth_required',
  );
});

test('the user bearer token is forwarded and the anon key is never the bearer', async () => {
  const { store, calls } = storeWith(() => jsonResponse([]));
  await store.list();
  const [call] = calls;
  assert.equal(call.headers.Authorization, `Bearer ${USER_TOKEN}`);
  assert.equal(call.headers.apikey, ANON_KEY);
  assert.ok(!JSON.stringify(call.headers).includes('service_role'));
});

test('bearerToken reads only a real Bearer header', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc.def' } }), 'abc.def');
  assert.equal(bearerToken({ headers: { authorization: 'bearer  spaced ' } }), 'spaced');
  assert.equal(bearerToken({ headers: { authorization: 'Basic xyz' } }), '');
  assert.equal(bearerToken({ headers: {} }), '');
  assert.equal(bearerToken({}), '');
});

/* ---------------------------------- list ---------------------------------- */

test('list returns rows and tolerates a non-array response', async () => {
  const rows = [{ id: '1', content: CONTENT, category: CATEGORY }];
  const ok = storeWith(() => jsonResponse(rows));
  assert.deepEqual(await ok.store.list(), rows);

  const odd = storeWith(() => jsonResponse({ nope: true }));
  assert.deepEqual(await odd.store.list(), []);
});

/* ---------------------------------- add ----------------------------------- */

test('create posts the validated content and returns the saved row', async () => {
  const checked = model.validateMemory({ content: CONTENT, category: CATEGORY });
  assert.equal(checked.ok, true, 'the test fixture must be a valid memory');

  const saved = { id: 'mem-1', content: checked.value.content, category: checked.value.category };
  const { store, calls } = storeWith((call) =>
    call.method === 'POST' ? jsonResponse([saved], 201) : jsonResponse([]),
  );

  const memory = await store.create({ content: CONTENT, category: CATEGORY });
  assert.equal(memory.id, 'mem-1');

  const post = calls.find((call) => call.method === 'POST');
  assert.ok(post, 'create must POST a new row');
  assert.equal(post.body[0].content, checked.value.content);
  assert.equal(post.body[0].source, 'manual');
});

test('create rejects an empty note instead of storing it', async () => {
  const { store, calls } = storeWith(() => jsonResponse([]));
  await assert.rejects(
    () => store.create({ content: '   ' }),
    (error) => error instanceof MemoryError && error.status === 400,
  );
  assert.equal(calls.length, 0, 'an invalid note must never reach the database');
});

test('create refuses once the per-account limit is reached', async () => {
  const full = Array.from({ length: model.MAX_MEMORIES_PER_USER }, (_, index) => ({
    id: `m-${index}`,
    content: `note ${index}`,
  }));
  const { store } = storeWith(() => jsonResponse(full));
  await assert.rejects(
    () => store.create({ content: CONTENT, category: CATEGORY }),
    (error) => error instanceof MemoryError && error.code === 'too_many',
  );
});

/* ---------------------------------- edit ---------------------------------- */

test('update patches only the field that changed', async () => {
  const { store, calls } = storeWith(() =>
    jsonResponse([{ id: 'mem-1', content: 'Updated note', pinned: true }]),
  );
  const memory = await store.update('mem-1', { pinned: true });
  assert.equal(memory.pinned, true);

  const patch = calls.find((call) => call.method === 'PATCH');
  assert.ok(patch.url.includes('id=eq.mem-1'), 'the patch must target one row');
  assert.deepEqual(patch.body, { pinned: true });
});

test('update with nothing to change is a 400, not a silent success', async () => {
  const { store } = storeWith(() => jsonResponse([]));
  await assert.rejects(
    () => store.update('mem-1', {}),
    (error) => error instanceof MemoryError && error.status === 400,
  );
});

/* --------------------------------- delete --------------------------------- */

test('remove deletes the requested row and reports its id', async () => {
  const { store, calls } = storeWith(() => jsonResponse(null, 204));
  assert.deepEqual(await store.remove('mem-9'), { id: 'mem-9' });
  const del = calls.find((call) => call.method === 'DELETE');
  assert.ok(del.url.includes('id=eq.mem-9'));
});

test('remove without an id is refused before any request', async () => {
  const { store, calls } = storeWith(() => jsonResponse(null, 204));
  await assert.rejects(
    () => store.remove(''),
    (error) => error instanceof MemoryError && error.status === 400,
  );
  assert.equal(calls.length, 0);
});

/* -------------------------------- ON / OFF -------------------------------- */

test('a missing settings row means memory is on', async () => {
  const { store } = storeWith(() => jsonResponse([]));
  assert.equal(await store.getEnabled(), true);
});

test('the OFF switch is read back and written with merge-duplicates', async () => {
  const off = storeWith(() => jsonResponse([{ enabled: false }]));
  assert.equal(await off.store.getEnabled(), false);

  const write = storeWith(() => jsonResponse([{ enabled: false }]));
  assert.equal(await write.store.setEnabled(false), false);
  const post = write.calls.find((call) => call.method === 'POST');
  assert.ok(post.headers.Prefer.includes('merge-duplicates'));
  assert.deepEqual(post.body, [{ enabled: false }]);
});

/* ---------------------- cross-chat memory retrieval ----------------------- */

test('contextFor sends nothing when memory is off', async () => {
  const { store, calls } = storeWith((call) =>
    call.url.includes('memory_settings') ? jsonResponse([{ enabled: false }]) : jsonResponse([]),
  );
  const context = await store.contextFor('What am I studying?');
  assert.deepEqual(context, { enabled: false, block: '', count: 0 });
  assert.equal(
    calls.filter((call) => call.url.includes('memories?')).length,
    0,
    'an OFF switch must not read the notes at all',
  );
});

test('contextFor passes only the memories relevant to this question', async () => {
  const rows = [
    { id: '1', content: CONTENT, category: CATEGORY, pinned: false },
    { id: '2', content: 'My favourite colour is green', category: CATEGORY, pinned: false },
    { id: '3', content: 'Building LOKY AI with Lokesh Yadav', category: CATEGORY, pinned: false },
  ];
  const { store } = storeWith((call) =>
    call.url.includes('memory_settings') ? jsonResponse([{ enabled: true }]) : jsonResponse(rows),
  );

  const context = await store.contextFor('Which exam am I preparing for?');
  assert.equal(context.enabled, true);
  assert.ok(context.count >= 1, 'the relevant note must be selected');
  assert.match(context.block, /JEE Advanced/);
  assert.doesNotMatch(context.block, /favourite colour/);
});

test('a memory failure never breaks the chat request', async () => {
  assert.equal(await memoryBlockForRequest({ config: {}, token: '', question: 'hi' }), '');
  const broken = await memoryBlockForRequest({
    config: { supabase: { url: URL_BASE, key: ANON_KEY } },
    token: USER_TOKEN,
    question: 'hi',
  });
  assert.equal(broken, '');
});

/* -------------------------------- failures -------------------------------- */

test('an expired session maps to auth_required, not a generic outage', async () => {
  const { store } = storeWith(() => jsonResponse({ message: 'jwt expired' }, 401));
  await assert.rejects(
    () => store.list(),
    (error) => error instanceof MemoryError && error.status === 401 && error.code === 'auth_required',
  );
});

test('a duplicate insert maps to a 409', async () => {
  const { store } = storeWith((call) =>
    call.method === 'POST' ? jsonResponse({ message: 'duplicate key' }, 409) : jsonResponse([]),
  );
  await assert.rejects(
    () => store.create({ content: CONTENT, category: CATEGORY }),
    (error) => error instanceof MemoryError && error.status === 409,
  );
});

test('a request that never settles times out instead of hanging the page', async () => {
  const fetchImpl = (url, init = {}) =>
    new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  const store = createMemoryStore({
    url: URL_BASE,
    key: ANON_KEY,
    token: USER_TOKEN,
    fetchImpl,
    timeoutMs: 20,
  });
  await assert.rejects(
    () => store.list(),
    (error) => error instanceof MemoryError && error.code === 'memory_timeout',
  );
});
