import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Regression tests for "You are not allowed to do that." when saving a username.
 *
 * The bug: saveUsername() wrote the profile with a PostgREST upsert
 * (`on_conflict=id` + `Prefer: resolution=merge-duplicates`), which compiles to
 * `INSERT ... ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id, ...`.
 * supabase/migrations/0002_friends_admin.sql revokes table-level UPDATE on
 * public.profiles and grants column-level UPDATE on
 * (username, display_name, avatar_seed, last_seen_at, updated_at) only — so
 * writing `id` raised 42501 (permission denied) for every account that already
 * had a profile row, i.e. every real user, on every device.
 *
 * These tests pin the contract that keeps that from coming back:
 *   1. the write is a PATCH on the caller's own row, and `id` is never in the body,
 *   2. ownership is always the authenticated uid (RLS still decides the rest),
 *   3. an empty PATCH result is disambiguated instead of blindly inserting,
 *   4. permission failures explain themselves instead of one catch-all string,
 *   5. uniqueness (including case variants) still reports "already taken".
 *
 * `localStorage` and `fetch` are stubbed; the real request/error code runs.
 */

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => void store.set(key, String(value)),
  removeItem: (key) => void store.delete(key),
};

const { saveUsername, SupabaseError, AUTH_STORAGE_KEY } = await import('../public/supabase-client.js');

const USER_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_ID = '99999999-8888-7777-6666-555555555555';

/** Put a valid, unexpired session in storage for the given account. */
function signInAs(id, email = 'user@example.com') {
  store.set(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
      user: { id, email },
    })
  );
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Every PostgREST call made by the current test. */
let requests = [];
let handler = () => json([]);

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (href.includes('/api/supabase-config')) {
    return json({ url: 'https://project.example', anonKey: 'anon-key' });
  }
  const request = {
    href,
    method: (options.method || 'GET').toUpperCase(),
    body: options.body ? JSON.parse(options.body) : null,
    prefer: options.headers?.Prefer || '',
    authorization: options.headers?.Authorization || '',
  };
  requests.push(request);
  return handler(request);
};

/** Reset per-test state and sign in as USER_ID. */
function setup(fn, id = USER_ID) {
  signInAs(id);
  requests = [];
  handler = fn;
}

/* ------------------------------ the write path ----------------------------- */

test('saving a username PATCHes the caller\'s own row and never sends id', async () => {
  setup(() => json([{ id: USER_ID, username: 'lokesh_dev', display_name: null, avatar_seed: 'lokesh_dev' }]));

  const profile = await saveUsername('Lokesh_Dev');

  assert.equal(profile.username, 'lokesh_dev');
  assert.equal(requests.length, 1, 'one write, no pre-check query');

  const [write] = requests;
  assert.equal(write.method, 'PATCH', 'a PATCH touches only the named columns');
  assert.ok(write.href.includes('/rest/v1/profiles?id=eq.'), 'filtered to a single row');
  assert.ok(write.href.includes(encodeURIComponent(USER_ID)), 'filtered to the signed-in user');
  assert.equal(write.href.includes('on_conflict'), false, 'an upsert needs UPDATE on id, which 0002 withholds');
  assert.equal(/merge-duplicates/.test(write.prefer), false, 'no merge-duplicates upsert');
  assert.equal(write.prefer, 'return=representation', 'the saved row comes back so the UI can render it');

  assert.deepEqual(
    Object.keys(write.body).sort(),
    ['avatar_seed', 'display_name', 'username'],
    'only columns the database grants for UPDATE'
  );
  assert.equal(write.body.id, undefined, 'writing id raises 42501 — it must never be in the body');
  assert.equal(write.body.username, 'lokesh_dev', 'case variants are normalised before the unique index sees them');
});

test('two separate accounts each write only their own row', async () => {
  const seen = [];
  const respond = (request) => {
    const id = new URL(request.href).searchParams.get('id')?.replace('eq.', '');
    seen.push(id);
    return json([{ id, username: request.body.username, display_name: null, avatar_seed: request.body.username }]);
  };

  setup(respond, USER_ID);
  const alice = await saveUsername('alice_one');

  // Each browser session loads its own copy of the module, so each keeps its
  // own cached session. Reusing this instance would keep alice's token and
  // would not prove the second account writes its own row.
  setup(respond, OTHER_ID);
  const secondSession = await import('../public/supabase-client.js?account=other');
  const bob = await secondSession.saveUsername('bob_two');

  assert.equal(alice.username, 'alice_one');
  assert.equal(bob.username, 'bob_two');
  assert.deepEqual(seen, [USER_ID, OTHER_ID], 'each request is scoped to its own auth uid');
  assert.equal(seen.includes(OTHER_ID) && seen.indexOf(OTHER_ID) === 0, false, 'no cross-account write');
});

test('a missing profile row falls back to an INSERT that carries the caller\'s id', async () => {
  setup((request) => {
    if (request.method === 'PATCH') return json([]); // no row matched
    if (request.method === 'GET') return json([]); // and there really is no row
    if (request.method === 'POST') return json([{ id: USER_ID, username: 'fresh_user' }]);
    return json([]);
  });

  const profile = await saveUsername('fresh_user');

  assert.equal(profile.username, 'fresh_user');
  const insert = requests.find((request) => request.method === 'POST');
  assert.ok(insert, 'the insert path is used for an account with no profile row');
  assert.equal(insert.body.id, USER_ID);
  assert.equal(insert.href.includes('on_conflict'), false);
});

test('an update the database refuses reports the real reason, not "username taken"', async () => {
  setup((request) => {
    if (request.method === 'PATCH') return json([]); // RLS denial looks like "no rows"
    if (request.method === 'GET') return json([{ id: USER_ID, username: 'old_name' }]); // the row exists
    return json([]);
  });

  await assert.rejects(
    () => saveUsername('new_name'),
    (error) => {
      assert.ok(error instanceof SupabaseError);
      assert.equal(error.code, 'forbidden');
      assert.match(error.message, /refused the change/i);
      assert.doesNotMatch(error.message, /already taken/i);
      return true;
    }
  );

  assert.equal(
    requests.filter((request) => request.method === 'POST').length,
    0,
    'never blind-insert over an existing row'
  );
});

/* ------------------------------ error messages ----------------------------- */

test('a duplicate username is reported clearly, including case variants', async () => {
  setup(() =>
    json(
      {
        code: '23505',
        message: 'duplicate key value violates unique constraint "profiles_username_lower_key"',
      },
      409
    )
  );

  await assert.rejects(
    () => saveUsername('ALICE'),
    (error) => {
      assert.equal(error.code, 'username_taken');
      assert.match(error.message, /already taken/i);
      return true;
    }
  );

  assert.equal(requests[0].body.username, 'alice', 'the lower(username) index is the uniqueness authority');
});

test('a permission failure names the cause instead of one catch-all denial', async () => {
  setup(() => json({ code: '42501', message: 'permission denied for table profiles' }, 403));

  await assert.rejects(
    () => saveUsername('alice'),
    (error) => {
      assert.equal(error.code, 'forbidden');
      assert.match(error.message, /permission denied/i);
      assert.doesNotMatch(error.message, /^You are not allowed to do that\.$/);
      return true;
    }
  );
});

test('the privilege guard trigger reports the admin-only reason', async () => {
  setup(() => json({ code: '42501', message: 'privilege_change_not_allowed' }, 403));

  await assert.rejects(
    () => saveUsername('alice'),
    (error) => {
      assert.equal(error.code, 'forbidden');
      assert.match(error.message, /administrator/i);
      return true;
    }
  );
});

test('an invalid username format is reported as a format problem', async () => {
  setup(() => json({ code: '23514', message: 'violates check constraint "profiles_username_format"' }, 400));

  await assert.rejects(
    () => saveUsername('alice'),
    (error) => {
      assert.equal(error.code, 'invalid_username');
      assert.match(error.message, /not allowed/i);
      return true;
    }
  );
});

test('a signed-out visitor cannot write a profile', async () => {
  store.delete(AUTH_STORAGE_KEY);
  requests = [];
  handler = () => json([]);

  // A fresh instance has no cached session, which is what a real signed-out
  // page load looks like.
  const signedOut = await import('../public/supabase-client.js?signed-out');

  await assert.rejects(
    () => signedOut.saveUsername('alice'),
    (error) => {
      assert.equal(error.code, 'signed_out');
      return true;
    }
  );
  assert.equal(requests.length, 0, 'no request is attempted without a session');
});
