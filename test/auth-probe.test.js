/**
 * The /api/health probe must never throw, never leak a secret and never make a
 * health check slow — a wrong answer here is what turns "auth is down" into
 * "the app is broken".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { probeAuthHost, resetAuthProbeCache } from '../server/auth-probe.js';

const SUPABASE = { url: 'https://example.supabase.co', key: 'publishable-key' };

test('a reachable Auth host is reported with its status', async () => {
  resetAuthProbeCache();
  const calls = [];
  const value = await probeAuthHost(SUPABASE, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { status: 200 };
    },
  });

  assert.equal(value.configured, true);
  assert.equal(value.reachable, true);
  assert.equal(value.status, 200);
  assert.equal(value.host, 'example.supabase.co');
  assert.match(calls[0].url, /\/auth\/v1\/health$/);
  assert.equal(calls[0].init.headers.apikey, 'publishable-key');
});

test('a DNS failure is reported as unreachable with its cause, not thrown', async () => {
  resetAuthProbeCache();
  const value = await probeAuthHost(SUPABASE, {
    fetchImpl: async () => {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ENOTFOUND' };
      throw error;
    },
  });

  assert.equal(value.configured, true);
  assert.equal(value.reachable, false);
  assert.equal(value.reason, 'ENOTFOUND');
});

test('an unconfigured deployment says so instead of guessing', async () => {
  resetAuthProbeCache();
  const value = await probeAuthHost({ url: '', key: '' });
  assert.deepEqual(value, { configured: false, reachable: null });
});

test('the result is cached so health checks stay fast while the host is down', async () => {
  resetAuthProbeCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { status: 200 };
  };

  await probeAuthHost(SUPABASE, { fetchImpl });
  await probeAuthHost(SUPABASE, { fetchImpl });

  assert.equal(calls, 1);
});

test('the probe carries no secret beyond the publishable key', async () => {
  resetAuthProbeCache();
  const value = await probeAuthHost(SUPABASE, {
    fetchImpl: async () => ({ status: 200 }),
  });
  const serialised = JSON.stringify(value);
  assert.doesNotMatch(serialised, /service_role/i);
  assert.doesNotMatch(serialised, /publishable-key/);
});
