/**
 * Pure helpers for username search. No DOM, no network — unit tested.
 *
 * Kept separate from connect.js so the search rules (trim, strip '@',
 * lowercase, minimum length, result-state wording) can be verified without a
 * browser or a database.
 */

/** Shortest term that may be searched. */
export const SEARCH_MIN_LENGTH = 2;

/**
 * Normalise what the user typed into the term we actually search for.
 * Trims surrounding spaces, drops any leading '@' (users type "@sunita"
 * because usernames are displayed that way) and lowercases.
 */
export function normalizeSearchTerm(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^@+/, '').trim().toLowerCase();
}

/** True when `term` is long enough to search. */
export function isSearchable(term) {
  return normalizeSearchTerm(term).length >= SEARCH_MIN_LENGTH;
}

/** True when a search result is the signed-in user. */
export function isSelfResult(person, myId) {
  if (!person || !myId) return false;
  return person.id === myId || person.user_id === myId;
}

/** Drop the caller from a result list. */
export function excludeSelf(results, myId) {
  if (!Array.isArray(results)) return [];
  return results.filter((person) => !isSelfResult(person, myId));
}

/**
 * Human label for the relationship shown next to a search result.
 * Returns '' when there is nothing worth saying.
 */
export function friendStateLabel(status) {
  switch (status) {
    case 'friends':
    case 'friend':
    case 'accepted':
      return 'Friends';
    case 'pending_out':
      return 'Request Sent';
    case 'pending_in':
      return 'Wants to connect';
    case 'self':
      return 'You';
    default:
      return '';
  }
}

/**
 * Decide which search state the UI should render.
 *
 * @returns {{ kind: 'idle'|'searching'|'error'|'empty'|'results', message: string }}
 */
export function describeSearchState({ term, count, searching, error } = {}) {
  if (error) {
    return {
      kind: 'error',
      message: typeof error === 'string' && error ? error : 'Search failed.',
    };
  }
  if (searching) {
    return { kind: 'searching', message: 'Searching…' };
  }
  const query = normalizeSearchTerm(term);
  if (!isSearchable(query)) {
    return { kind: 'idle', message: 'Search a username to find people.' };
  }
  if (!count) {
    return { kind: 'empty', message: `No users found for “@${query}”.` };
  }
  return { kind: 'results', message: '' };
}
