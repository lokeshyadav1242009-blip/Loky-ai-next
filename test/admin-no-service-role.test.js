import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { createAdminRouter } from '../server/admin.js';

/**
 * The dashboard must work WITHOUT SUPABASE_SERVICE_ROLE_KEY.
 *
 * Reads go through the SECURITY DEFINER RPCs using the caller's own token, so
 * no privileged key is involved. Anything the database cannot answer comes back
 * as available:false with a reason — never as a zero or an invented number.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const PLAIN = '22222222-2222-4222-8222-222222222222';

const STATS = {
  totalUsers: 42,
  activeUsers: 40,
  suspendedUsers: 2,
  deactivatedUsers: 0,
  totalConversations: 7,
  totalMessages: 133,
  pendingFriendRequests: 1,
  openReports: 3,
  generatedAt: '2026-11-17T00:00:00.000Z',
};

function buildApp({ callRpc, serviceRole = { key: '', configured: false } } = {}) {
  const app = express();
  app.use(
    '/api/admin',
    createAdminRouter({
      supabase: { url: 'https://example.supabase.co', key: 'anon', configured: true },
      superAdminIds: [OWNER],
      serviceRole,
      verifyUser: async (token) => {
        if (token === 'owner-token') return { id: OWNER, email: 'owner@loky.ai' };
        if (token === 'user-token') return { id: PLAIN, email: 'user@loky.ai' };
        return null;
      },
      // The owner is allow-listed but has is_admin = false, exactly like the
      // production account whose flag the app cannot write.
      loadProfile: async (id) =>
        id === OWNER
          ? { username: 'lokesh', is_admin: false, status: 'active' }
          : { username: 'normaluser', is_admin: false, status: 'active' },
      callRpc:
        callRpc ||
        (async (name) => {
          if (name === 'admin_dashboard_stats') return STATS;
          if (name === 'admin_search_users') return [{ id: PLAIN, username: 'normaluser' }];
          if (name === 'admin_list_reports') return [];
          if (name === 'admin_audit_logs') return [];
          return null;
        }),
    }),
  );
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      ok: false,
      error: { code: err.code || 'internal_error', message: err.message },
    });
  });
  return app;
}

async function call(app, path, { method = 'GET', token, body } = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the overview loads real totals with no privileged key configured', async () => {
  const res = await call(buildApp(), '/api/admin/stats', { token: 'owner-token' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.available, true);
  assert.equal(res.json.data.totalUsers, 42);
  assert.equal(res.json.data.totalMessages, 133);
});

test('analytics return RPC totals and mark the missing series as unavailable', async () => {
  const res = await call(buildApp(), '/api/admin/analytics', { token: 'owner-token' });
  assert.equal(res.status, 200);
  assert.equal(res.json.available, true);
  // Real numbers, straight from the SECURITY DEFINER function.
  assert.equal(res.json.data.totals.users, 42);
  assert.equal(res.json.data.totals.conversations, 7);
  assert.equal(res.json.data.totals.openReports, 3);
  // No RPC exists for the time series: say so instead of inventing a flat line.
  assert.equal(res.json.data.series, null);
  assert.equal(res.json.data.seriesAvailable, false);
});

test('a refused database function becomes "Not configured", not a failure', async () => {
  const denied = async () => {
    const error = new Error('not_authorized');
    error.code = 'not_authorized';
    throw error;
  };
  const res = await call(buildApp({ callRpc: denied }), '/api/admin/stats', {
    token: 'owner-token',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.available, false);
  assert.equal(res.json.reason, 'db_admin_flag_missing');
  assert.equal(res.json.data, null);
  assert.match(res.json.message, /Not configured/);
});

test('a missing database function is reported as not configured', async () => {
  const missing = async () => {
    const error = new Error('Could not find the function public.admin_dashboard_stats');
    error.code = 'PGRST202';
    throw error;
  };
  const res = await call(buildApp({ callRpc: missing }), '/api/admin/stats', {
    token: 'owner-token',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.available, false);
  assert.equal(res.json.reason, 'rpc_not_configured');
});

test('the conversation list says it is not configured instead of looking empty', async () => {
  const res = await call(buildApp(), '/api/admin/conversations', { token: 'owner-token' });
  assert.equal(res.status, 200);
  assert.equal(res.json.available, false);
  assert.equal(res.json.reason, 'rpc_not_configured');
  assert.match(res.json.message, /Reports/);
});

test('account deletion stays disabled until a secure path is configured', async () => {
  const res = await call(buildApp(), `/api/admin/users/${PLAIN}/delete`, {
    token: 'owner-token',
    method: 'POST',
    body: { reason: 'requested by user' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'deletion_disabled');
});

test('the session reports deletion disabled and the dashboard key-free', async () => {
  const res = await call(buildApp(), '/api/admin/session', { token: 'owner-token' });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.isSuperAdmin, true);
  assert.equal(res.json.data.deletionEnabled, false);
  assert.equal(res.json.data.serviceRoleConfigured, false);
});

test('the system panel states that no privileged key is required', async () => {
  const res = await call(buildApp(), '/api/admin/system', { token: 'owner-token' });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.dataAccess.privilegedKeyRequired, false);
  assert.equal(res.json.data.dataAccess.mode, 'authenticated-rpc');
  assert.equal(res.json.data.dataAccess.deletionEnabled, false);
});

test('owner-only access is preserved: a normal user is still refused', async () => {
  const app = buildApp();
  const stats = await call(app, '/api/admin/stats', { token: 'user-token' });
  assert.equal(stats.status, 403);
  assert.equal(stats.json.error.code, 'not_admin');

  const analytics = await call(app, '/api/admin/analytics', { token: 'user-token' });
  assert.equal(analytics.status, 403);

  const anonymous = await call(app, '/api/admin/stats');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error.code, 'missing_token');
});

test('the delete endpoint is refused for a normal user before any key check', async () => {
  const res = await call(buildApp(), `/api/admin/users/${PLAIN}/delete`, {
    token: 'user-token',
    method: 'POST',
    body: { reason: 'let me in' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'not_admin');
});

test('the messages list is metadata-only and says so when the key is missing', async () => {
  const res = await call(buildApp(), '/api/admin/messages', { token: 'owner-token' });
  assert.equal(res.status, 200);
  assert.equal(res.json.available, false);
  assert.equal(res.json.reason, 'rpc_not_configured');
  assert.equal(res.json.data, null);
  assert.match(res.json.message, /Not configured/);
});

test('the messages list denies anonymous and non-admin callers', async () => {
  const anonymous = await call(buildApp(), '/api/admin/messages');
  assert.equal(anonymous.status, 401);

  const plain = await call(buildApp(), '/api/admin/messages', { token: 'user-token' });
  assert.equal(plain.status, 403);
  assert.equal(plain.json.error.code, 'not_admin');
});
