/**
 * LOKY AI Next — pure helpers for Supabase auth redirects and signup input.
 *
 * No DOM, no network, no storage: every function here takes plain values and
 * returns plain values. That is what lets the node test suite assert the exact
 * behaviour the browser relies on (confirmation links, expired links, signup
 * validation) without a live Supabase project.
 *
 * Why this exists
 * ---------------
 * Supabase email confirmation redirects back to the Site URL with the session
 * in the URL, not in a cookie:
 *
 *   implicit flow (what this app uses):
 *     https://app/#access_token=...&refresh_token=...&expires_in=3600&type=signup
 *   PKCE flow:
 *     https://app/?code=1234abcd
 *   template that verifies server-side:
 *     https://app/?token_hash=...&type=signup
 *   expired / already used link:
 *     https://app/#error=access_denied&error_code=otp_expired&error_description=...
 *
 * The app used to ignore all of it, so a confirmed user looked signed out and
 * an expired link looked like a silent failure. These helpers read that URL,
 * classify it, and strip it so a reload cannot replay a consumed token.
 */

import { USERNAME_ERRORS, normalizeUsername, validateUsername } from './username-utils.js';

/** Supabase's default minimum. The project may be stricter; that surfaces from the API. */
export const PASSWORD_MIN_LENGTH = 6;
/** bcrypt truncates beyond 72 bytes, so longer passwords are rejected up front. */
export const PASSWORD_MAX_LENGTH = 72;

/** URL keys that only ever appear because Auth redirected here. */
const AUTH_KEYS = [
  'access_token',
  'refresh_token',
  'expires_in',
  'expires_at',
  'token_type',
  'type',
  'provider_token',
  'provider_refresh_token',
  'error',
  'error_code',
  'error_description',
  'error_uri',
  'code',
  'state',
  'token_hash',
  'token',
];

function parseParams(raw) {
  const params = new Map();
  if (!raw) return params;
  for (const [key, value] of new URLSearchParams(raw)) params.set(key, value);
  return params;
}

/** Split an href into its query part and its fragment part, ignoring the rest. */
function splitUrl(href) {
  const text = typeof href === 'string' ? href : '';
  const hashIndex = text.indexOf('#');
  const beforeHash = hashIndex === -1 ? text : text.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : text.slice(hashIndex + 1);
  const queryIndex = beforeHash.indexOf('?');
  const query = queryIndex === -1 ? '' : beforeHash.slice(queryIndex + 1);
  const base = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  return { base, query, hash };
}

/**
 * Classify an auth error reported by GoTrue in the URL.
 * @returns {'expired'|'denied'|'invalid'}
 */
export function classifyAuthError(code, description) {
  const text = `${code || ''} ${description || ''}`;
  if (/otp_expired|expired|has expired/i.test(text)) return 'expired';
  if (/access_denied|denied/i.test(text)) return 'denied';
  return 'invalid';
}

/** User-facing copy for an auth redirect error. Never blames the user. */
export function describeAuthLinkError(error) {
  const kind = error?.kind || classifyAuthError(error?.code, error?.message);
  if (kind === 'expired') {
    return (
      'That confirmation link has expired or was already used. ' +
      'Sign in with your email and password — if your address still needs confirming, ask for a new link.'
    );
  }
  if (kind === 'denied') {
    return 'That link was cancelled. Sign in with your email and password, or request a new confirmation email.';
  }
  return 'That link is not valid any more. Sign in with your email and password, or request a new confirmation email.';
}

/**
 * Read the auth payload out of a URL.
 *
 * @param {string} href  full URL (e.g. `location.href`)
 * @returns {{
 *   action: 'none'|'session'|'token_hash'|'code'|'error',
 *   type: string,
 *   session: null|{ accessToken: string, refreshToken: string, expiresIn: number },
 *   tokenHash: string,
 *   code: string,
 *   error: null|{ kind: 'expired'|'denied'|'invalid', code: string, message: string }
 * }}
 */
export function parseAuthRedirect(href) {
  const empty = {
    action: 'none',
    type: '',
    session: null,
    tokenHash: '',
    code: '',
    error: null,
  };

  const { query, hash } = splitUrl(href);
  if (!query && !hash) return empty;

  const queryParams = parseParams(query);
  const hashParams = parseParams(hash);

  // Merge for reading only; the hash wins because GoTrue appends its result
  // there after redirecting from its own /verify endpoint.
  const read = (key) => hashParams.get(key) ?? queryParams.get(key) ?? '';

  const errorCode = read('error_code') || read('error');
  const errorDescription = read('error_description');
  if (errorCode || (errorDescription && !read('access_token'))) {
    const code = errorCode || 'invalid_link';
    return {
      ...empty,
      action: 'error',
      type: read('type'),
      error: {
        kind: classifyAuthError(code, errorDescription),
        code,
        message: errorDescription || '',
      },
    };
  }

  const accessToken = read('access_token');
  const refreshToken = read('refresh_token');
  if (accessToken) {
    const expiresIn = Number(read('expires_in'));
    return {
      ...empty,
      action: 'session',
      type: read('type') || 'signup',
      session: {
        accessToken,
        refreshToken,
        expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
      },
    };
  }

  const tokenHash = read('token_hash') || read('token');
  const type = read('type');
  if (tokenHash && type) {
    return { ...empty, action: 'token_hash', type, tokenHash };
  }

  const code = queryParams.get('code') || hashParams.get('code');
  if (code) {
    return { ...empty, action: 'code', type, code };
  }

  return empty;
}

/** True when the URL carries anything Auth put there. */
export function hasAuthRedirect(href) {
  return parseAuthRedirect(href).action !== 'none';
}

/**
 * Remove the auth payload from a URL, keeping everything else intact.
 * The result is safe to `history.replaceState()` so a refresh cannot replay a
 * consumed or expired token (and cannot start a redirect loop).
 */
export function stripAuthRedirect(href) {
  const { base, query, hash } = splitUrl(href);
  const authKeys = new Set(AUTH_KEYS);

  const cleanQuery = [...parseParams(query)]
    .filter(([key]) => !authKeys.has(key))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  const cleanHash = [...parseParams(hash)]
    .filter(([key]) => !authKeys.has(key))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  return `${base}${cleanQuery ? `?${cleanQuery}` : ''}${cleanHash ? `#${cleanHash}` : ''}`;
}

/* --------------------------------- signup -------------------------------- */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate a password locally, so the user gets feedback without a round trip.
 * The server stays the authority: a stricter project policy still surfaces from
 * the API as `weak_password`.
 * @returns {{ ok: boolean, code: string|null, error: string|null }}
 */
export function validatePassword(raw) {
  const value = typeof raw === 'string' ? raw : '';
  if (!value) return { ok: false, code: 'empty', error: 'Enter a password.' };
  if (value.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      code: 'too_short',
      error: `Passwords need at least ${PASSWORD_MIN_LENGTH} characters.`,
    };
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      code: 'too_long',
      error: `Passwords can be at most ${PASSWORD_MAX_LENGTH} characters.`,
    };
  }
  if (/^\s+$/.test(value)) {
    return { ok: false, code: 'blank', error: 'A password cannot be only spaces.' };
  }
  return { ok: true, code: null, error: null };
}

/** @returns {{ ok: boolean, code: string|null, error: string|null }} */
export function validateEmail(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, code: 'empty', error: 'Enter your email address.' };
  if (!EMAIL_PATTERN.test(value)) {
    return { ok: false, code: 'invalid', error: 'That email address does not look right.' };
  }
  return { ok: true, code: null, error: null };
}

/** Display names are optional: trim, collapse whitespace, cap at 60 chars. */
export function normalizeDisplayName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * Validate the whole signup form in one pass.
 *
 * `fields` is the raw input; `options.checkUsername` is false when the project
 * cannot answer availability for a signed-out caller (it then only reports
 * format problems and the DB unique index decides).
 *
 * @returns {{
 *   ok: boolean,
 *   errors: { displayName?: string, username?: string, email?: string, password?: string },
 *   value: { displayName: string, username: string, email: string, password: string }
 * }}
 */
export function validateSignupForm(fields = {}) {
  const errors = {};

  const email = validateEmail(fields.email);
  if (!email.ok) errors.email = email.error;

  const password = validatePassword(fields.password);
  if (!password.ok) errors.password = password.error;

  const username = validateUsername(fields.username);
  if (!username.ok) errors.username = USERNAME_ERRORS[username.code] || username.error;

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: {
      displayName: normalizeDisplayName(fields.displayName),
      username: username.value,
      email: typeof fields.email === 'string' ? fields.email.trim() : '',
      password: typeof fields.password === 'string' ? fields.password : '',
    },
  };
}

/**
 * Keep the username someone chose before confirming their email, so onboarding
 * does not ask for it again after the confirmation link is opened.
 * Stored as plain data; contains no password and no token.
 */
export const SIGNUP_INTENT_VERSION = 1;

export function createSignupIntent(value = {}, now = Date.now()) {
  return {
    v: SIGNUP_INTENT_VERSION,
    email: normalizeUsernameLike(value.email),
    username: normalizeUsername(value.username),
    displayName: normalizeDisplayName(value.displayName),
    at: now,
  };
}

/** Emails are compared case/whitespace insensitively here, nothing more. */
function normalizeUsernameLike(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** A signup intent is only usable for the same address and for a week. */
export function isSignupIntentUsable(intent, email, now = Date.now()) {
  if (!intent || intent.v !== SIGNUP_INTENT_VERSION) return false;
  if (!intent.username) return false;
  if (!validateUsername(intent.username).ok) return false;
  const age = now - Number(intent.at || 0);
  if (!Number.isFinite(age) || age < 0 || age > 7 * 24 * 60 * 60 * 1000) return false;
  if (!email) return true;
  return normalizeUsernameLike(intent.email) === normalizeUsernameLike(email);
}
