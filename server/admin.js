import express from 'express';
import { config } from './config.js';

/**
 * LOKY AI Next — admin API.
 *
 * Server-verified RBAC. Every request must carry the caller's Supabase access
 * token. The server:
 *   1. verifies that token against Supabase Auth (GET /auth/v1/user),
 *   2. loads the caller's profile and requires is_admin === true and an active
 *      account,
 *   3. forwards the caller's own token to PostgREST, so the database functions
 *      run as that user and re-check public.is_admin() themselves.
 *
 * A frontend-only "isAdmin" flag therefore grants nothing: without a valid
 * token for an admin account every route answers 401/403.
 *
 * Only the publishable/anon key is used, and only as the `apikey` header. The
 * service-role key is never read, stored or forwarded by this module.
 */

const UPSTREAM_TIMEOUT_MS = 10000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_USER_STATUSES = new Set(['active', 'suspended', 'deactivated']);
const VALID_REPORT_STATUSES = new Set(['open', 'reviewing', 'resolved', 'dismissed']);

/** Database error message -> HTTP status. Anything unmapped becomes a 502. */
const DB_ERROR_STATUS = {
  not_authenticated: 401,
  not_authorized: 403,
  privilege_change_not_allowed: 403,
  conversation_not_reported: 403,
  cannot_change_own_status: 403,
  cannot_change_admin_status: 403,
  reason_required: 400,
  invalid_status: 400,
  invalid_decision: 400,
  invalid_recipient: 400,
  user_not_found: 404,
  report_not_found: 404,
  conversation_not_found: 404,
  request_not_found: 404,
};

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function fail(status, code, message) {
  const error = new Error(message || code);
  error.status = status;
  error.code = code;
  return error;
}

/**
 * Build the admin router. Dependencies are injectable so the authorization
 * logic can be unit tested without network access or a live Supabase project.
 */
export function createAdminRouter(deps = {}) {
  const supabase = deps.supabase || config.supabase || { url: '', key: '', configured: false };
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const verifyUser = deps.verifyUser || defaultVerifyUser(supabase, fetchImpl);
  const loadProfile = deps.loadProfile || defaultLoadProfile(supabase, fetchImpl);
  const callRpc = deps.callRpc || defaultCallRpc(supabase, fetchImpl);

  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // --- authentication + authorization -------------------------------------
  const requireAdmin = asyncHandler(async (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw fail(401, 'missing_token', 'Sign in required.');

    const user = await verifyUser(token);
    if (!user || !user.id) throw fail(401, 'invalid_token', 'Session is not valid.');

    const profile = await loadProfile(user.id, token);
    if (!profile) throw fail(403, 'no_profile', 'No profile for this account.');
    if (profile.is_admin !== true) throw fail(403, 'not_admin', 'Administrator access required.');
    if (profile.status !== 'active') throw fail(403, 'account_inactive', 'This account is not active.');

    req.admin = { id: user.id, email: user.email || '', username: profile.username || '' };
    req.accessToken = token;
    next();
  });

  // Cheap per-admin throttle so a stuck client cannot hammer the database.
  const hits = new Map();
  router.use((req, res, next) => {
    const now = Date.now();
    const key = req.admin ? req.admin.id : req.ip;
    const window = hits.get(key) || [];
    const recent = window.filter((t) => now - t < 60000);
    if (recent.length >= 120) return res.status(429).json({ ok: false, error: { code: 'rate_limited', message: 'Too many admin requests.' } });
    recent.push(now);
    hits.set(key, recent);
    next();
  });

  router.use(requireAdmin);

  // --- routes --------------------------------------------------------------
  router.get('/session', (req, res) => {
    res.json({ ok: true, data: { userId: req.admin.id, username: req.admin.username, isAdmin: true } });
  });

  router.get('/stats', asyncHandler(async (req, res) => {
    const data = await callRpc('admin_dashboard_stats', {}, req.accessToken);
    res.json({ ok: true, data });
  }));

  router.get('/users', asyncHandler(async (req, res) => {
    const term = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
    const data = await callRpc('admin_search_users', { term }, req.accessToken);
    res.json({ ok: true, data: Array.isArray(data) ? data : [] });
  }));

  router.post('/users/:id/status', asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) throw fail(400, 'invalid_user_id', 'Invalid user id.');
    const status = String(req.body?.status || '');
    const reason = String(req.body?.reason || '').trim();
    if (!VALID_USER_STATUSES.has(status)) throw fail(400, 'invalid_status', 'Unknown account status.');
    if (reason.length < 5) throw fail(400, 'reason_required', 'A short reason is required.');
    const data = await callRpc('admin_set_user_status', { target: id, new_status: status, reason: reason.slice(0, 500) }, req.accessToken);
    res.json({ ok: true, data });
  }));

  router.get('/reports', asyncHandler(async (req, res) => {
    const raw = typeof req.query.status === 'string' ? req.query.status : '';
    const statusFilter = VALID_REPORT_STATUSES.has(raw) ? raw : null;
    const data = await callRpc('admin_list_reports', { status_filter: statusFilter }, req.accessToken);
    res.json({ ok: true, data: Array.isArray(data) ? data : [] });
  }));

  router.post('/reports/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) throw fail(400, 'invalid_report_id', 'Invalid report id.');
    const status = String(req.body?.status || '');
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!VALID_REPORT_STATUSES.has(status)) throw fail(400, 'invalid_status', 'Unknown report status.');
    const data = await callRpc('admin_update_report', { report_id: id, new_status: status, note }, req.accessToken);
    res.json({ ok: true, data });
  }));

  router.get('/conversations/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) throw fail(400, 'invalid_conversation_id', 'Invalid conversation id.');
    const reason = String(req.query.reason || '').trim();
    if (reason.length < 10) throw fail(400, 'reason_required', 'A documented reason (10+ characters) is required.');
    const data = await callRpc('admin_review_conversation', { conv: id, reason: reason.slice(0, 500) }, req.accessToken);
    res.json({ ok: true, data });
  }));

  router.get('/audit', asyncHandler(async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit || '50'), 10);
    const data = await callRpc('admin_audit_logs', { max_rows: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50 }, req.accessToken);
    res.json({ ok: true, data: Array.isArray(data) ? data : [] });
  }));

  router.use((req, res) => {
    res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Unknown admin endpoint.' } });
  });

  // --- error handling ------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  router.use((error, req, res, next) => {
    const mapped = DB_ERROR_STATUS[error?.message];
    const status = error.status || mapped || 502;
    const code = error.code || error.message || 'upstream_error';
    const safe = status >= 500 ? 'The admin service is temporarily unavailable.' : String(error.message || 'Request failed.');
    if (status >= 500) console.error('[admin] upstream failure', code);
    res.status(status).json({ ok: false, error: { code, message: safe } });
  });

  return router;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// --- default Supabase-backed dependencies ----------------------------------

function request(supabase, fetchImpl, path, { method = 'GET', token, body } = {}) {
  if (!supabase.configured) {
    throw fail(503, 'supabase_not_configured', 'Messaging backend is not configured.');
  }
  return (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${supabase.url}${path}`, {
        method,
        headers: {
          apikey: supabase.key,
          Authorization: `Bearer ${token || supabase.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: response.ok, status: response.status, json };
    } finally {
      clearTimeout(timer);
    }
  })();
}

function defaultVerifyUser(supabase, fetchImpl) {
  return async (token) => {
    const { ok, json } = await request(supabase, fetchImpl, '/auth/v1/user', { token });
    if (!ok || !json || !json.id) return null;
    return { id: json.id, email: json.email || '' };
  };
}

function defaultLoadProfile(supabase, fetchImpl) {
  return async (userId, token) => {
    const query = `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,username,is_admin,status`;
    const { ok, json } = await request(supabase, fetchImpl, query, { token });
    if (!ok || !Array.isArray(json) || json.length === 0) return null;
    return json[0];
  };
}

function defaultCallRpc(supabase, fetchImpl) {
  return async (name, args, token) => {
    const { ok, json } = await request(supabase, fetchImpl, `/rest/v1/rpc/${name}`, {
      method: 'POST',
      token,
      body: args || {},
    });
    if (!ok) {
      const message = json?.message || 'upstream_error';
      throw fail(DB_ERROR_STATUS[message] || 502, message, message);
    }
    return json;
  };
}

export default createAdminRouter;
