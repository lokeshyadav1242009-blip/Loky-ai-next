/**
 * Error → message mapping for the auth UI.
 *
 * Kept dependency-free and DOM-free so it can be unit tested. The important
 * distinction: a DNS/connection failure means the *sign-in server* is
 * unreachable, which is not the same thing as the user being offline. Blaming
 * the user's connection for a server-side outage is what made a paused Supabase
 * project look like a phone problem.
 */

export const NETWORK_MESSAGES = {
  dns: "The LOKY AI backend is running, but its authentication service can't be reached. This is a server-side problem, not your connection. Please try again shortly.",
  connection: 'Could not connect to the LOKY AI server. Try again in a moment.',
  offline: "You're offline. Reconnect and try again.",
  timeout: 'The server took too long to answer. Try again.',
  unknown: 'Network problem. Check your connection and retry.',
};

/**
 * Work out *why* a fetch failed.
 * @param {any} error the thrown fetch error (TypeError with a `cause`)
 * @returns {'offline'|'dns'|'connection'|'timeout'|'unknown'}
 */
export function classifyNetworkFailure(error) {
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
    return 'offline';
  }

  const cause = error && error.cause ? error.cause.code || error.cause.message || '' : '';
  const text = `${cause} ${error && error.message ? error.message : ''}`;

  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|getaddrinfo/i.test(text)) return 'dns';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ERR_CONNECTION|ERR_NETWORK_CHANGED/i.test(text)) {
    return 'connection';
  }
  if (/abort|timed out|timeout/i.test(text)) return 'timeout';
  return 'unknown';
}

/**
 * A browser cannot see why a fetch failed — Chrome only reports "Failed to
 * fetch" — so the client's own guess is often just 'unknown'. The server can
 * actually probe Supabase, so prefer its evidence: if the server cannot reach
 * the auth host, the outage is server-side no matter how good the user's
 * connection is.
 *
 * @param {string} reason the client-side classification
 * @param {any} health the /api/health payload (may be null)
 * @returns {string} the reason to report
 */
export function refineNetworkReason(reason, health) {
  const verification = health && health.authVerification;
  if (!verification || verification.reachable !== false) return reason;
  return /ENOTFOUND|EAI_AGAIN|NXDOMAIN/i.test(String(verification.reason || ''))
    ? 'dns'
    : 'connection';
}

/**
 * Turn an auth failure into something the user can act on.
 * @param {{code?: string, message?: string, status?: number, reason?: string}} error
 */
export function describeAuthError(error) {
  if (!error || typeof error !== 'object') return 'Something went wrong. Please try again.';

  const code = error.code || '';
  const message = error.message || '';
  const status = Number(error.status) || 0;

  if (code === 'not_configured') return 'Mini Chat accounts are not configured on this server yet.';
  if (code === 'migration_missing') {
    return 'The Mini Chat database tables are missing. Apply supabase/migrations/0001_username_system.sql.';
  }
  if (code === 'signed_out') return 'Please sign in again.';
  if (code === 'username_taken') return 'That username is already taken. Try another one.';

  // Credentials: say it plainly instead of implying a connectivity problem.
  if (code === 'bad_credentials') {
    return 'Wrong email or password. Check them and try again.';
  }
  if (code === 'email_unconfirmed') {
    return 'This account still needs its email confirmed. Open the confirmation link we emailed you, then sign in.';
  }
  if (code === 'email_taken') return 'An account with that email already exists. Sign in instead.';
  if (code === 'signup_disabled') return 'New accounts are currently disabled for this project.';
  if (code === 'weak_password') return 'That password is too weak. Use at least 6 characters.';

  if (code === 'rate_limited' || code === 'email_rate_limited') {
    return message || 'Too many attempts. Wait a moment and try again.';
  }

  if (code === 'network') {
    return NETWORK_MESSAGES[error.reason] || NETWORK_MESSAGES.unknown;
  }

  // A 5xx from Auth is a server fault, not a rejected password.
  if (status >= 500) {
    return `The sign-in service had a problem (HTTP ${status}). This is on the server side — try again shortly.`;
  }

  return message || 'Something went wrong.';
}
