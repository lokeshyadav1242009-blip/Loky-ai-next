import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { createAdminRouter } from '../server/admin.js';
import {
  parseSuperAdminIds,
  superAdminConfigured,
  isSuperAdmin,
  superAdminDecision,
  canDeleteUser,
  SUPER_ADMIN_ENV,
} from '../server/superadmin.js';
import { setMaintenance, isMaintenanceOn, maintenanceSnapshot, resetMaintenance } from '../server/maintenance.js';

/**
 * Super Admin dashboard — access control.
 *
 * These tests cover the only thing that really matters here: a normal account
 * must never reach the dashboard or its API, and being marked as an
 * administrator in the database must not be enough on its own. The router takes
 * injectable dependencies, so the real authorization code runs against fakes
 * with no network and no live Supabase project.
 */

const OWNER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ADMIN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PLAIN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/* ------------------------------ allow-list ------------------------------- */

test('the Super Admin allow-list ignores blanks, duplicates and junk', () => {
  const list = parseSuperAdminIds(` ${OWNER} , ${OWNER.toUpperCase()} ,, not-a-uuid `);
  assert.deepEqual(list, [OWNER]);
});

test('an empty allow-list is not "allow everyone"', () => {
  assert.deepEqual(parseSuperAdminIds(''), []);
  assert.equal(superAdminConfigured([]), false);
  assert.equal(isSuperAdmin(OWNER, []), false);
});

test('only the configured UUID counts as Super Admin', () => {
  const list = parseSuperAdminIds(OWNER);
  assert.equal(isSuperAdmin(OWNER, list), true);
  assert.equal(isSuperAdmin(OTHER_ADMIN, list), false);
});

/* --------------------------- the core decision ---------------------------- */

test('an unconfigured server fails closed instead of granting access', () => {
  const decision = superAdminDecision({ userId: OWNER, isAdmin: true, status: 'active', allowList: [] });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 503);
  assert.equal(decision.code, 'super_admin_not_configured');
});

test('a normal account is refused', () => {
  const decision = superAdminDecision({
    userId: PLAIN,
    isAdmin: false,
    status: 'active',
    allowList: parseSuperAdminIds(OWNER),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
  assert.equal(decision.code, 'not_admin');
});

test('an account with is_admin flipped on is still refused unless it is the owner', () => {
  const decision = superAdminDecision({
    userId: OTHER_ADMIN,
    isAdmin: true,
    status: 'active',
    allowList: parseSuperAdminIds(OWNER),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
  assert.equal(decision.code, 'not_super_admin');
});

test('a suspended owner is refused', () => {
  const decision = superAdminDecision({
    userId: OWNER,
    isAdmin: true,
    status: 'suspended',
    allowList: parseSuperAdminIds(OWNER),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'account_inactive');
});

test('the owner with an active account is allowed', () => {
  const decision = superAdminDecision({
    userId: OWNER,
    isAdmin: true,
    status: 'active',
    allowList: parseSuperAdminIds(OWNER),
  });
  assert.equal(decision.ok, true);
});

test('the allow-listed owner is granted even without the is_admin flag', () => {
  // The role is assigned server-side through the UUID allow-list, which the
  // app cannot write. A missing profiles.is_admin flag must not lock the owner
  // out of their own dashboard, and it must not let anyone else in.
  const decision = superAdminDecision({
    userId: OWNER,
    isAdmin: false,
    status: 'active',
    allowList: parseSuperAdminIds(OWNER),
  });
  assert.equal(decision.ok, true);
});

/* ----------------------------- delete guards ------------------------------ */

test('nobody can delete the Super Admin account, including the owner', () => {
  const allowList = parseSuperAdminIds(OWNER);
  assert.equal(canDeleteUser({ actorId: OWNER, targetId: OWNER, targetIsAdmin: true, allowList }).code, 'cannot_delete_self');
  assert.equal(
    canDeleteUser({ actorId: OTHER_ADMIN, targetId: OWNER, targetIsAdmin: true, allowList }).code,
    'cannot_delete_super_admin',
  );
});

test('an ordinary account can be deleted by the owner', () => {
  const result = canDeleteUser({
    actorId: OWNER,
    targetId: PLAIN,
    targetIsAdmin: false,
    allowList: parseSuperAdminIds(OWNER),
  });
  assert.equal(result.ok, true);
});

/* ------------------------------- maintenance ------------------------------ */

test('maintenance mode toggles and records who changed it', () => {
  resetMaintenance();
  assert.equal(isMaintenanceOn(), false);

  setMaintenance({ on: true, reason: 'Database upgrade', updatedBy: OWNER });
  assert.equal(isMaintenanceOn(), true);
  const snapshot = maintenanceSnapshot();
  assert.equal(snapshot.on, true);
  assert.equal(snapshot.reason, 'Database upgrade');
  assert.equal(snapshot.updatedBy, OWNER);

  setMaintenance({ on: false, reason: 'Done', updatedBy: OWNER });
  assert.equal(isMaintenanceOn(), false);
  resetMaintenance();
});

/* --------------------------- the HTTP gate itself -------------------------- */

const USERS = {
  owner: { id: OWNER, email: 'owner@example.com' },
  otheradmin: { id: OTHER_ADMIN, email: 'helper@example.com' },
  plain: { id: PLAIN, email: 'sunita@example.com' },
};

const PROFILES = {
  [OWNER]: { username: 'lokesh', is_admin: true, status: 'active' },
  [OTHER_ADMIN]: { username: 'helper', is_admin: true, status: 'active' },
  [PLAIN]: { username: 'sunita', is_admin: false, status: 'active' },
};

function fakeDeps(overrides = {}) {
  return {
    supabase: { url: 'https://example.supabase.co', key: 'anon-key', configured: true },
    // Any real upstream call would be a bug in these tests, so make it loud.
    fetchImpl: async () => {
      throw new Error('tests must not reach the network');
    },
    verifyUser: async (token) => USERS[token] || null,
    loadProfile: async (id) => PROFILES[id] || null,
    callRpc: async () => ({ totalUsers: 3 }),
    superAdminIds: parseSuperAdminIds(OWNER),
    // No service-role key: cross-user reads must refuse, never invent numbers.
    serviceRole: { key: '', configured: false },
    ...overrides,
  };
}

async function withApp(run) {
  const app = express();
  app.use('/api/admin', createAdminRouter(fakeDeps()));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetMaintenance();
  }
}

async function call(base, path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

const PROTECTED = [
  ['/session', 'GET'],
  ['/stats', 'GET'],
  ['/system', 'GET'],
  ['/analytics', 'GET'],
  ['/conversations', 'GET'],
  ['/maintenance', 'GET'],
  ['/maintenance', 'POST'],
];

test('a normal account is refused by every admin endpoint', async () => {
  await withApp(async (base) => {
    for (const [path, method] of PROTECTED) {
      const { status, payload } = await call(base, `/api/admin${path}`, {
        token: 'plain',
        method,
        body: method === 'POST' ? { on: true, reason: 'escalation attempt' } : undefined,
      });
      assert.equal(status, 403, `${method} ${path} must be forbidden`);
      assert.equal(payload.error.code, 'not_admin', `${method} ${path} code`);
    }
  });
});

test('an account with is_admin true but the wrong UUID is refused', async () => {
  await withApp(async (base) => {
    const { status, payload } = await call(base, '/api/admin/session', { token: 'otheradmin' });
    assert.equal(status, 403);
    assert.equal(payload.error.code, 'not_super_admin');
  });
});

test('no token at all is a 401, not a 403', async () => {
  await withApp(async (base) => {
    const { status, payload } = await call(base, '/api/admin/session');
    assert.equal(status, 401);
    assert.equal(payload.error.code, 'missing_token');
  });
});

test('the Super Admin reaches the dashboard session', async () => {
  await withApp(async (base) => {
    const { status, payload } = await call(base, '/api/admin/session', { token: 'owner' });
    assert.equal(status, 200);
    assert.equal(payload.data.isSuperAdmin, true);
    assert.equal(payload.data.userId, OWNER);
    // The response must never carry the service-role key.
    assert.equal(JSON.stringify(payload).includes('anon-key'), false);
  });
});

test('analytics use the RPC and never fabricate numbers without a service-role key', async () => {
  await withApp(async (base) => {
    const { status, payload } = await call(base, '/api/admin/analytics', { token: 'owner' });
    // No privileged key is required: the caller's own token reaches the
    // SECURITY DEFINER function, which returns only what it really computed.
    assert.equal(status, 200);
    assert.equal(payload.available, true);
    assert.equal(payload.data.totals.users, 3);
    // No RPC exists for the 14-day series, so it is reported as missing instead
    // of being drawn as a flat invented line.
    assert.equal(payload.data.series, null);
    assert.equal(payload.data.seriesAvailable, false);
  });
});

test('deleting an account needs a reason and refuses protected targets', async () => {
  await withApp(async (base) => {
    const noReason = await call(base, `/api/admin/users/${PLAIN}/delete`, {
      token: 'owner',
      method: 'POST',
      body: { reason: '' },
    });
    assert.equal(noReason.status, 400);

    const self = await call(base, `/api/admin/users/${OWNER}/delete`, {
      token: 'owner',
      method: 'POST',
      body: { reason: 'testing the guard' },
    });
    assert.equal(self.status, 403);
    assert.equal(self.payload.error.code, 'cannot_delete_self');

    // A valid target passes the guards and then stops at the disabled path,
    // which proves nothing is deleted while deletion is not configured.
    const valid = await call(base, `/api/admin/users/${PLAIN}/delete`, {
      token: 'owner',
      method: 'POST',
      body: { reason: 'requested by user' },
    });
    assert.equal(valid.status, 403);
    assert.equal(valid.payload.error.code, 'deletion_disabled');
  });
});

test('maintenance mode can only be switched by the Super Admin', async () => {
  await withApp(async (base) => {
    const denied = await call(base, '/api/admin/maintenance', {
      token: 'plain',
      method: 'POST',
      body: { on: true, reason: 'let me in' },
    });
    assert.equal(denied.status, 403);
    assert.equal(isMaintenanceOn(), false);

    const allowed = await call(base, '/api/admin/maintenance', {
      token: 'owner',
      method: 'POST',
      body: { on: true, reason: 'Scheduled database upgrade' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(isMaintenanceOn(), true);
  });
});

/* ---------------- every admin endpoint requires a token ---------------- */

// Full route inventory of server/admin.js. If a new endpoint is ever declared
// above the requireAdmin middleware, it answers here instead of returning 401,
// so this test fails instead of shipping an open route.
const ALL_ADMIN_ENDPOINTS = [
  ['GET', '/session'],
  ['GET', '/stats'],
  ['GET', '/users'],
  ['POST', `/users/${PLAIN}/status`],
  ['GET', '/reports'],
  ['POST', '/reports/report-1'],
  ['GET', '/conversations'],
  ['GET', '/conversations/conv-1'],
  ['GET', '/audit'],
  ['GET', '/system'],
  ['GET', '/analytics'],
  ['GET', '/maintenance'],
  ['POST', '/maintenance'],
  ['POST', `/users/${PLAIN}/delete`],
];

test('every admin endpoint refuses an anonymous caller', async () => {
  await withApp(async (base) => {
    for (const [method, path] of ALL_ADMIN_ENDPOINTS) {
      const { status, payload } = await call(base, `/api/admin${path}`, {
        method,
        body: method === 'POST' ? { reason: 'anonymous attempt' } : undefined,
      });
      assert.equal(status, 401, `${method} ${path} must require a token`);
      assert.equal(payload.error.code, 'missing_token', `${method} ${path} code`);
    }
  });
});

/* -------------- the deployed allow-list is exactly the owner ------------ */

// A public identifier, not a credential: a bare UUID cannot authenticate
// anything, so pinning it here is a safe regression guard against a second
// UUID ever being added to the deployed allow-list.
const DEPLOYED_OWNER = '69b59366-0c6d-4577-82ad-282e624f19d2';

test('the configured allow-list admits exactly one UUID: the owner', (t) => {
  const raw = process.env[SUPER_ADMIN_ENV];
  if (!raw) return t.skip(`${SUPER_ADMIN_ENV} is not set in this environment`);
  const list = parseSuperAdminIds(raw);
  assert.equal(list.length, 1, 'exactly one Super Admin may be configured');
  assert.equal(list[0], DEPLOYED_OWNER, 'the configured Super Admin must be the owner');
  assert.equal(isSuperAdmin(DEPLOYED_OWNER, list), true);
  assert.equal(isSuperAdmin(OTHER_ADMIN, list), false);
  assert.equal(isSuperAdmin(PLAIN, list), false);
});
