/**
 * A deleted Supabase project and a temporary outage both surface as "fetch
 * failed" in the browser, but they need opposite advice: one is worth retrying,
 * the other needs the owner to restore the project. These tests pin that
 * distinction, and pin that the health payload never carries key material.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyAuthCause,
  probeAuthHost,
  projectRefFrom,
  resetAuthProbeCache,
} from '../server/auth-probe.js';
import {
  NETWORK_MESSAGES,
  describeAuthError,
  refineNetworkReason,
} from '../public/auth-errors.js';

const SUPABASE = { url: 'https://example.supabase.co', key: 'publishable-key' };

const dnsFailure = () => {
  const error = new TypeError('fetch failed');
  error.cause = { code: 'ENOTFOUND' };
  return error;
};

test('a host that does not resolve is a missing project, not a slow network', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ERR_NAME_NOT_RESOLVED', 'getaddrinfo ENOTFOUND']) {
    assert.equal(classifyAuthCause(code), 'project_missing', code);
  }
});

test('timeouts and refused connections keep their own cause', () => {
  assert.equal(classifyAuthCause('TimeoutError'), 'timeout');
  assert.equal(classifyAuthCause('The operation was aborted due to timeout'), 'timeout');
  assert.equal(classifyAuthCause('ECONNREFUSED'), 'refused');
  assert.equal(classifyAuthCause('ECONNRESET'), 'refused');
  assert.equal(classifyAuthCause('something else'), 'unreachable');
});

test('the project ref comes from the publishable key claims when present', () => {
  const claims = Buffer.from(JSON.stringify({ ref: 'refkey123', role: 'anon' })).toString(
    'base64url'
  );
  const ref = projectRefFrom({ url: 'https://host.supabase.co', key: `h.${claims}.s` });
  assert.equal(ref, 'refkey123');
});

test('the project ref falls back to the host when the key is not a JWT', () => {
  assert.equal(projectRefFrom(SUPABASE), 'example');
  assert.equal(projectRefFrom(null), '');
});

test('a missing project is reported with a cause, its ref and actionable advice', async () => {
  resetAuthProbeCache();
  const value = await probeAuthHost(
    { url: 'https://abc123.supabase.co', key: 'publishable-key' },
    {
      fetchImpl: async () => {
        throw dnsFailure();
      },
    }
  );

  assert.equal(value.reachable, false);
  assert.equal(value.reason, 'ENOTFOUND');
  assert.equal(value.cause, 'project_missing');
  assert.equal(value.projectRef, 'abc123');
  assert.match(value.hint, /deleted or replaced/i);
  assert.match(value.hint, /SUPABASE_URL/);
  // The advice must not promise that retrying will work.
  assert.match(value.hint, /cannot succeed until/i);
});

test('a timeout is not misreported as a deleted project', async () => {
  resetAuthProbeCache();
  const value = await probeAuthHost(SUPABASE, {
    fetchImpl: async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    },
  });

  assert.equal(value.reachable, false);
  assert.equal(value.cause, 'timeout');
  assert.equal(value.hint, undefined);
});

test('the health payload still carries no key material', async () => {
  resetAuthProbeCache();
  const value = await probeAuthHost(SUPABASE, {
    fetchImpl: async () => {
      throw dnsFailure();
    },
  });

  const serialised = JSON.stringify(value);
  assert.doesNotMatch(serialised, /publishable-key/);
  assert.doesNotMatch(serialised, /service_role/i);
  assert.doesNotMatch(serialised, /eyJ/);
});

test('server evidence upgrades the browser guess to a missing project', () => {
  const health = {
    authVerification: { reachable: false, reason: 'ENOTFOUND', cause: 'project_missing' },
  };
  assert.equal(refineNetworkReason('unknown', health), 'project_missing');
  assert.equal(refineNetworkReason('offline', health), 'project_missing');
});

test('a bare DNS failure without a server cause still reads as dns', () => {
  const health = { authVerification: { reachable: false, reason: 'ENOTFOUND' } };
  assert.equal(refineNetworkReason('unknown', health), 'dns');
});

test('a missing project tells the user it needs the owner, not another retry', () => {
  const message = describeAuthError({ code: 'network', reason: 'project_missing' });
  assert.equal(message, NETWORK_MESSAGES.project_missing);
  assert.match(message, /owner/i);
  assert.match(message, /restore/i);
  assert.doesNotMatch(message, /check your connection/i);
});
