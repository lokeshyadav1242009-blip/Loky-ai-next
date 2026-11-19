/**
 * LOKY AI Next — Supabase data layer for the Mini Chat username system.
 *
 * Talks to Supabase Auth (GoTrue) and PostgREST over plain `fetch`, so the app
 * keeps its four existing dependencies and does not need to vendor
 * @supabase/supabase-js. Every request carries only the publishable (anon) key
 * that the server hands out at /api/supabase-config. The service-role key is
 * server-side only and is never referenced here.
 *
 * Authorization is NOT decided in this file. Row Level Security in
 * supabase/migrations/0001_username_system.sql is the enforcement point; this
 * module just surfaces what the database allows.
 */

import { normalizeUsername, suggestUsername } from './username-utils.js';
import { buildOAuthUrl } from './auth-utils.js';

/** Session storage is deliberately separate from both other storage keys. */
export const AUTH_STORAGE_KEY = 'loky.ai.next.auth.v1';

let cachedConfig = null;
let cachedSession = null;
let configPromise = null;

/* --------------------------------- errors --------------------------------- */

import { NETWORK_MESSAGES, classifyNetworkFailure, refineNetworkReason } from './auth-errors.js';

export class SupabaseError extends Error {
  constructor(code, message, status = 0, retryAfter = 0, reason = '') {
    super(message);
    this.name = 'SupabaseError';
    this.code = code;
    this.status = status;
    /** Seconds the caller should wait before trying again (0 = unknown). */
    this.retryAfter = retryAfter;
    /**
     * Why a `network` failure happened: 'dns' | 'connection' | 'offline' |
     * 'timeout'. Lets the UI distinguish a server-side outage from the user
     * actually being offline instead of printing one catch-all message.
     */
    this.reason = reason;
  }
}

/**
 * Ask our own server whether it can reach Supabase.
 *
 * Best effort and bounded: a browser cannot see why a fetch failed, so the
 * server's probe is the only real evidence. Never throws.
 */
async function readAuthHealth() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch('/api/health', {
        signal: controller.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return null;
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/* -------------------------------- timeouts -------------------------------- */

/**
 * No network request may hang the UI forever. A pending PostgREST request is
 * what used to leave the account chip stuck on "Checking…", so every call now
 * gives up after this budget and surfaces an ordinary network error the UI can
 * present (and the user can retry manually).
 */
export const REQUEST_TIMEOUT_MS = 8000;

/**
 * `fetch` with a hard deadline.
 *
 * The abort signal is what a real browser honours, and the race is what
 * guarantees settlement even if a request never reacts to the abort. The timer
 * is always cleared, so a settled request leaves nothing behind.
 */
async function fetchWithTimeout(url, options = {}, ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer = null;

  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SupabaseError('network', NETWORK_MESSAGES.timeout, 0, 0, 'timeout'));
    }, ms);
  });

  try {
    return await Promise.race([
      fetch(url, { ...options, signal: controller.signal }),
      timedOut,
    ]);
  } catch (error) {
    if (error instanceof SupabaseError) throw error;
    // Keep the cause. A DNS/connection failure means the auth server is
    // unreachable, which the UI must not report as the user being offline.
    let reason = classifyNetworkFailure(error);
    // Browsers hide the cause behind "Failed to fetch"; ask our own server
    // whether *it* can reach Supabase before blaming the user's connection.
    if (reason === 'unknown' || reason === 'offline') {
      reason = refineNetworkReason(reason, await readAuthHealth());
    }
    throw new SupabaseError('network', NETWORK_MESSAGES[reason] || NETWORK_MESSAGES.unknown, 0, 0, reason);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * How long Auth asked us to wait. GoTrue sends `Retry-After` on 429; when it is
 * absent we fall back to a conservative default so the UI can still lock the
 * buttons instead of letting the user hammer the endpoint.
 */
function retryAfterSeconds(response, fallback) {
  const raw = response.headers?.get?.('retry-after');
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(Math.ceil(parsed), 3600);
  return fallback;
}

/* -------------------------------- bootstrap ------------------------------- */

/**
 * Read (and memoise) the public Supabase config from our own server.
 * Throws code 'not_configured' when the deployment lacks SUPABASE_URL /
 * SUPABASE_ANON_KEY, which is exactly the 503 the API returns.
 */
export async function loadConfig() {
  if (cachedConfig) return cachedConfig;
  if (configPromise) return configPromise;

  configPromise = (async () => {
    let response;
    try {
      response = await fetchWithTimeout('/api/supabase-config', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
    } catch (error) {
      configPromise = null;
      throw error instanceof SupabaseError
        ? error
        : new SupabaseError('network', 'Could not reach the server.');
    }

    if (response.status === 503) {
      configPromise = null;
      throw new SupabaseError('not_configured', 'Mini Chat is not configured on this server yet.', 503);
    }
    if (!response.ok) {
      configPromise = null;
      throw new SupabaseError('network', 'Mini Chat configuration could not be loaded.', response.status);
    }

    const data = await response.json();
    if (!data || !data.url || !data.anonKey) {
      configPromise = null;
      throw new SupabaseError('not_configured', 'Mini Chat is not configured on this server yet.', 503);
    }

    cachedConfig = { url: String(data.url).replace(/\/+$/, ''), anonKey: data.anonKey };
    return cachedConfig;
  })();

  return configPromise;
}

/* --------------------------------- session -------------------------------- */

function readStoredSession() {
  if (cachedSession) return cachedSession;
  try {
    const raw = globalThis.localStorage?.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.accessToken !== 'string' || !parsed.user?.id) return null;
    cachedSession = parsed;
    return cachedSession;
  } catch {
    return null;
  }
}

function writeSession(session) {
  cachedSession = session;
  try {
    if (session) globalThis.localStorage?.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    else globalThis.localStorage?.removeItem(AUTH_STORAGE_KEY);
  } catch {
    /* private mode / quota: the in-memory session still works for this tab */
  }
}

function sessionFromTokenResponse(data) {
  if (!data?.access_token || !data?.user?.id) {
    throw new SupabaseError('auth', 'The sign-in response was incomplete.');
  }
  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresAt: Date.now() + expiresIn * 1000,
    user: { id: data.user.id, email: data.user.email || '' },
  };
}

/** Read a response body without ever throwing on an empty/invalid payload. */
async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Turn the tokens from a confirmation link into a stored session.
 *
 * The implicit-flow redirect only carries `access_token` / `refresh_token`;
 * there is no user object in the URL, so the user is fetched from
 * `/auth/v1/user` before anything is written to storage. That is the step that
 * used to be missing: without it a confirmed user looked signed out.
 *
 * Throws `expired_link` when Auth rejects the token (used, expired, revoked)
 * and `network` when the request never completed.
 */
export async function establishSession({ accessToken, refreshToken = '', expiresIn = 3600 } = {}) {
  if (!accessToken) {
    throw new SupabaseError('invalid_link', 'That link is missing its sign-in token.');
  }

  const config = await loadConfig();
  let response;
  try {
    response = await fetchWithTimeout(`${config.url}/auth/v1/user`, {
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
  } catch (error) {
    if (error instanceof SupabaseError) throw error;
    throw new SupabaseError('network', 'Could not reach the server. Check your connection and open the link again.');
  }

  if (!response.ok) {
    throw new SupabaseError(
      'expired_link',
      'That confirmation link has expired or was already used.',
      response.status
    );
  }

  const user = await readJson(response);
  if (!user?.id) {
    throw new SupabaseError('invalid_link', 'The server did not confirm that link. Please sign in.');
  }

  const seconds = Number(expiresIn) > 0 ? Number(expiresIn) : 3600;
  const session = {
    accessToken,
    refreshToken: refreshToken || '',
    expiresAt: Date.now() + seconds * 1000,
    user: { id: user.id, email: user.email || '' },
  };
  writeSession(session);
  return session;
}

/**
 * Complete a confirmation link that carries `token_hash` + `type`.
 * Auth answers with a normal token response, so the existing session shape is
 * reused instead of inventing a second one.
 */
export async function verifyTokenHash(tokenHash, type = 'signup') {
  if (!tokenHash) throw new SupabaseError('invalid_link', 'That link is missing its token.');

  const config = await loadConfig();
  let response;
  try {
    response = await fetchWithTimeout(`${config.url}/auth/v1/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
      },
      body: JSON.stringify({ type, token_hash: tokenHash }),
    });
  } catch (error) {
    if (error instanceof SupabaseError) throw error;
    throw new SupabaseError('network', 'Could not reach the server. Check your connection and open the link again.');
  }

  const data = await readJson(response);
  if (!response.ok) {
    throw new SupabaseError(
      'expired_link',
      'That confirmation link has expired or was already used.',
      response.status
    );
  }

  const session = sessionFromTokenResponse(data);
  writeSession(session);
  return session;
}

/** Current signed-in user, or null. Never throws. */
export function currentUser() {
  return readStoredSession()?.user || null;
}

export function isSignedIn() {
  return Boolean(readStoredSession()?.accessToken);
}

async function authRequest(path, body) {
  const config = await loadConfig();
  const response = await fetchWithTimeout(`${config.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      data?.msg || data?.message || data?.error_description || data?.error || 'Authentication failed.';
    // GoTrue gives a machine-readable reason in error_code; message text is the
    // fallback for older deployments.
    const reason = String(data?.error_code || data?.code || '');

    // GoTrue reports a taken email as "User already registered" (422/400).
    if (/already registered|already exists|user_already_exists/i.test(`${reason} ${message}`)) {
      throw new SupabaseError('email_taken', 'An account with that email already exists.', response.status);
    }
    if (reason === 'invalid_credentials' || /invalid login credentials/i.test(message)) {
      throw new SupabaseError('bad_credentials', 'Wrong email or password.', response.status);
    }
    // The account exists but the address was never confirmed, so it cannot sign
    // in yet. This is a configuration state, not a wrong password.
    if (reason === 'email_not_confirmed' || /email not confirmed/i.test(message)) {
      throw new SupabaseError(
        'email_unconfirmed',
        'This account still needs its email confirmed. Open the confirmation link we emailed you, then sign in.',
        response.status
      );
    }
    if (reason === 'signup_disabled' || /signups not allowed|signup is disabled/i.test(message)) {
      throw new SupabaseError('signup_disabled', 'New accounts are currently disabled for this project.', response.status);
    }
    if (reason === 'weak_password' || /password should be at least/i.test(message)) {
      throw new SupabaseError('weak_password', 'That password is too weak. Use at least 6 characters.', response.status);
    }

    if (response.status === 429) {
      // Supabase throttles signup confirmation emails per project, which is why
      // this appears on every device at once. Surfacing the distinction lets the
      // user retry the right way instead of re-tapping the same button.
      const wait = retryAfterSeconds(response, 60);
      if (/email/i.test(`${reason} ${message}`) || /signup/i.test(reason)) {
        throw new SupabaseError(
          'email_rate_limited',
          'Supabase has hit its limit for sending confirmation emails, so no new confirmation can go out right now. ' +
            'Try again in about an hour, or ask the project owner to turn off "Confirm email" for this project.',
          429,
          wait
        );
      }
      throw new SupabaseError(
        'rate_limited',
        `Too many attempts. Please wait ${wait}s before trying again.`,
        429,
        wait
      );
    }

    throw new SupabaseError('auth', message, response.status);
  }

  return data;
}

/** Create an account. Returns the session when the project auto-confirms. */
export async function signUp(email, password) {
  const data = await authRequest('signup', { email, password });
  if (data?.access_token) {
    const session = sessionFromTokenResponse(data);
    writeSession(session);
    return { session, needsEmailConfirmation: false };
  }
  // Project requires email confirmation: no session yet.
  return { session: null, needsEmailConfirmation: true };
}

export async function signIn(email, password) {
  const data = await authRequest('token?grant_type=password', { email, password });
  const session = sessionFromTokenResponse(data);
  writeSession(session);
  return session;
}

export async function signOut() {
  const session = readStoredSession();
  writeSession(null);
  if (!session?.accessToken) return;
  try {
    const config = await loadConfig();
    await fetchWithTimeout(`${config.url}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}` },
    });
  } catch {
    // Local sign-out already happened; a failed server call must not block it.
  }
}

/**
 * Return a valid access token, refreshing it when it is about to expire.
 * Throws code 'signed_out' when there is nothing to use.
 */
async function accessToken() {
  const session = readStoredSession();
  if (!session) throw new SupabaseError('signed_out', 'Please sign in first.', 401);

  if (session.expiresAt && session.expiresAt - 30_000 > Date.now()) return session.accessToken;

  if (!session.refreshToken) {
    writeSession(null);
    throw new SupabaseError('signed_out', 'Your session expired. Please sign in again.', 401);
  }

  try {
    const data = await authRequest('token?grant_type=refresh_token', {
      refresh_token: session.refreshToken,
    });
    const refreshed = sessionFromTokenResponse(data);
    writeSession(refreshed);
    return refreshed.accessToken;
  } catch {
    writeSession(null);
    throw new SupabaseError('signed_out', 'Your session expired. Please sign in again.', 401);
  }
}

/**
 * Public accessor for the current access token. The admin API needs the raw
 * token as a Bearer header; this reuses the same refresh path as every other
 * request, so an almost-expired token is refreshed rather than failing.
 * Throws code 'signed_out' when there is no session. Never logged.
 */
export async function getAccessToken() {
  return accessToken();
}

/**
 * Force a refresh and return a new access token.
 *
 * Used when the server rejects a token that still looked valid locally
 * (expired, revoked or rotated server-side). One attempt only: when the
 * refresh token is gone too, the caller treats the session as ended.
 * Throws code 'signed_out' in that case.
 */
export async function refreshAccessToken() {
  const session = readStoredSession();
  if (!session) throw new SupabaseError('signed_out', 'Please sign in first.', 401);
  if (!session.refreshToken) {
    writeSession(null);
    throw new SupabaseError('signed_out', 'Your session expired. Please sign in again.', 401);
  }
  // expiresAt = 0 forces the shared refresh path in accessToken().
  writeSession({ ...session, expiresAt: 0 });
  return accessToken();
}

/* -------------------------------- PostgREST ------------------------------- */

async function rest(path, { method = 'GET', body, prefer, retry = true } = {}) {
  const config = await loadConfig();
  const token = await accessToken();

  const headers = {
    apikey: config.anonKey,
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;

  let response;
  try {
    response = await fetchWithTimeout(`${config.url}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw error instanceof SupabaseError
      ? error
      : new SupabaseError('network', 'Could not reach the database. Check your connection.');
  }

  // Expired token revoked server-side: refresh once and retry.
  if (response.status === 401 && retry) {
    const session = readStoredSession();
    if (session) {
      writeSession({ ...session, expiresAt: 0 });
      return rest(path, { method, body, prefer, retry: false });
    }
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const code = data?.code || '';
    const message = data?.message || data?.hint || 'The database rejected the request.';

    // 23505 = unique_violation. For profiles that means the username is taken.
    if (code === '23505') {
      throw new SupabaseError('username_taken', 'That username is already taken.', response.status);
    }
    // 23514 = check_violation, i.e. the username format constraint.
    if (code === '23514') {
      throw new SupabaseError('invalid_username', 'That username is not allowed.', response.status);
    }
    // 42501 = insufficient_privilege. Postgres raises that same code for a
    // missing column grant, an RLS denial and our own guard triggers, so name
    // the real cause instead of one catch-all "not allowed" for all three.
    if (code === '42501' || response.status === 403) {
      const detail = String(message || '');
      if (detail.includes('privilege_change_not_allowed')) {
        throw new SupabaseError(
          'forbidden',
          'Only an administrator can change account privileges.',
          response.status
        );
      }
      if (/row.level.security/i.test(detail)) {
        throw new SupabaseError('forbidden', 'You can only change your own profile.', response.status);
      }
      if (/permission denied/i.test(detail)) {
        throw new SupabaseError(
          'forbidden',
          'The database refused this change (permission denied). Please try again, and contact support if it keeps happening.',
          response.status
        );
      }
      throw new SupabaseError('forbidden', 'You are not allowed to do that.', response.status);
    }
    if (response.status === 404 && code === 'PGRST205') {
      throw new SupabaseError(
        'migration_missing',
        'The Mini Chat database tables have not been created yet.',
        404
      );
    }
    throw new SupabaseError(code || 'database', message, response.status);
  }

  return data;
}

async function rpc(name, args = {}) {
  return rest(`rpc/${name}`, { method: 'POST', body: args });
}

/**
 * Public wrapper so feature modules (friend requests, reports) reuse the exact
 * same authenticated fetch, timeout handling and error mapping as Mini Chat.
 */
export async function callRpc(name, args = {}) {
  return rpc(name, args);
}

/* -------------------------------- profiles -------------------------------- */

/** The signed-in user's profile row, or null when they have not picked one. */
export async function getMyProfile() {
  const user = currentUser();
  if (!user) return null;
  const rows = await rest(
    `profiles?select=id,username,display_name,avatar_seed&id=eq.${encodeURIComponent(user.id)}&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Create or change the caller's username.
 *
 * Uniqueness is decided by the database (unique index on lower(username)); we
 * do not pre-check by querying other profiles, because a broad profile SELECT
 * is intentionally not permitted. A collision surfaces as code
 * 'username_taken' from the 23505 handler above.
 *
 * This deliberately does NOT use a PostgREST upsert. `on_conflict` +
 * `resolution=merge-duplicates` compiles to `INSERT ... ON CONFLICT (id) DO
 * UPDATE SET id = EXCLUDED.id, ...`, and migration 0002 revokes table-level
 * UPDATE while granting column-level UPDATE on username/display_name/
 * avatar_seed only. Writing `id` therefore raises 42501 (permission denied)
 * for every account that already has a profile row. A PATCH names only the
 * granted columns, and the INSERT fallback covers an account whose row is
 * missing (the signup trigger did not run).
 */
export async function saveUsername(rawUsername, displayName) {
  const user = currentUser();
  if (!user) throw new SupabaseError('signed_out', 'Please sign in first.', 401);

  const username = normalizeUsername(rawUsername);
  const fields = {
    username,
    display_name: typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 60) : null,
    avatar_seed: username,
  };

  // 1. Update the caller's own row. The filter is always our own auth uid, so
  // RLS ('profiles: update own', id = auth.uid()) still decides the outcome;
  // this module never widens what the database allows.
  const updated = await rest(
    `profiles?id=eq.${encodeURIComponent(user.id)}&select=id,username,display_name,avatar_seed`,
    { method: 'PATCH', body: fields, prefer: 'return=representation' }
  );
  if (Array.isArray(updated) && updated[0]) return updated[0];

  // 2. Nothing matched. Either the account has no profile row yet, or the row
  // exists and the database refused the write (PostgREST answers an RLS denial
  // with an empty result, not an error). Ask for our own row — permitted by the
  // SELECT policy — to tell those apart instead of reporting a false
  // "username already taken" from the INSERT below.
  const existing = await getMyProfile();
  if (existing) {
    throw new SupabaseError(
      'forbidden',
      'Your profile could not be updated because the database refused the change. Please try again, and contact support if it keeps happening.',
      403
    );
  }

  const created = await rest('profiles?select=id,username,display_name,avatar_seed', {
    method: 'POST',
    body: { id: user.id, ...fields },
    prefer: 'return=representation',
  });
  return Array.isArray(created) && created[0] ? created[0] : { id: user.id, ...fields };
}

/* --------------------------------- people --------------------------------- */

/** Search registered users by username prefix (>= 2 chars). */
/**
 * Public auth settings for this Supabase project (which external providers are
 * enabled, whether email confirmation is on).
 *
 * Unauthenticated and side-effect free. Returns null when it cannot be read so
 * callers can simply hide optional UI instead of showing a dead button.
 */
export async function loadAuthSettings() {
  try {
    const config = await loadConfig();
    const response = await fetchWithTimeout(`${config.url}/auth/v1/settings`, {
      method: 'GET',
      headers: { apikey: config.anonKey, Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = await readJson(response);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Begin a Supabase OAuth sign-in by redirecting to the provider.
 *
 * The return trip lands on the site with `#access_token=…`, which the existing
 * confirmation handler already turns into a stored session — so Google sign-in
 * reuses the verified session path instead of inventing a second one. Only the
 * publishable anon key travels in the URL.
 */
export async function startOAuth(provider = 'google') {
  if (typeof window === 'undefined' || !window.location) {
    throw new SupabaseError('auth', 'This sign-in option needs a browser.');
  }
  const config = await loadConfig();
  const origin = window.location.origin ? `${window.location.origin}/` : '';
  const url = buildOAuthUrl({
    baseUrl: config.url,
    provider,
    redirectTo: origin,
    apikey: config.anonKey,
  });
  if (!url) throw new SupabaseError('auth', 'This sign-in option is not available right now.');
  window.location.assign(url);
}

/**
 * Ensure the signed-in account has a profile row with a username.
 *
 * Signup no longer asks for a username, so a fresh account — or one arriving
 * from a confirmation link — gets one derived from its email address. A taken
 * name is retried with a numeric suffix; the database unique index stays the
 * authority and an existing real username is never overwritten.
 */
export async function ensureProfile({ displayName = '', attempts = 5 } = {}) {
  const user = currentUser();
  if (!user) throw new SupabaseError('signed_out', 'Please sign in first.', 401);

  const existing = await getMyProfile();
  if (existing && existing.username) return existing;

  const email = typeof user.email === 'string' ? user.email : '';
  const limit = Math.max(1, Math.min(10, Math.floor(Number(attempts) || 5)));
  let lastError = null;

  for (let attempt = 0; attempt < limit; attempt += 1) {
    const candidate = suggestUsername(email, attempt);
    if (!candidate) break;
    try {
      return await saveUsername(candidate, displayName);
    } catch (error) {
      if (error instanceof SupabaseError && error.code === 'username_taken') {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof SupabaseError
    ? lastError
    : new SupabaseError('username_taken', 'We could not create a default username. Please choose one.');
}

export async function searchUsers(term) {
  const query = normalizeUsername(term);
  if (query.length < 2) return [];
  const rows = await rpc('search_profiles', { term: query });
  return Array.isArray(rows) ? rows : [];
}

/* ------------------------------ conversations ----------------------------- */

/**
 * Open the direct conversation with `otherUserId`, creating it only if this
 * pair has none. The RPC is idempotent and de-duplicated by dedupe_key, so a
 * double tap cannot create two chats.
 */
export async function startConversation(otherUserId) {
  const id = await rpc('start_conversation', { other_user: otherUserId });
  return typeof id === 'string' ? id : null;
}

export async function listConversations() {
  const rows = await rpc('my_conversations', {});
  return Array.isArray(rows) ? rows : [];
}

export async function listMessages(conversationId, limit = 100) {
  const rows = await rest(
    `messages?select=id,conversation_id,sender_id,body,created_at&conversation_id=eq.${encodeURIComponent(
      conversationId
    )}&order=created_at.asc&limit=${Number(limit) || 100}`
  );
  return Array.isArray(rows) ? rows : [];
}

export async function sendMessage(conversationId, body) {
  const user = currentUser();
  if (!user) throw new SupabaseError('signed_out', 'Please sign in first.', 401);

  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) throw new SupabaseError('empty', 'Type a message first.');
  if (text.length > 4000) throw new SupabaseError('too_long', 'That message is too long.');

  const rows = await rest('messages?select=id,conversation_id,sender_id,body,created_at', {
    method: 'POST',
    body: { conversation_id: conversationId, sender_id: user.id, body: text },
    prefer: 'return=representation',
  });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/** Test/reset helper — clears only this app's session key. */
export function clearLocalSession() {
  writeSession(null);
}

/* ------------------------------ LOKY CONNECT ------------------------------ */
/* Thin wrappers over the RPCs created by 0002 (friends) and 0003 (connect).
   Every call runs as the signed-in user, so RLS decides what is visible; the
   client never receives a service-role key. */

export async function friends() {
  return callRpc('my_friends');
}

export async function friendRequests() {
  return callRpc('my_friend_requests');
}

export async function sendFriendRequest(otherUserId, note = null) {
  return callRpc('send_friend_request', { other_user: otherUserId, note });
}

export async function respondFriendRequest(requestId, decision) {
  return callRpc('respond_friend_request', { request_id: requestId, decision });
}

export async function cancelFriendRequest(requestId) {
  return callRpc('cancel_friend_request', { request_id: requestId });
}

export async function friendStatus(otherUserId) {
  return callRpc('friend_status', { other_user: otherUserId });
}

export async function touchLastSeen() {
  return callRpc('touch_last_seen');
}

export async function connectThreads() {
  return callRpc('connect_threads');
}

export async function connectMessages(conversationId, limit = 60) {
  return callRpc('connect_messages', { conv: conversationId, max_rows: limit });
}

export async function connectSend(conversationId, payload = {}) {
  return callRpc('connect_send_message', {
    conv: conversationId,
    body: payload.body || '',
    media_path: payload.media_path || null,
    media_type: payload.media_type || null,
    reply_to: payload.reply_to || null,
  });
}

export async function connectMarkRead(conversationId) {
  return callRpc('connect_mark_read', { conv: conversationId });
}

export async function connectReact(messageId, emoji) {
  return callRpc('connect_react', { message_id: messageId, emoji });
}

export async function connectUnreact(messageId, emoji) {
  return callRpc('connect_unreact', { message_id: messageId, emoji });
}

export async function connectDeleteMessage(messageId) {
  return callRpc('connect_delete_message', { message_id: messageId });
}

export async function connectSetTyping(conversationId) {
  return callRpc('connect_set_typing', { conv: conversationId });
}

export async function connectTypingStatus(conversationId) {
  return callRpc('connect_typing_status', { conv: conversationId });
}

export async function connectSetProfile(fields = {}) {
  return callRpc('connect_set_profile', {
    display_name: fields.display_name ?? null,
    bio: fields.bio ?? null,
    avatar_url: fields.avatar_url ?? null,
    privacy_last_seen: fields.privacy_last_seen ?? null,
    privacy_discoverable: fields.privacy_discoverable ?? null,
  });
}

export async function connectNotifications(maxRows = 30) {
  return callRpc('connect_notifications', { max_rows: maxRows });
}

export async function connectMarkNotificationsRead() {
  return callRpc('connect_mark_notifications_read');
}

/** Fetch a storage object path and return a short-lived signed URL. */
async function storageFetch(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? 'timed out' : 'could not be reached';
    throw new SupabaseError('network', `Media storage ${reason}.`, 0);
  } finally {
    clearTimeout(timer);
  }
}

function objectExtension(file) {
  const name = typeof file?.name === 'string' ? file.name : '';
  const raw = name.includes('.') ? name.split('.').pop() : '';
  const clean = String(raw).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  return clean || (file?.type === 'video/mp4' ? 'mp4' : 'jpg');
}

function newObjectName() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Upload an image/video to the private `connect-media` bucket.
 *
 * With a conversation id the object lives at `<conversation>/<uuid>.<ext>` and
 * the storage policy checks membership. Without one it lives at
 * `avatars/<user id>/<uuid>.<ext>`, which only that user may write.
 *
 * Returns the object path (not a URL): reads go through signed URLs.
 */
export async function uploadConnectMedia(file, conversationId = null) {
  if (!file) throw new SupabaseError('upload', 'No file was selected.', 400);
  const user = currentUser();
  if (!user || !user.id) {
    throw new SupabaseError('auth', 'Sign in to upload media.', 401);
  }

  const config = await loadConfig();
  const token = await getAccessToken();
  if (!token) throw new SupabaseError('auth', 'Sign in to upload media.', 401);

  const folder = conversationId ? String(conversationId) : `avatars/${user.id}`;
  const objectPath = `${folder}/${newObjectName()}.${objectExtension(file)}`;

  const response = await storageFetch(
    `${config.url}/storage/v1/object/connect-media/${objectPath}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        apikey: config.anonKey,
        'content-type': file.type || 'application/octet-stream',
        'x-upsert': 'false',
      },
      body: file,
    }
  );

  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.message || payload?.error || '';
    } catch {
      detail = '';
    }
    if (response.status === 413) {
      throw new SupabaseError('upload', 'That file is larger than the upload limit.', 413);
    }
    if (response.status === 403 || response.status === 401) {
      throw new SupabaseError('upload', 'You are not allowed to upload to this conversation.', response.status);
    }
    throw new SupabaseError(
      'upload',
      detail ? `Upload failed: ${detail}` : 'The file could not be uploaded.',
      response.status
    );
  }

  return objectPath;
}

/** Sign a private object path for display (one hour). */
export async function signedConnectMediaUrl(objectPath) {
  if (!objectPath) return null;
  if (/^https?:\/\//i.test(objectPath)) return objectPath;

  const config = await loadConfig();
  const token = await getAccessToken();
  if (!token) return null;

  const clean = String(objectPath).replace(/^\/+/, '');
  const response = await storageFetch(
    `${config.url}/storage/v1/object/sign/connect-media/${clean}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        apikey: config.anonKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    }
  );

  if (!response.ok) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    return null;
  }
  const signed = data?.signedURL || data?.signedUrl;
  if (!signed) return null;
  if (/^https?:\/\//i.test(signed)) return signed;
  return `${config.url}/storage/v1${signed}`;
}
