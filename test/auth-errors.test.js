/**
 * The sign-in gate used to print "Network problem. Check your connection and
 * retry." for every failure, including a Supabase project that does not resolve.
 * These tests pin the distinction so a server-side outage stops being reported
 * as the user's connection, and so a wrong password is never called a network
 * problem.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyNetworkFailure, describeAuthError, NETWORK_MESSAGES } from '../public/auth-errors.js';

test('a DNS failure is classified as dns, not as a generic network problem', () => {
  const error = new TypeError('fetch failed');
  error.cause = { code: 'ENOTFOUND' };
  assert.equal(classifyNetworkFailure(error), 'dns');
});

test('refused and reset connections are classified as connection failures', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH']) {
    const error = new TypeError('fetch failed');
    error.cause = { code };
    assert.equal(classifyNetworkFailure(error), 'connection', code);
  }
});

test('an aborted request is classified as a timeout', () => {
  assert.equal(classifyNetworkFailure({ message: 'The request timed out.' }), 'timeout');
  assert.equal(classifyNetworkFailure({ message: 'AbortError' }), 'timeout');
});

test('a DNS outage message does not blame the user connection', () => {
  const message = describeAuthError({ code: 'network', reason: 'dns' });
  assert.equal(message, NETWORK_MESSAGES.dns);
  assert.match(message, /sign-in server/i);
  assert.match(message, /server-side/i);
  assert.doesNotMatch(message, /check your connection/i);
});

test('offline and timeout keep their own wording', () => {
  assert.match(describeAuthError({ code: 'network', reason: 'offline' }), /offline/i);
  assert.match(describeAuthError({ code: 'network', reason: 'timeout' }), /too long/i);
});

test('an unknown network reason still falls back to a retry message', () => {
  assert.equal(describeAuthError({ code: 'network' }), NETWORK_MESSAGES.unknown);
});

test('wrong credentials are reported as wrong credentials', () => {
  const message = describeAuthError({ code: 'bad_credentials', status: 400 });
  assert.match(message, /wrong email or password/i);
  assert.doesNotMatch(message, /network|connection/i);
});

test('an unconfirmed email explains the confirmation step', () => {
  assert.match(describeAuthError({ code: 'email_unconfirmed' }), /confirmation link/i);
});

test('a 5xx is reported as a server-side fault', () => {
  const message = describeAuthError({ code: 'auth', message: 'boom', status: 503 });
  assert.match(message, /server side/i);
  assert.match(message, /503/);
});

test('rate limiting surfaces the wait instead of a network error', () => {
  const message = describeAuthError({
    code: 'rate_limited',
    message: 'Too many attempts. Please wait 60s before trying again.',
  });
  assert.match(message, /60s/);
  assert.doesNotMatch(message, /network/i);
});

test('a plain message is passed through and never becomes a network error', () => {
  assert.equal(describeAuthError({ code: 'auth', message: 'Email not confirmed' }), 'Email not confirmed');
  assert.equal(describeAuthError(null), 'Something went wrong. Please try again.');
});
