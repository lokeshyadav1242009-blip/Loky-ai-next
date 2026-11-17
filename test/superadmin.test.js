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

test('analytics refuse to fabricate numbers without a service-role key', async () => {
  await withApp(async (base) => {
    const { status, payload } = await call(base, '/api/admin/analytics', { token: 'owner' });
    assert.equal(status, 503);
    assert.equal(payload.error.code, 'service_role_required');
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

    // A valid target passes the guards and then stops at the missing key,
    // which proves nothing is deleted without the service role.
    const valid = await call(base, `/api/admin/users/${PLAIN}/delete`, {
      token: 'owner',
      method: 'POST',
      body: { reason: 'requested by user' },
    });
    assert.equal(valid.status, 503);
    assert.equal(valid.payload.error.code, 'service_role_required');
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
