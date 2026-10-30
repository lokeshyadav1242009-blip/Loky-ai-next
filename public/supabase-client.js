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

import { normalizeUsername } from './username-utils.js';

/** Session storage is deliberately separate from both other storage keys. */
export const AUTH_STORAGE_KEY = 'loky.ai.next.auth.v1';

let cachedConfig = null;
let cachedSession = null;
let configPromise = null;

/* --------------------------------- errors --------------------------------- */

export class SupabaseError extends Error {
  constructor(code, message, status = 0, retryAfter = 0) {
    super(message);
    this.name = 'SupabaseError';
    this.code = code;
    this.status = status;
    /** Seconds the caller should wait before trying again (0 = unknown). */
    this.retryAfter = retryAfter;
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
      reject(
        new SupabaseError(
          'network',
          'The request timed out. Check your connection and try again.',
          0
        )
      );
    }, ms);
  });

  try {
    return await Promise.race([
      fetch(url, { ...options, signal: controller.signal }),
      timedOut,
    ]);
  } catch (error) {
    if (error instanceof SupabaseError) throw error;
    throw new SupabaseError('network', 'Could not reach the server. Check your connection.');
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
    response = await fetch(`${config.url}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new SupabaseError('network', 'Could not reach the database. Check your connection.');
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
    if (code === '42501' || response.status === 403) {
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
 */
export async function saveUsername(rawUsername, displayName) {
  const user = currentUser();
  if (!user) throw new SupabaseError('signed_out', 'Please sign in first.', 401);

  const username = normalizeUsername(rawUsername);
  const row = {
    id: user.id,
    username,
    display_name: typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 60) : null,
    avatar_seed: username,
  };

  const rows = await rest('profiles?on_conflict=id&select=id,username,display_name,avatar_seed', {
    method: 'POST',
    body: row,
    prefer: 'resolution=merge-duplicates,return=representation',
  });

  return Array.isArray(rows) && rows[0] ? rows[0] : row;
}

/* --------------------------------- people --------------------------------- */

/** Search registered users by username prefix (>= 2 chars). */
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
