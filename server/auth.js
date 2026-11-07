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

function supabaseSettings() {
  const supabase = config && config.supabase ? config.supabase : null;
  const url = supabase && supabase.url ? String(supabase.url).replace(/\/+$/, '') : '';
  const key = supabase && supabase.anonKey ? String(supabase.anonKey) : '';
  return url && key ? { url, key } : null;
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
      return deny(res, 401, 'auth_required', 'Sign in to use this feature.', false);
    }

    const doFetch = fetchImpl || globalThis.fetch;
    if (typeof doFetch !== 'function') {
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
      return deny(
        res,
        503,
        'auth_unavailable',
        'Could not verify your session right now. Try again.',
        true
      );
    }

    if (!response || !response.ok) {
      return deny(res, 401, 'auth_invalid', 'Your session has expired. Sign in again.', false);
    }

    let user = null;
    try {
      user = await response.json();
    } catch {
      user = null;
    }

    if (!user || !user.id) {
      return deny(res, 401, 'auth_invalid', 'Your session has expired. Sign in again.', false);
    }

    req.authUser = { id: String(user.id), email: user.email ? String(user.email) : '' };
    return next();
  };
}

export const requireAuth = createRequireAuth();
