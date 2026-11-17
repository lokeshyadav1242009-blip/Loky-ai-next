import express from 'express';
import { config } from './config.js';
import {
  parseSuperAdminIds,
  superAdminDecision,
  canDeleteUser,
  SUPER_ADMIN_ENV,
} from './superadmin.js';
import { maintenanceSnapshot, setMaintenance } from './maintenance.js';

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
 * Why a read-only panel has no data. These are shown to the owner verbatim, so
 * they say what is missing instead of implying the dashboard is broken.
 */
const UNAVAILABLE_MESSAGES = {
  db_admin_flag_missing:
    'Not configured: the database admin functions require profiles.is_admin = true for this account. The server verified your Super Admin UUID, but the SQL functions re-check that flag themselves.',
  rpc_not_configured: 'Not configured: the required database function is not installed.',
  session_invalid: 'Not configured: the database rejected the session token.',
  upstream_unavailable: 'Not configured: the database did not answer.',
};

/** Database refusal -> a reason the dashboard can state honestly. */
function classifyDbFailure(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (message === 'not_authorized' || code === 'not_authorized') return 'db_admin_flag_missing';
  if (message === 'not_authenticated' || code === 'not_authenticated') return 'session_invalid';
  if (code === 'PGRST202' || /could not find the function/i.test(message)) return 'rpc_not_configured';
  return 'upstream_unavailable';
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

    // The single authorization decision shared by every admin route.
    // profiles.is_admin alone is NOT enough: the UUID must also be the
    // configured owner, so flipping that flag cannot hand out the dashboard.
    const decision = superAdminDecision({
      userId: user.id,
      isAdmin: profile.is_admin === true,
      status: profile.status,
      allowList: superAdminIds,
    });
    if (!decision.ok) {
      const denied = fail(decision.status, decision.code, decision.message);
      if (decision.hint) denied.hint = decision.hint;
      throw denied;
    }

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

  // Super Admin allow-list: the owner's Supabase Auth UUID, server-side only.
  // Read from the environment at boot so the browser can never influence it.
  // An empty list is not "allow everyone" — superAdminDecision fails closed.
  const superAdminIds = deps.superAdminIds || parseSuperAdminIds(process.env[SUPER_ADMIN_ENV]);

  // Server-only key for cross-user aggregates and account deletion. It is the
  // only credential that bypasses RLS, so it is used here and never serialised
  // into a response body.
  const serviceRole = deps.serviceRole || config.serviceRole || { key: '', configured: false };

  /**
   * Read-only RPC. A refused or missing function becomes "Not configured" for
   * that panel instead of a failed request, so one unavailable metric cannot
   * blank the whole dashboard. Writes keep raising real errors: a refused
   * action must be visible to the owner.
   */
  async function softRpc(name, args, token) {
    try {
      const data = await callRpc(name, args, token);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, reason: classifyDbFailure(error) };
    }
  }

  function unavailable(res, reason, message) {
    res.json({
      ok: true,
      available: false,
      reason,
      message: message || UNAVAILABLE_MESSAGES[reason] || UNAVAILABLE_MESSAGES.upstream_unavailable,
      data: null,
    });
  }

  router.use(requireAdmin);

  // --- routes --------------------------------------------------------------
  router.get('/session', (req, res) => {
    res.json({
      ok: true,
      data: {
        userId: req.admin.id,
        username: req.admin.username,
        isAdmin: true,
        isSuperAdmin: true,
        superAdminConfigured: true,
        // Reads go through SECURITY DEFINER RPCs, so the privileged key is
        // optional. Deletion is the one action that still needs it and stays
        // disabled until that is implemented securely.
        deletionEnabled: serviceRole.configured === true,
        serviceRoleConfigured: serviceRole.configured === true,
      },
    });
  });

  router.get('/stats', asyncHandler(async (req, res) => {
    const result = await softRpc('admin_dashboard_stats', {}, req.accessToken);
    if (!result.ok) return unavailable(res, result.reason);
    res.json({ ok: true, available: true, data: result.data });
  }));

  router.get('/users', asyncHandler(async (req, res) => {
    const term = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
    const result = await softRpc('admin_search_users', { term }, req.accessToken);
    if (!result.ok) return unavailable(res, result.reason);
    res.json({ ok: true, available: true, data: Array.isArray(result.data) ? result.data : [] });
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
    const result = await softRpc('admin_list_reports', { status_filter: statusFilter }, req.accessToken);
    if (!result.ok) return unavailable(res, result.reason);
    res.json({ ok: true, available: true, data: Array.isArray(result.data) ? result.data : [] });
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
    const result = await softRpc(
      'admin_audit_logs',
      { max_rows: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50 },
      req.accessToken,
    );
    if (!result.ok) return unavailable(res, result.reason);
    res.json({ ok: true, available: true, data: Array.isArray(result.data) ? result.data : [] });
  }));

  // --- server-only helpers -------------------------------------------------
  // These read across all users, which RLS deliberately forbids for a normal
  // session. They use the service-role key, are reachable only after
  // requireAdmin, and never return message bodies or credentials.
  function requireServiceRole() {
    if (serviceRole.configured !== true) {
      throw fail(
        503,
        'service_role_required',
        'Cross-user admin data needs SUPABASE_SERVICE_ROLE_KEY configured on the server.',
      );
    }
  }

  async function serviceFetch(path, { method = 'GET', body, prefer } = {}) {
    requireServiceRole();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${supabase.url}${path}`, {
        method,
        headers: {
          apikey: serviceRole.key,
          Authorization: `Bearer ${serviceRole.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(prefer ? { Prefer: prefer } : {}),
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
      const range = typeof response.headers?.get === 'function' ? response.headers.get('content-range') : '';
      return { ok: response.ok, status: response.status, json, range };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Exact row count via PostgREST's content-range header. */
  async function countRows(table, filter = '') {
    const { ok, range } = await serviceFetch(`/rest/v1/${table}?select=id${filter}&limit=1`, {
      prefer: 'count=exact',
    });
    if (!ok) throw fail(502, 'count_failed', `Could not count rows in ${table}.`);
    const total = Number.parseInt(String(range || '').split('/')[1], 10);
    return Number.isFinite(total) ? total : 0;
  }

  // A metric that cannot be read is reported as null (shown as "—") rather than
  // a confident 0, so a schema difference never invents a real-looking number.
  async function safeCount(table, filter) {
    try {
      return await countRows(table, filter);
    } catch {
      return null;
    }
  }

  async function probeSupabase() {
    if (!supabase.configured) return { configured: false, reachable: false, status: 0, ms: 0 };
    const started = Date.now();
    try {
      const response = await fetchImpl(`${supabase.url}/auth/v1/health`, {
        headers: { apikey: supabase.key, Authorization: `Bearer ${supabase.key}` },
        signal: AbortSignal.timeout(6000),
      });
      return {
        configured: true,
        reachable: response.ok,
        status: response.status,
        ms: Date.now() - started,
      };
    } catch {
      return { configured: true, reachable: false, status: 0, ms: Date.now() - started };
    }
  }

  /** Bucket ISO timestamps into the last `days` UTC days, oldest first. */
  function bucketByDay(rows, days) {
    const dayMs = 86400000;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const buckets = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(today.getTime() - i * dayMs);
      buckets.push({ day: date.toISOString().slice(0, 10), count: 0 });
    }
    const index = new Map(buckets.map((bucket, at) => [bucket.day, at]));
    for (const row of rows) {
      const stamp = typeof row?.created_at === 'string' ? row.created_at.slice(0, 10) : '';
      const at = index.get(stamp);
      if (at !== undefined) buckets[at].count += 1;
    }
    return buckets;
  }

  // --- dashboard routes ----------------------------------------------------
  router.get('/system', asyncHandler(async (req, res) => {
    const supabaseHealth = await probeSupabase();
    res.json({
      ok: true,
      data: {
        backend: { up: true, uptimeSeconds: Math.round(process.uptime()), node: process.version },
        supabase: supabaseHealth,
        maintenance: maintenanceSnapshot(),
        superAdmin: { configured: superAdminIds.length > 0, userId: req.admin.id },
        serviceRole: { configured: serviceRole.configured === true },
        dataAccess: {
          mode: 'authenticated-rpc',
          privilegedKeyRequired: false,
          deletionEnabled: serviceRole.configured === true,
        },
      },
    });
  }));

  router.get('/analytics', asyncHandler(async (req, res) => {
    // Totals come from the SECURITY DEFINER RPC the overview already uses, so no
    // privileged key is needed for the numbers that matter. The 14-day time
    // series has no RPC, so without the optional key it is reported as
    // unavailable rather than invented from a partial read.
    const rpc = await softRpc('admin_dashboard_stats', {}, req.accessToken);
    if (!rpc.ok) return unavailable(res, rpc.reason);

    if (serviceRole.configured !== true) {
      const s = rpc.data || {};
      return res.json({
        ok: true,
        available: true,
        data: {
          totals: {
            users: s.totalUsers ?? null,
            activeUsers: s.activeUsers ?? null,
            suspendedUsers: s.suspendedUsers ?? null,
            deactivatedUsers: s.deactivatedUsers ?? null,
            conversations: s.totalConversations ?? null,
            messages: s.totalMessages ?? null,
            pendingFriendRequests: s.pendingFriendRequests ?? null,
            openReports: s.openReports ?? null,
          },
          series: null,
          seriesAvailable: false,
          generatedAt: s.generatedAt || null,
        },
      });
    }

    requireServiceRole();
    const now = Date.now();
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const since = (ms) => encodeURIComponent(new Date(ms).toISOString());
    const weekAgo = now - 7 * 86400000;

    const [totalUsers, totalMessages, totalConversations, newUsers7d, newUsersToday, messagesToday, messages7d, dau, wau] =
      await Promise.all([
        countRows('profiles'),
        countRows('messages'),
        countRows('conversations'),
        countRows('profiles', `&created_at=gte.${since(weekAgo)}`),
        countRows('profiles', `&created_at=gte.${since(dayStart.getTime())}`),
        countRows('messages', `&created_at=gte.${since(dayStart.getTime())}`),
        countRows('messages', `&created_at=gte.${since(weekAgo)}`),
        safeCount('profiles', `&last_seen_at=gte.${since(dayStart.getTime())}`),
        safeCount('profiles', `&last_seen_at=gte.${since(weekAgo)}`),
      ]);

    const window30 = since(now - 30 * 86400000);
    const [userRows, messageRows] = await Promise.all([
      serviceFetch(`/rest/v1/profiles?select=created_at&created_at=gte.${window30}&limit=5000`),
      serviceFetch(`/rest/v1/messages?select=created_at&created_at=gte.${window30}&limit=5000`),
    ]);

    res.json({
      ok: true,
      data: {
        totals: { users: totalUsers, conversations: totalConversations, messages: totalMessages },
        activity: { dau, wau, messagesToday, messages7d },
        growth: { newUsersToday, newUsers7d },
        series: {
          users: bucketByDay(Array.isArray(userRows.json) ? userRows.json : [], 14),
          messages: bucketByDay(Array.isArray(messageRows.json) ? messageRows.json : [], 14),
        },
      },
    });
  }));

  // Conversation metadata only: ids, timestamps and counts. Message contents
  // are deliberately not selectable here. Reviewing a reported conversation
  // stays behind admin_review_conversation, which requires a written reason and
  // writes an audit entry.
  router.get('/conversations', asyncHandler(async (req, res) => {
    // Listing every conversation is a cross-user read and no RPC exists for it.
    // Without the optional server key this says so, instead of rendering an
    // empty list that would read as "there are no conversations".
    if (serviceRole.configured !== true) {
      return unavailable(
        res,
        'rpc_not_configured',
        'Not configured: listing every conversation needs a database function that is not installed. Reviewing a reported conversation still works from Reports.',
      );
    }
    requireServiceRole();
    const { ok, json } = await serviceFetch(
      '/rest/v1/conversations?select=id,created_at,conversation_members(count),messages(count)&order=created_at.desc&limit=200',
    );
    if (!ok) throw fail(502, 'conversations_failed', 'Could not load conversation metadata.');
    const rows = (Array.isArray(json) ? json : []).map((row) => ({
      id: row.id,
      createdAt: row.created_at || null,
      memberCount: row.conversation_members?.[0]?.count ?? 0,
      messageCount: row.messages?.[0]?.count ?? 0,
    }));
    res.json({ ok: true, data: rows });
  }));

  // Message metadata only (ids, conversation, timestamp). Contents stay behind
  // admin_review_conversation, which needs a written reason and is audited.
  router.get('/messages', asyncHandler(async (req, res) => {
    if (serviceRole.configured !== true) {
      return unavailable(
        res,
        'rpc_not_configured',
        'Not configured: listing every message needs the server-side database key. Reviewing a reported conversation still works from Reports.',
      );
    }
    requireServiceRole();
    const { ok, json } = await serviceFetch(
      '/rest/v1/messages?select=id,conversation_id,created_at&order=created_at.desc&limit=200',
    );
    if (!ok) throw fail(502, 'messages_failed', 'Could not load message metadata.');
    const rows = (Array.isArray(json) ? json : []).map((row) => ({
      id: row.id,
      conversationId: row.conversation_id || null,
      createdAt: row.created_at || null,
    }));
    res.json({ ok: true, data: rows });
  }));

  router.get('/maintenance', (req, res) => {
    res.json({ ok: true, data: maintenanceSnapshot() });
  });

  router.post('/maintenance', asyncHandler(async (req, res) => {
    const on = req.body?.on === true;
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    const snapshot = setMaintenance({ on, reason, updatedBy: req.admin.id });
    // Best effort: the toggle still applies if the audit write is refused. With
    // no privileged key the audit table is not writable from the app, so the
    // response says the change was not audited instead of implying it was.
    let audited = false;
    try {
      if (serviceRole.configured !== true) throw new Error('audit_needs_key');
      const { ok } = await serviceFetch('/rest/v1/admin_audit_log', {
        method: 'POST',
        prefer: 'return=minimal',
        body: [
          {
            admin_id: req.admin.id,
            action: on ? 'maintenance.enable' : 'maintenance.disable',
            target_type: 'system',
            target_id: null,
            reason: reason || 'maintenance toggle',
          },
        ],
      });
      audited = ok === true;
      if (!ok) console.error('[admin] maintenance audit write rejected');
    } catch {
      console.error('[admin] maintenance audit write failed');
    }
    res.json({ ok: true, data: { ...snapshot, audited } });
  }));

  // Deleting an account is irreversible, so it demands a written reason, refuses
  // the Super Admin and every other administrator, and is audited.
  router.post('/users/:id/delete', asyncHandler(async (req, res) => {
    const targetId = String(req.params.id || '');
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 5) {
      throw fail(400, 'reason_required', 'Give a short reason (at least 5 characters) for deleting an account.');
    }
    // Cheap guards first: a malformed id or an attempt to delete yourself is
    // refused before the service-role key is even required.
    if (!isUuid(targetId)) throw fail(400, 'invalid_target', 'Invalid account id.');
    if (targetId.toLowerCase() === String(req.admin.id).toLowerCase()) {
      throw fail(403, 'cannot_delete_self', 'You cannot delete your own account.');
    }
    // Deletion is irreversible and cannot be done safely without a privileged
    // server-side path, so it stays switched off rather than half-working.
    if (serviceRole.configured !== true) {
      throw fail(
        403,
        'deletion_disabled',
        'Account deletion is disabled until a secure server-side implementation is configured. Suspend the account instead.',
      );
    }

    const { ok, json } = await serviceFetch(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(targetId)}&select=id,username,is_admin`,
    );
    const target = ok && Array.isArray(json) ? json[0] : null;
    if (!target) throw fail(404, 'user_not_found', 'That account does not exist.');

    const verdict = canDeleteUser({
      actorId: req.admin.id,
      targetId: target.id,
      targetIsAdmin: target.is_admin === true,
      allowList: superAdminIds,
    });
    if (!verdict.ok) throw fail(403, verdict.code, verdict.message);

    const removal = await serviceFetch(`/auth/v1/admin/users/${encodeURIComponent(target.id)}`, {
      method: 'DELETE',
    });
    if (!removal.ok) {
      throw fail(502, 'delete_failed', 'The authentication service refused to delete that account.');
    }

    try {
      await serviceFetch('/rest/v1/admin_audit_log', {
        method: 'POST',
        prefer: 'return=minimal',
        body: [
          {
            admin_id: req.admin.id,
            action: 'user.delete',
            target_type: 'user',
            target_id: target.id,
            reason,
            details: { username: target.username || '' },
          },
        ],
      });
    } catch {
      console.error('[admin] delete audit write failed');
    }

    res.json({ ok: true, data: { deleted: target.id } });
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
    res.status(status).json({
      ok: false,
      error: { code, message: safe, ...(error.hint ? { hint: error.hint } : {}) },
    });
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
