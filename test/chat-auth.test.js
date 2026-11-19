/**
 * Regression tests for the "I am signed in but the AI says sign in" bug.
 *
 * Root cause: streamChat() posted to /api/chat with no Authorization header,
 * while requireAuth rejects a token-less request with auth_required
 * ("Sign in to use this feature."). The browser's login state was never part
 * of the AI request, so the profile chip could show a username while every
 * answer was rejected. These assertions pin the two halves together:
 *   1. the client attaches the Supabase access token,
 *   2. a 401 refreshes once, retries, and only then ends the session,
 *   3. the server logs the reason without ever logging the credential.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequireAuth } from '../server/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const appJs = read('public/app.js');
const supabaseJs = read('public/supabase-client.js');
const authJs = read('server/auth.js');

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

/* ------------------------- token on the AI request ------------------------ */

test('the AI request sends the Supabase access token as a Bearer header', () => {
  assert.match(appJs, /import \{[^}]*getAccessToken[^}]*\} from '\.\/supabase-client\.js'/);
  assert.match(appJs, /headers\.Authorization = `Bearer \$\{token\}`/);
  // The request must be built through the helper that adds the header.
  assert.match(appJs, /chatRequest\(await currentAccessToken\(\), messages, signal, summary\)/);
});

test('an unusable stored session does not block the request itself', () => {
  // currentAccessToken() swallows a missing/expired session and returns '',
  // so an unconfigured deployment (where requireAuth passes through) still works.
  assert.match(appJs, /async function currentAccessToken\(\)[\s\S]{0,220}?return '';/);
});

/* --------------------------- 401 recovery path ---------------------------- */

test('a 401 refreshes the session once and retries before giving up', () => {
  assert.match(appJs, /response\.status === 401/);
  assert.match(appJs, /refreshAccessToken\(\)/);
  assert.match(appJs, /response = await chatRequest\(refreshed, messages, signal, summary\)/);
  assert.match(supabaseJs, /export async function refreshAccessToken\(\)/);
});

test('a session that is really gone clears local state and opens the gate', () => {
  const tail = appJs.slice(appJs.indexOf('async function streamChat'));
  assert.match(tail, /clearLocalSession\(\)/);
  assert.match(tail, /openAuthGate\(\)/);
  assert.match(tail, /code: 'auth_required'/);
  assert.match(tail, /retryable: false/);
});

test('the auth failure is titled as a sign-in problem, not a generic error', () => {
  assert.match(appJs, /case 'auth_required':\s*case 'auth_invalid':\s*case 'signed_out':\s*return 'Please sign in again';/);
});

/* ------------------------ server-side rejection + logs -------------------- */

test('a token-less call is rejected with the message the client handles', async () => {
  const middleware = createRequireAuth({
    getSupabase: () => ({ url: 'https://example.supabase.co', key: 'anon-key' }),
    fetchImpl: async () => {
      throw new Error('must not verify without a token');
    },
  });

  const res = fakeRes();
  let nextCalled = false;
  await middleware({ headers: {}, method: 'POST', originalUrl: '/api/chat' }, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'auth_required');
  assert.equal(res.body.error.message, 'Sign in to use this feature.');
});

test('a rejected token is reported as an expired session', async () => {
  const middleware = createRequireAuth({
    getSupabase: () => ({ url: 'https://example.supabase.co', key: 'anon-key' }),
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });

  const res = fakeRes();
  let nextCalled = false;
  await middleware(
    { headers: { authorization: 'Bearer stale-token' }, method: 'POST', originalUrl: '/api/chat' },
    res,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'auth_invalid');
});

test('a valid token passes through and identifies the caller', async () => {
  const middleware = createRequireAuth({
    getSupabase: () => ({ url: 'https://example.supabase.co', key: 'anon-key' }),
    fetchImpl: async (url, options) => {
      assert.match(String(url), /\/auth\/v1\/user$/);
      assert.equal(options.headers.Authorization, 'Bearer good-token');
      return { ok: true, status: 200, json: async () => ({ id: 'user-1', email: 'a@b.c' }) };
    },
  });

  const req = { headers: { authorization: 'Bearer good-token' }, method: 'POST', originalUrl: '/api/chat' };
  const res = fakeRes();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.authUser, { id: 'user-1', email: 'a@b.c' });
});

test('auth failures are logged without the credential or the email', () => {
  assert.match(authJs, /\[auth\]/);

  const logLines = authJs
    .split('\n')
    .filter((line) => /console\.(warn|error|log|info)\(/.test(line));

  assert.ok(logLines.length > 0, 'expected an auth log line');
  for (const line of logLines) {
    assert.doesNotMatch(line, /token|authorization|email/i);
  }
});
