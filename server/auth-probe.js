/**
 * Supabase Auth reachability probe for /api/health.
 *
 * Session verification on protected routes calls `<project>/auth/v1/user`. When
 * the project host does not resolve (paused/deleted project, or a stale project
 * ref in SUPABASE_URL) every authenticated request returns 503 and the app looks
 * broken for no visible reason. This probe turns that into a readable state:
 * `/api/health` reports whether the Auth host is reachable, and why not.
 *
 * It reads only the public project URL and publishable key, never a secret, and
 * its result is cached so a health check stays fast even while the host is down.
 */

import { resolveSupabase } from './auth.js';

const TTL_MS = 60_000;
const TIMEOUT_MS = 2_500;

let cache = { key: '', at: 0, value: null };

/**
 * @param {object|null} supabase raw or normalised Supabase settings
 * @param {{fetchImpl?: Function, now?: () => number}} [options] test seams
 */
export async function probeAuthHost(supabase, { fetchImpl, now = Date.now } = {}) {
  const settings = resolveSupabase(supabase);
  const key = settings ? settings.url : 'none';
  const stamp = now();

  if (cache.key === key && stamp - cache.at < TTL_MS) return cache.value;

  let value;
  if (!settings) {
    value = { configured: false, reachable: null };
  } else {
    const host = new URL(settings.url).host;
    const doFetch = fetchImpl || globalThis.fetch;
    const started = Date.now();

    try {
      const response = await doFetch(`${settings.url}/auth/v1/health`, {
        headers: { apikey: settings.key },
        signal:
          typeof AbortSignal !== 'undefined' && AbortSignal.timeout
            ? AbortSignal.timeout(TIMEOUT_MS)
            : undefined,
      });
      value = {
        configured: true,
        host,
        reachable: true,
        status: response && response.status ? response.status : 0,
        ms: Date.now() - started,
      };
    } catch (error) {
      const cause = error && error.cause ? error.cause.code || error.cause.message : '';
      value = {
        configured: true,
        host,
        reachable: false,
        reason: String(cause || (error && error.name) || 'fetch_failed'),
        ms: Date.now() - started,
      };
    }
  }

  cache = { key, at: stamp, value };
  return value;
}

/** Test seam: forget the cached probe result. */
export function resetAuthProbeCache() {
  cache = { key: '', at: 0, value: null };
}
