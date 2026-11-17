/**
 * Maintenance mode — server-owned runtime flag.
 *
 * When on, POST /api/chat answers 503 with a clear message instead of calling
 * the AI provider, and /api/health reports the state. The flag is read by the
 * server only; the browser can never set it directly (the toggle is an
 * authenticated Super Admin route).
 *
 * Scope and limits, stated plainly:
 *   - The value is held in this process's memory, so it applies to the running
 *     instance and resets to OFF when the app restarts or redeploys. That is the
 *     safe default: a crash can never leave the assistant stuck in maintenance.
 *   - It is an operations switch, not a security control, so reads fail OPEN.
 *     If this module ever throws, chat keeps working rather than locking every
 *     user out over an internal error.
 */

const state = {
  on: false,
  reason: '',
  since: null,
  updatedBy: null,
};

/** True when the assistant is paused. Never throws. */
export function isMaintenanceOn() {
  try {
    return state.on === true;
  } catch {
    return false;
  }
}

/** A secret-free snapshot for the admin dashboard and /api/health. */
export function maintenanceSnapshot() {
  return {
    on: state.on === true,
    reason: state.reason || '',
    since: state.since || null,
    updatedBy: state.updatedBy || null,
  };
}

/**
 * Turn maintenance mode on or off.
 *
 * @param {object} input
 * @param {boolean} input.on
 * @param {string} [input.reason]
 * @param {string} [input.updatedBy] Super Admin UUID that changed it
 */
export function setMaintenance({ on, reason = '', updatedBy = null } = {}) {
  const next = on === true;
  state.on = next;
  state.reason = next ? String(reason || '').slice(0, 300) : '';
  state.since = next ? new Date().toISOString() : null;
  state.updatedBy = next ? updatedBy || null : null;
  return maintenanceSnapshot();
}

/** Test helper: return to the default off state. */
export function resetMaintenance() {
  state.on = false;
  state.reason = '';
  state.since = null;
  state.updatedBy = null;
  return maintenanceSnapshot();
}
