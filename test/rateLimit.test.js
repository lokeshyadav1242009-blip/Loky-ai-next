import test from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter, clientKey } from '../server/rateLimit.js';

test('allows requests up to the limit, then blocks', () => {
  const limiter = createRateLimiter({ max: 3, windowMs: 60000 });
  try {
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, true);

    const third = limiter.check('a');
    assert.equal(third.allowed, true);
    assert.equal(third.remaining, 0);

    const fourth = limiter.check('a');
    assert.equal(fourth.allowed, false);
    assert.equal(fourth.remaining, 0);
    assert.ok(fourth.retryAfter >= 1);
  } finally {
    limiter.stop();
  }
});

test('tracks keys independently', () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60000 });
  try {
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, false);
    assert.equal(limiter.check('b').allowed, true);
    assert.equal(limiter.size, 2);
  } finally {
    limiter.stop();
  }
});

test('the window slides so capacity returns over time', () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => clock });
  try {
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, false);

    clock += 1001; // first two hits fall out of the window
    const afterWindow = limiter.check('a');
    assert.equal(afterWindow.allowed, true);
    assert.equal(afterWindow.remaining, 1);
  } finally {
    limiter.stop();
  }
});

test('retryAfter shrinks as the oldest hit ages out', () => {
  let clock = 500_000;
  const limiter = createRateLimiter({ max: 1, windowMs: 10000, now: () => clock });
  try {
    limiter.check('a');
    const blocked = limiter.check('a');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfter, 10);

    clock += 8000;
    const later = limiter.check('a');
    assert.equal(later.allowed, false);
    assert.equal(later.retryAfter, 2);
  } finally {
    limiter.stop();
  }
});

test('reset clears all tracked keys', () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60000 });
  try {
    limiter.check('a');
    limiter.check('a');
    assert.equal(limiter.check('a').allowed, false);
    limiter.reset();
    assert.equal(limiter.size, 0);
    assert.equal(limiter.check('a').allowed, true);
  } finally {
    limiter.stop();
  }
});

test('clientKey prefers the first X-Forwarded-For hop', () => {
  assert.equal(
    clientKey({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, ip: '10.0.0.1' }),
    '203.0.113.7',
  );
  assert.equal(clientKey({ headers: {}, ip: '198.51.100.2' }), '198.51.100.2');
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
  assert.equal(clientKey({ headers: {} }), 'unknown');
});
