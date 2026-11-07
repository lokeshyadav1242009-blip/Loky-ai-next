/**
 * Authentication boundary tests.
 *
 * Two things are asserted here:
 *   1. server/auth.js really does reject unauthenticated and invalid callers
 *      when a Supabase project is configured (the server, not the browser, is
 *      the boundary), and passes through only when no project is configured.
 *   2. the client no longer ships the demo/sample conversation seed or the
 *      "Load demo samples" entry point, and the shell is locked in the markup
 *      so protected content can never paint before a session is verified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequireAuth, resolveSupabase } from '../server/auth.js';
import { loadSupabase } from '../server/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// A publishable-shaped JWT so loadSupabase() accepts it as a client key.
const ANON_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl';
const SUPABASE = { url: 'https://example.supabase.co', key: ANON_JWT };

function fakeRes() {
  const res = { statusCode: 0, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

/* --------------------------- credential resolution --------------------------- */

test('credentials resolve from the real loadSupabase() shape', () => {
  const settings = loadSupabase({
    SUPABASE_URL: 'https://example.supabase.co/',
    SUPABASE_ANON_KEY: ANON_JWT,
  });

  assert.equal(settings.configured, true);

  // This is the regression: the field is `key`, and reading `anonKey` used to
  // make a configured deployment look unconfigured (silently open /api/chat).
  assert.deepEqual(resolveSupabase(settings), {
    url: 'https://example.supabase.co',
    key: ANON_JWT,
  });
});

test('no credentials resolve to null so the route can report the gap', () => {
  assert.equal(resolveSupabase(null), null);
  assert.equal(resolveSupabase({ url: 'https://example.supabase.co' }), null);
  assert.equal(resolveSupabase({ key: ANON_JWT }), null);
});

/* --------------------------- server-side enforcement --------------------------- */

test('no Supabase project means nothing to verify: pass through and record it', async () => {
  const mw = createRequireAuth({ getSupabase: () => null });
  const req = { headers: {} };
  const res = fakeRes();
  let passed = false;

  await mw(req, res, () => {
    passed = true;
  });

  assert.equal(passed, true);
  assert.equal(req.authRequired, false);
  assert.equal(req.authUser, null);
});

test('a configured project rejects a request with no bearer token', async () => {
  const mw = createRequireAuth({
    getSupabase: () => SUPABASE,
    fetchImpl: async () => {
      throw new Error('the token check must not run without a token');
    },
  });
  const req = { headers: {} };
  const res = fakeRes();
  let passed = false;

  await mw(req, res, () => {
    passed = true;
  });

  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'auth_required');
});

test('enforcement is active for the resolved config, not just injected objects', async () => {
  const settings = loadSupabase({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: ANON_JWT,
  });
  const mw = createRequireAuth({ getSupabase: () => resolveSupabase(settings) });
  const req = { headers: {} };
  const res = fakeRes();
  let passed = false;

  await mw(req, res, () => {
    passed = true;
  });

  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'auth_required');
});

test('an invalid token is rejected and verified against Auth, not trusted', async () => {
  const calls = [];
  const mw = createRequireAuth({
    getSupabase: () => SUPABASE,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: false, status: 401, json: async () => ({}) };
    },
  });
  const req = { headers: { authorization: 'Bearer not-a-real-token' } };
  const res = fakeRes();
  let passed = false;

  await mw(req, res, () => {
    passed = true;
  });

  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'auth_invalid');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/auth\/v1\/user$/);
  assert.equal(calls[0].init.headers.apikey, SUPABASE.key);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer not-a-real-token');
});

test('a valid token passes through with the verified user id', async () => {
  const mw = createRequireAuth({
    getSupabase: () => SUPABASE,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'user-123', email: 'a@example.com' }),
    }),
  });
  const req = { headers: { authorization: 'Bearer good-token' } };
  const res = fakeRes();
  let passed = false;

  await mw(req, res, () => {
    passed = true;
  });

  assert.equal(passed, true);
  assert.equal(req.authRequired, true);
  assert.equal(req.authUser.id, 'user-123');
});

test('an auth response without a user id is treated as invalid', async () => {
  const mw = createRequireAuth({
    getSupabase: () => SUPABASE,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  const req = { headers: { authorization: 'Bearer good-token' } };
  const res = fakeRes();
  let passed = false;

  await mw(req, res, () => {
    passed = true;
  });

  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
});

test('an unreachable auth service is a retryable 503, never a silent allow', async () => {
  const mw = createRequireAuth({
    getSupabase: () => SUPABASE,
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  const req = { headers: { authorization: 'Bearer good-token' } };
  const res = fakeRes();
  let passed = false;

  await mw(req, res, () => {
    passed = true;
  });

  assert.equal(passed, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.retryable, true);
});

test('the chat route is wired to the auth middleware', () => {
  const server = read('server/index.js');
  assert.match(server, /app\.post\('\/api\/chat',\s*rateLimitMiddleware\(limiter\),\s*requireAuth/);
});

/* ------------------------------ client boundary ------------------------------ */

test('the shell is locked in the markup so it cannot paint before verification', () => {
  const html = read('public/index.html');
  assert.match(html, /<body class="auth-locked">/);
});

test('the demo conversation seed and its entry point are gone', () => {
  const html = read('public/index.html');
  const messages = read('public/messages.js');

  assert.doesNotMatch(html, /msgEmptySamples/);
  assert.doesNotMatch(html, /Load demo samples/i);

  // No seeding call remains, and stored demo threads are filtered on load.
  assert.doesNotMatch(messages, /sampleThreads\(\)/);
  assert.match(messages, /startsWith\('demo_'\)/);
});

test('sections cannot be opened while the gate is locked', () => {
  const app = read('public/app.js');
  assert.match(app, /if \(!isUnlocked\(\)\) return;/);
});

test('the gate exposes its unlock state and a session-check deadline', () => {
  const gate = read('public/auth-gate.js');
  assert.match(gate, /export function isUnlocked\(\)/);
  assert.match(gate, /SESSION_CHECK_DEADLINE_MS/);
  assert.match(gate, /Promise\.race\(\[checkSession\(\), deadline\]\)/);
});

test('the profile check never waits behind redirect parsing', () => {
  const dm = read('public/direct-messages.js');
  // handleAuthRedirect must be started but not awaited before bootstrap().
  assert.match(dm, /const redirect = handleAuthRedirect\(\)\.catch/);
  assert.match(dm, /await bootstrap\(\);/);
});
