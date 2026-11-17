/**
 * Server-side authentication for protected API routes.
 *
 * The browser gate and Supabase RLS are not the whole boundary: anyone can call
 * the API directly. This middleware makes the server itself decide, by verifying
 * the caller's Supabase access token against the Auth endpoint before the
 * request is allowed through.
 *
 * No secret leaves the server: the anon/publishable key used here is the same
 * key the browser already holds, and the service-role key is never used.
 *
 * When a deployment has no Supabase configuration there is nothing to verify a
 * token against, and the app cannot sign anyone in either, so the route stays
 * open. That is a visible configuration state, not a bypass of a configured
 * project — and it is the only case in which requireAuth does not enforce.
 */

import { config } from './config.js';

const VERIFY_TIMEOUT_MS = 8000;

/**
 * Normalise configured Supabase credentials.
 *
 * `loadSupabase()` returns `{ url, key, configured }` — the field is `key`, not
 * `anonKey`. Reading the wrong field returned null here, which silently sent a
 * fully configured deployment down the "nothing to verify against" branch and
 * let anonymous callers stream from /api/chat. Both spellings are accepted so
 * the shape cannot regress silently again.
 */
export function resolveSupabase(supabase) {
  if (!supabase) return null;
  const url = supabase.url ? String(supabase.url).replace(/\/+$/, '') : '';
  const key = String(supabase.key || supabase.anonKey || '');
  return url && key ? { url, key } : null;
}

function supabaseSettings() {
  return resolveSupabase(config && config.supabase ? config.supabase : null);
}

/** True when this deployment can verify sessions. */
export function authRequired() {
  return Boolean(supabaseSettings());
}

function bearerToken(req) {
  const header = req.headers?.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

function deny(res, status, code, message, retryable) {
  return res.status(status).json({ error: { code, message, retryable } });
}

/**
 * Record why a request was rejected so a 401 can be diagnosed from logs.
 *
 * Method, path, code and the verification status only. The bearer credential,
 * the Authorization header and the account's email are never logged, because
 * a log line is not a place for a token.
 */
function logAuthFailure(req, code, detail = '') {
  const method = req.method || '';
  const path = req.originalUrl || req.url || '';
  console.warn(`[auth] ${code} ${method} ${path}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Build the middleware. `getSupabase` and `fetchImpl` are injectable so the
 * behaviour can be tested without a live Supabase project or network.
 */
export function createRequireAuth({ getSupabase = supabaseSettings, fetchImpl } = {}) {
  return async function requireAuth(req, res, next) {
    const supabase = getSupabase();

    if (!supabase) {
      // Not configured: nothing to verify against, and the client cannot sign
      // in either. Recorded on the request so handlers can log/annotate it.
      req.authUser = null;
      req.authRequired = false;
      return next();
    }

    req.authRequired = true;

    const token = bearerToken(req);
    if (!token) {
      logAuthFailure(req, 'auth_required', 'missing bearer header');
      return deny(res, 401, 'auth_required', 'Sign in to use this feature.', false);
    }

    const doFetch = fetchImpl || globalThis.fetch;
    if (typeof doFetch !== 'function') {
      logAuthFailure(req, 'auth_unavailable', 'no fetch implementation');
      return deny(
        res,
        503,
        'auth_unavailable',
        'Could not verify your session right now. Try again.',
        true
      );
    }

    let response;
    try {
      response = await doFetch(`${supabase.url}/auth/v1/user`, {
        headers: { apikey: supabase.key, Authorization: `Bearer ${token}` },
        signal:
          typeof AbortSignal !== 'undefined' && AbortSignal.timeout
            ? AbortSignal.timeout(VERIFY_TIMEOUT_MS)
            : undefined,
      });
    } catch {
      logAuthFailure(req, 'auth_unavailable', 'verification request failed');
      return deny(
        res,
        503,
        'auth_unavailable',
        'Could not verify your session right now. Try again.',
        true
      );
    }

    if (!response || !response.ok) {
      logAuthFailure(req, 'auth_invalid', `verify status ${response ? response.status : 'none'}`);
      return deny(res, 401, 'auth_invalid', 'Your session has expired. Sign in again.', false);
    }

    let user = null;
    try {
      user = await response.json();
    } catch {
      user = null;
    }

    if (!user || !user.id) {
      logAuthFailure(req, 'auth_invalid', 'verify returned no user');
      return deny(res, 401, 'auth_invalid', 'Your session has expired. Sign in again.', false);
    }

    req.authUser = { id: String(user.id), email: user.email ? String(user.email) : '' };
    return next();
  };
}

export const requireAuth = createRequireAuth();
