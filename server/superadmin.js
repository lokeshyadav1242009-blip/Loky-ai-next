/**
 * Super Admin identity — server-side only.
 *
 * LOKY AI has exactly one Super Admin: the owner's Supabase Auth user. The
 * authoritative fact is that user's UUID, which lives in the server environment
 * (SUPER_ADMIN_USER_IDS) and never reaches the browser.
 *
 * Why an allow-list on top of profiles.is_admin:
 *   - `profiles.is_admin` is a database flag. If it is ever flipped on another
 *     account (a bad migration, a support mistake, a future bug), that account
 *     would otherwise gain the dashboard. The UUID allow-list means the server
 *     still refuses anyone who is not the owner.
 *   - Username, display name, email text and anything stored in localStorage are
 *     all user-controlled and are never consulted here.
 *
 * The functions are pure so the decision logic can be unit tested without a
 * live Supabase project, and so every route shares one implementation.
 */

export const SUPER_ADMIN_ENV = 'SUPER_ADMIN_USER_IDS';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a string is a canonical UUID. */
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

/**
 * Parse the configured allow-list. Accepts comma, space or newline separated
 * UUIDs and ignores anything that is not a UUID, so a typo cannot accidentally
 * widen access. Returns lowercase, de-duplicated ids.
 */
export function parseSuperAdminIds(raw) {
  if (typeof raw !== 'string') return [];
  const seen = new Set();
  for (const piece of raw.split(/[\s,]+/)) {
    const value = piece.trim().toLowerCase();
    if (UUID_RE.test(value)) seen.add(value);
  }
  return [...seen];
}

/** The dashboard is unavailable until the owner's UUID is configured. */
export function superAdminConfigured(allowList) {
  return Array.isArray(allowList) && allowList.length > 0;
}

/** Exact, case-insensitive membership test against the allow-list. */
export function isSuperAdmin(userId, allowList) {
  if (!userId || !superAdminConfigured(allowList)) return false;
  return allowList.includes(String(userId).trim().toLowerCase());
}

/**
 * The single authorization decision used by every /api/admin route.
 *
 * Fails closed: with no configured owner, nobody is admitted. That is
 * deliberate — an unconfigured dashboard must never fall back to "any admin".
 *
 * @param {object} input
 * @param {string} input.userId   Supabase Auth UUID from the verified token
 * @param {boolean} input.isAdmin profiles.is_admin for that user
 * @param {string} [input.status] profile status ('active' | 'suspended' | ...)
 * @param {string[]} input.allowList parsed SUPER_ADMIN_USER_IDS
 */
export function superAdminDecision({ userId, isAdmin, status, allowList }) {
  if (!superAdminConfigured(allowList)) {
    return {
      ok: false,
      status: 503,
      code: 'super_admin_not_configured',
      message: 'The Super Admin account is not configured on this server yet.',
      hint:
        `Set ${SUPER_ADMIN_ENV} to the owner's Supabase Auth user UUID, then redeploy. ` +
        'Find it in Supabase Dashboard -> Authentication -> Users.',
    };
  }

  if (!isAdmin) {
    return {
      ok: false,
      status: 403,
      code: 'not_admin',
      message: 'This account is not an administrator.',
    };
  }

  if (status && status !== 'active') {
    return {
      ok: false,
      status: 403,
      code: 'account_inactive',
      message: 'This administrator account is not active.',
    };
  }

  if (!isSuperAdmin(userId, allowList)) {
    return {
      ok: false,
      status: 403,
      code: 'not_super_admin',
      message: 'Only the LOKY AI owner account may open the admin dashboard.',
    };
  }

  return { ok: true, code: 'super_admin' };
}

/**
 * Whether the Super Admin may delete a given account.
 *
 * Deletion is the one irreversible action in the dashboard, so it refuses:
 *   - deleting your own account,
 *   - deleting the configured Super Admin,
 *   - deleting any other administrator.
 * The database also refuses to change administrator status, so these two checks
 * overlap on purpose.
 */
export function canDeleteUser({ actorId, targetId, targetIsAdmin, allowList }) {
  if (!isUuid(actorId) || !isUuid(targetId)) {
    return { ok: false, code: 'invalid_target', message: 'Invalid account id.' };
  }
  if (String(actorId).toLowerCase() === String(targetId).toLowerCase()) {
    return { ok: false, code: 'cannot_delete_self', message: 'You cannot delete your own account.' };
  }
  if (isSuperAdmin(targetId, allowList)) {
    return {
      ok: false,
      code: 'cannot_delete_super_admin',
      message: 'The Super Admin account cannot be deleted.',
    };
  }
  if (targetIsAdmin) {
    return {
      ok: false,
      code: 'cannot_delete_admin',
      message: 'Administrator accounts cannot be deleted from the dashboard.',
    };
  }
  return { ok: true };
}
