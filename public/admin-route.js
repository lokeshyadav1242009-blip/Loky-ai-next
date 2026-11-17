/**
 * LOKY AI Next — admin route matcher (pure, no DOM, no side effects).
 *
 * The dashboard lives at /admin. Nested paths under it — /admin/admin,
 * /admin/users, /admin/users/<uuid> — are the SAME screen, not a second route:
 * they are matched here and then canonicalised to /admin by admin-ui.js, so the
 * address bar never accumulates duplicate admin routes.
 *
 * Matching only decides which view to mount. It grants nothing: every admin
 * request is authorised server-side against the configured Super Admin UUID.
 */

const ADMIN_ROOT = '/admin';

/**
 * True for /admin and for any path nested beneath it.
 *
 * @param {string} pathname window.location.pathname (query/hash excluded)
 * @returns {boolean}
 */
export function isAdminRoute(pathname) {
  if (typeof pathname !== 'string') return false;
  const path = pathname.trim().toLowerCase().replace(/\/+$/, '');
  if (!path.startsWith('/')) return false;
  return path === ADMIN_ROOT || path.startsWith(`${ADMIN_ROOT}/`);
}

/** The single canonical admin path the nested routes collapse onto. */
export function canonicalAdminPath() {
  return ADMIN_ROOT;
}
