import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Regression tests for the stuck "? Checking…" account chip.
 *
 * The bug: a PostgREST request that never settles left the profile check
 * pending forever, so the nav chip stayed on "Checking…" and the profile dialog
 * opened with no way back. These tests pin the two halves of the fix:
 *
 *   1. a request that never settles is abandoned after REQUEST_TIMEOUT_MS,
 *   2. the account state always reaches a terminal, visible state afterwards.
 *
 * The module under test reads `localStorage` and `fetch`, so both are stubbed
 * here. Nothing else is mocked: the real request/timeout code runs.
 */

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => void store.set(key, String(value)),
  removeItem: (key) => void store.delete(key),
};

const { getMyProfile, SupabaseError, AUTH_STORAGE_KEY, REQUEST_TIMEOUT_MS } = await import(
  '../public/supabase-client.js'
);
const { bootstrap, profileStatus } = await import('../public/direct-messages.js');

/* ------------------------------- fetch stub ------------------------------- */

const USER_ID = '11111111-2222-3333-4444-555555555555';
const USER_EMAIL = 'lokesh@example.com';
const USERNAME = 'lokesh_dev';

let mode = 'ok';
const calls = [];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  calls.push(href);

  if (href.includes('/api/supabase-config')) {
    return json({ url: 'https://project.example', anonKey: 'anon-key' });
  }
  if (href.includes('/rest/v1/profiles')) {
    if (mode === 'stall') {
      // Worst case: the socket hangs and the abort is never acknowledged.
      return new Promise(() => {});
    }
    assert.equal(options.headers?.Authorization, 'Bearer access-token');
    return json([
      { id: USER_ID, username: USERNAME, display_name: null, avatar_seed: USERNAME },
    ]);
  }
  if (href.includes('/auth/v1/')) {
    return json({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 });
  }
  throw new Error(`unexpected fetch: ${href}`);
};

store.set(
  AUTH_STORAGE_KEY,
  JSON.stringify({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000,
    user: { id: USER_ID, email: USER_EMAIL },
  }),
);

/* --------------------------------- helpers -------------------------------- */

/** Let every pending microtask settle without depending on mocked timers. */
async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A real (un-mocked) watchdog so a broken fix fails instead of hanging. */
function watchdog(promise, label = 'profile request') {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} never settled`)), 3000);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/* ---------------------------------- tests --------------------------------- */

test('the timeout budget is a few seconds, not forever', () => {
  assert.equal(typeof REQUEST_TIMEOUT_MS, 'number');
  assert.ok(REQUEST_TIMEOUT_MS >= 1000 && REQUEST_TIMEOUT_MS <= 15_000, 'sane timeout budget');
});

test('a profile request that never settles fails as a network error', async (t) => {
  mode = 'stall';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const pending = watchdog(getMyProfile().then(() => null, (error) => error));
  await flush(); // config + token lookups resolve; the profile fetch is now hanging
  assert.equal(calls.filter((href) => href.includes('/rest/v1/profiles')).length, 1);

  t.mock.timers.tick(REQUEST_TIMEOUT_MS);

  const error = await pending;
  assert.ok(error instanceof SupabaseError, 'rejects with a SupabaseError');
  assert.equal(error.code, 'network');
  assert.match(error.message, /timed out/i);
});

test('account state leaves "checking" after a timeout, then recovers on retry', async (t) => {
  mode = 'stall';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const stalled = watchdog(bootstrap().then(() => null, (error) => error));
  await flush();
  assert.equal(profileStatus().status, 'loading', 'shows the check in progress');
  assert.equal(profileStatus().inFlight, true);

  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await stalled;

  const afterTimeout = profileStatus();
  assert.equal(afterTimeout.status, 'error', 'checking must not survive a timeout');
  assert.match(afterTimeout.error, /network|timed out/i);
  assert.equal(afterTimeout.hasUser, true, 'the stored session is kept for a retry');
  assert.equal(afterTimeout.inFlight, false);

  // The user taps "Try again": the check restarts and preserves the real
  // username and email — nothing is invented or dropped.
  mode = 'ok';
  await bootstrap();

  const recovered = profileStatus();
  assert.equal(recovered.status, 'signed_in');
  assert.equal(recovered.username, USERNAME);
  assert.equal(recovered.email, USER_EMAIL);
  assert.equal(recovered.error, '');
});

test('concurrent profile checks share one request', async (t) => {
  mode = 'stall';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());

  const first = bootstrap();
  const second = bootstrap();
  assert.equal(first, second, 'the second call reuses the request in flight');

  await flush();
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await watchdog(Promise.all([first, second]));

  const profileCalls = calls.filter((href) => href.includes('/rest/v1/profiles')).length;
  assert.equal(profileCalls, 1, 'a double tap must not double the request');
});
