import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  validateFriendRequest,
  friendButtonModel,
  groupRequests,
  pendingIncomingCount,
  statusLabel,
  describeFriendError,
  canRespondToRequest,
  canCancelRequest,
} from '../public/friends-utils.js';
import { createAdminRouter } from '../server/admin.js';

/**
 * Friend requests + admin dashboard.
 *
 * Two things are worth testing here and both are security-relevant:
 *  1. the pure rules that decide whether a request may be sent/answered, and
 *  2. the server-side authorization gate on /api/admin, which must never trust
 *     anything the browser claims about being an administrator.
 *
 * The admin router takes injectable dependencies, so the real authorization
 * logic runs against a fake Supabase instead of a live project.
 */

/* ------------------------------ friend rules ------------------------------ */

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('a friend request to yourself is rejected', () => {
  const result = validateFriendRequest({ meId: ME, targetId: ME });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cannot_request_self');
});

test('a friend request needs an authenticated sender and a recipient', () => {
  assert.equal(validateFriendRequest({ meId: null, targetId: OTHER }).code, 'not_authenticated');
  assert.equal(validateFriendRequest({ meId: ME, targetId: null }).code, 'invalid_recipient');
});

test('duplicate requests are blocked in both directions', () => {
  assert.equal(validateFriendRequest({ meId: ME, targetId: OTHER, currentStatus: 'pending_out' }).code, 'request_pending');
  assert.equal(
    validateFriendRequest({ meId: ME, targetId: OTHER, currentStatus: 'pending_in' }).code,
    'request_pending_incoming',
  );
});

test('existing friends cannot be requested again', () => {
  assert.equal(validateFriendRequest({ meId: ME, targetId: OTHER, currentStatus: 'friends' }).code, 'already_friends');
});

test('a plain new request is allowed', () => {
  const result = validateFriendRequest({ meId: ME, targetId: OTHER, currentStatus: 'none' });
  assert.deepEqual(result, { ok: true, code: null });
});

test('adding someone never happens automatically: the button starts a request', () => {
  assert.deepEqual(friendButtonModel('none'), { label: 'Add friend', action: 'request', disabled: false });
  assert.deepEqual(friendButtonModel('pending_out'), { label: 'Requested', action: 'cancel', disabled: false });
  assert.deepEqual(friendButtonModel('pending_in'), { label: 'Respond', action: 'respond', disabled: false });
  assert.deepEqual(friendButtonModel('friends'), { label: 'Message', action: 'message', disabled: false });
  assert.equal(friendButtonModel('self').disabled, true);
});

test('only the receiver can respond and only the sender can cancel', () => {
  const incoming = { status: 'pending', direction: 'incoming', other_id: OTHER };
  const outgoing = { status: 'pending', direction: 'outgoing', other_id: OTHER };

  assert.equal(canRespondToRequest(incoming, ME), true);
  assert.equal(canRespondToRequest(outgoing, ME), false);
  assert.equal(canCancelRequest(outgoing, ME), true);
  assert.equal(canCancelRequest(incoming, ME), false);

  // answered requests are final
  assert.equal(canRespondToRequest({ ...incoming, status: 'accepted' }, ME), false);
  assert.equal(canCancelRequest({ ...outgoing, status: 'rejected' }, ME), false);
});

test('requests are split by direction and never include yourself', () => {
  const rows = [
    { id: '1', status: 'pending', direction: 'incoming', other_id: OTHER },
    { id: '2', status: 'accepted', direction: 'outgoing', other_id: OTHER },
    { id: '3', status: 'pending', direction: 'incoming', other_id: ME },
  ];
  const { incoming, outgoing } = groupRequests(rows, ME);
  assert.equal(incoming.length, 1);
  assert.equal(outgoing.length, 1);
  assert.equal(groupRequests(rows, ME).pendingCount, 2);
  assert.equal(pendingIncomingCount(rows), 1);
});

test('statuses and errors are human readable', () => {
  assert.equal(statusLabel('pending'), 'Pending');
  assert.equal(statusLabel('accepted'), 'Accepted');
  assert.equal(statusLabel('rejected'), 'Rejected');
  assert.equal(statusLabel('nonsense'), 'Unknown');
  assert.match(describeFriendError('cannot_request_self'), /yourself/);
  assert.match(describeFriendError('already_friends'), /already friends/);
  assert.match(describeFriendError('not_authorized'), /not allowed/);
});

/* ------------------------------ admin API -------------------------------- */

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONV_ID = '33333333-3333-4333-8333-333333333333';
const REPORT_ID = '44444444-4444-4444-8444-444444444444';

function buildApp(overrides = {}) {
  const calls = [];
  const deps = {
    supabase: { url: '', key: '', configured: true },
    verifyUser: async (token) => {
      if (token === 'admin-token') return { id: ADMIN_ID, email: 'admin@loky.ai' };
      if (token === 'user-token') return { id: USER_ID, email: 'user@loky.ai' };
      return null;
    },
    loadProfile: async (id) =>
      id === ADMIN_ID
        ? { username: 'lokyadmin', is_admin: true, status: 'active' }
        : { username: 'normaluser', is_admin: false, status: 'active' },
    callRpc: async (name, args, token) => {
      calls.push({ name, args, token });
      return { name, args };
    },
    ...overrides,
  };

  const app = express();
  app.use('/api/admin', createAdminRouter(deps));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      ok: false,
      error: { code: err.code || 'internal_error', message: err.message },
    });
  });
  return { app, calls };
}

async function call(app, path, { method = 'GET', token, body } = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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

test('admin API refuses requests without a bearer token', async () => {
  const { app, calls } = buildApp();
  const res = await call(app, '/api/admin/stats');
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'missing_token');
  assert.equal(calls.length, 0);
});

test('admin API refuses an invalid session', async () => {
  const { app } = buildApp();
  const res = await call(app, '/api/admin/stats', { token: 'expired-token' });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'invalid_token');
});

test('a normal user cannot reach the admin API even if the body claims admin', async () => {
  const { app, calls } = buildApp();
  const res = await call(app, '/api/admin/users', { token: 'user-token' });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'not_admin');

  const spoof = await call(app, '/api/admin/stats', {
    method: 'POST',
    token: 'user-token',
    body: { isAdmin: true, is_admin: true },
  });
  assert.ok(spoof.status === 403 || spoof.status === 404);
  assert.equal(calls.length, 0);
});

test('a suspended administrator is locked out', async () => {
  const { app } = buildApp({
    loadProfile: async (id) =>
      id === ADMIN_ID
        ? { username: 'lokyadmin', is_admin: true, status: 'suspended' }
        : { username: 'normaluser', is_admin: false, status: 'active' },
  });
  const res = await call(app, '/api/admin/stats', { token: 'admin-token' });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'account_inactive');
});

test('an administrator gets stats and the caller token is forwarded', async () => {
  const { app, calls } = buildApp();
  const res = await call(app, '/api/admin/stats', { token: 'admin-token' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(calls[0].name, 'admin_dashboard_stats');
  assert.equal(calls[0].token, 'admin-token');
});

test('changing an account status requires a documented reason', async () => {
  const { app, calls } = buildApp();
  const missing = await call(app, `/api/admin/users/${USER_ID}/status`, {
    method: 'POST',
    token: 'admin-token',
    body: { status: 'suspended' },
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'reason_required');
  assert.equal(calls.length, 0);

  const ok = await call(app, `/api/admin/users/${USER_ID}/status`, {
    method: 'POST',
    token: 'admin-token',
    body: { status: 'suspended', reason: 'Repeated spam reports' },
  });
  assert.equal(ok.status, 200);
  assert.equal(calls[0].name, 'admin_set_user_status');
  assert.equal(calls[0].args.target, USER_ID);
  assert.equal(calls[0].args.new_status, 'suspended');
  assert.equal(calls[0].args.reason, 'Repeated spam reports');
});

test('reviewing a reported conversation needs a reason and is audited server-side', async () => {
  const { app, calls } = buildApp();
  const refused = await call(app, `/api/admin/conversations/${CONV_ID}`, { token: 'admin-token' });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, 'reason_required');
  assert.equal(calls.length, 0);

  const allowed = await call(
    app,
    `/api/admin/conversations/${CONV_ID}?reason=${encodeURIComponent('Report #12 harassment case')}`,
    { token: 'admin-token' },
  );
  assert.equal(allowed.status, 200);
  assert.equal(calls[0].name, 'admin_review_conversation');
  assert.equal(calls[0].args.conv, CONV_ID);
  assert.match(calls[0].args.reason, /harassment/);
});

test('malformed identifiers are rejected before touching the database', async () => {
  const { app, calls } = buildApp();
  const user = await call(app, '/api/admin/users/not-a-uuid/status', {
    method: 'POST',
    token: 'admin-token',
    body: { status: 'suspended', reason: 'because reasons' },
  });
  assert.equal(user.status, 400);
  assert.equal(user.json.error.code, 'invalid_user_id');

  const report = await call(app, `/api/admin/reports/${REPORT_ID}`, {
    method: 'POST',
    token: 'admin-token',
    body: { status: 'resolved', note: 'handled' },
  });
  assert.equal(report.status, 200);
  assert.equal(calls[0].name, 'admin_update_report');
  assert.equal(calls[0].args.report_id, REPORT_ID);
  assert.equal(calls[0].args.new_status, 'resolved');

  const badReport = await call(app, '/api/admin/reports/123', {
    method: 'POST',
    token: 'admin-token',
    body: { status: 'resolved' },
  });
  assert.equal(badReport.status, 400);
  assert.equal(badReport.json.error.code, 'invalid_report_id');
});
