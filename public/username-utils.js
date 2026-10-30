/**
 * LOKY AI Next — username rules.
 *
 * Pure functions only: no DOM, no network. They are imported by the browser
 * (direct-messages.js) AND by the node test suite, so the rules that the UI
 * shows are exactly the rules the database constraint enforces
 * (see supabase/migrations/0001_username_system.sql).
 *
 * Storage format is always the normalised (lowercase) form, which is what the
 * unique index `profiles_username_lower_key` and the CHECK constraint expect.
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;
export const USERNAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * Names that would be confusing or could impersonate the product/support.
 * Rejected at the application layer; the database does not need to know.
 */
export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'api',
  'appjet',
  'help',
  'loky',
  'lokyainext',
  'moderator',
  'null',
  'official',
  'root',
  'security',
  'staff',
  'support',
  'system',
  'undefined',
]);

/** Human-readable message for every failure code. */
export const USERNAME_ERRORS = {
  empty: 'Enter a username.',
  too_short: `Usernames need at least ${USERNAME_MIN_LENGTH} characters.`,
  too_long: `Usernames can be at most ${USERNAME_MAX_LENGTH} characters.`,
  invalid_chars: 'Use only letters, numbers and underscores (_).',
  reserved: 'That username is reserved. Please pick another one.',
  unavailable: 'That username is already taken.',
  network: 'Could not reach the server. Please try again.',
};

/**
 * Normalise user input to the canonical stored form.
 * - trims surrounding whitespace
 * - drops a leading "@" (people type "@alice")
 * - lowercases, so "Alice" and "alice" are the same account
 * Returns '' for non-string input.
 */
export function normalizeUsername(raw) {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  if (value.startsWith('@')) value = value.slice(1);
  return value.trim().toLowerCase();
}

/**
 * Validate raw user input.
 * @returns {{ ok: boolean, value: string, code: string|null, error: string|null }}
 */
export function validateUsername(raw) {
  const value = normalizeUsername(raw);

  const fail = (code) => ({ ok: false, value, code, error: USERNAME_ERRORS[code] });

  if (!value) return fail('empty');
  if (value.length < USERNAME_MIN_LENGTH) return fail('too_short');
  if (value.length > USERNAME_MAX_LENGTH) return fail('too_long');
  if (!USERNAME_PATTERN.test(value)) return fail('invalid_chars');
  if (RESERVED_USERNAMES.has(value)) return fail('reserved');

  return { ok: true, value, code: null, error: null };
}

/**
 * True when two usernames refer to the same account, ignoring case and a
 * leading "@". Used to stop a user from searching/adding themselves.
 */
export function isSameUsername(a, b) {
  const left = normalizeUsername(a);
  const right = normalizeUsername(b);
  return Boolean(left) && left === right;
}

/**
 * Display form used in the UI: "@alice".
 */
export function displayUsername(raw) {
  const value = normalizeUsername(raw);
  return value ? `@${value}` : '';
}

/**
 * Deterministic dedupe key for a direct conversation between two users.
 * Sorting the ids means (a,b) and (b,a) produce the same key, which is what
 * lets the database enforce "one conversation per pair".
 */
export function directConversationKey(userA, userB) {
  if (typeof userA !== 'string' || typeof userB !== 'string' || !userA || !userB) return '';
  return [userA, userB].sort().join(':');
}
