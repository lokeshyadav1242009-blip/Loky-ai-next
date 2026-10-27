import test from 'node:test';
import assert from 'node:assert/strict';

import { AppError, errors, mapUpstreamError, extractDetail } from '../server/errors.js';

test('AppError exposes a safe JSON shape', () => {
  const error = new AppError(429, 'rate_limited', 'Slow down.', { retryAfter: 5 });
  const json = error.toJSON();

  assert.equal(json.error.code, 'rate_limited');
  assert.equal(json.error.message, 'Slow down.');
  assert.equal(json.error.retryAfter, 5);
  assert.equal(json.error.retryable, true);
  // Never leak the stack or internal fields to the client.
  assert.equal(json.stack, undefined);
  assert.equal(json.name, undefined);
});

test('retryable defaults from the status code', () => {
  assert.equal(new AppError(500, 'x', 'x').retryable, true);
  assert.equal(new AppError(429, 'x', 'x').retryable, true);
  assert.equal(new AppError(400, 'x', 'x').retryable, false);
  // An explicit value always wins over the status-derived default.
  assert.equal(new AppError(400, 'x', 'x', { retryable: true }).retryable, true);
  assert.equal(new AppError(503, 'x', 'x', { retryable: false }).retryable, false);
});

test('401 and 403 map to an auth failure that names no secret', () => {
  const error = mapUpstreamError(401, { error: { message: 'Incorrect API key provided: sk-abc' } });
  assert.equal(error.status, 502);
  assert.equal(error.code, 'upstream_auth_failed');
  assert.equal(error.retryable, false);
});

test('429 maps to a rate-limit error and preserves Retry-After', () => {
  const error = mapUpstreamError(429, { error: { message: 'Rate limit reached' }, retry_after: 12.4 }, {
    model: 'gpt-4o-mini',
  });
  assert.equal(error.status, 429);
  assert.equal(error.code, 'upstream_rate_limited');
  assert.equal(error.retryAfter, 13);
  assert.equal(error.retryable, true);
  assert.match(error.message, /gpt-4o-mini/);
});

test('429 also reads the Retry-After header when the body has no hint', () => {
  // OpenAI-compatible providers put the delay in the header, not the JSON body.
  const error = mapUpstreamError(
    429,
    { error: { message: 'Rate limit reached' } },
    { model: 'gpt-4o-mini' },
    '17',
  );
  assert.equal(error.code, 'upstream_rate_limited');
  assert.equal(error.retryAfter, 17);
});

test('429 accepts an HTTP-date Retry-After header', () => {
  const soon = new Date(Date.now() + 30_000).toUTCString();
  const error = mapUpstreamError(429, null, {}, soon);
  assert.equal(error.code, 'upstream_rate_limited');
  assert.ok(error.retryAfter >= 25 && error.retryAfter <= 31, `got ${error.retryAfter}`);
});

test('404 names the model so misconfiguration is obvious', () => {
  const error = mapUpstreamError(404, null, { model: 'ghost-model' });
  assert.equal(error.code, 'upstream_error');
  assert.match(error.message, /ghost-model/);
  assert.match(error.hint, /AI_MODEL/);
});

test('402 explains the out-of-credits case', () => {
  const error = mapUpstreamError(402, null);
  assert.equal(error.status, 502);
  assert.match(error.message, /credits|quota/i);
});

test('5xx maps to a retryable outage error', () => {
  const error = mapUpstreamError(503, { error: { message: 'overloaded' } });
  assert.equal(error.status, 503);
  assert.equal(error.code, 'upstream_unavailable');
  assert.equal(error.retryable, true);
});

test('extractDetail digs messages out of the common payload shapes', () => {
  assert.equal(extractDetail({ error: { message: 'nested' } }), 'nested');
  assert.equal(extractDetail({ message: 'flat' }), 'flat');
  assert.equal(extractDetail({ detail: 'detail field' }), 'detail field');
  assert.equal(extractDetail('{"error":{"message":"from string"}}'), 'from string');
  assert.equal(extractDetail('plain text error'), 'plain text error');
  assert.equal(extractDetail(null), '');
});

test('extractDetail clamps long and multi-line provider messages', () => {
  const detail = extractDetail({ error: { message: `${'a\n'.repeat(400)}b` } });
  assert.ok(detail.length <= 240, `expected <= 240 chars, got ${detail.length}`);
  assert.ok(!detail.includes('\n'));
});

test('every error factory produces a user-safe message', () => {
  const all = [
    errors.badRequest(),
    errors.tooLarge('big'),
    errors.rateLimited(3, 'wait'),
    errors.notConfigured('nope'),
    errors.upstreamRateLimited(2, 'wait'),
    errors.upstreamAuth(),
    errors.upstreamUnavailable(),
    errors.upstreamError(),
    errors.timeout(30),
    errors.internal(),
  ];

  for (const error of all) {
    assert.ok(error instanceof AppError);
    assert.ok(error.message.length > 0);
    assert.ok(!/sk-[a-z0-9]{10,}/i.test(error.message), 'message must not contain a key');
    assert.ok(!/stack|node_modules|\.js:\d+/.test(error.message), 'message must be user-facing');
    assert.equal(typeof error.toJSON().error.retryable, 'boolean');
  }
});
