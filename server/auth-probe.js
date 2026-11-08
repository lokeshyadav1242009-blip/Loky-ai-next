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

/**
 * A deleted Supabase project stops resolving in DNS entirely (NXDOMAIN), while a
 * paused one still resolves and answers with 5xx. Those need different advice:
 * one is transient, the other needs the owner to restore or replace the project.
 * Reporting both as "network problem, try again" sent users into a retry loop
 * that could never succeed.
 */
const MISSING_HOST = /ENOTFOUND|EAI_AGAIN|NXDOMAIN|ERR_NAME_NOT_RESOLVED|getaddrinfo/i;

/**
 * @param {string} reason the raw DNS/network failure code
 * @returns {'project_missing'|'timeout'|'refused'|'unreachable'}
 */
export function classifyAuthCause(reason) {
  const text = String(reason || '');
  if (MISSING_HOST.test(text)) return 'project_missing';
  if (/abort|timed?\s?out|ETIMEDOUT/i.test(text)) return 'timeout';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(text)) return 'refused';
  return 'unreachable';
}

/**
 * Which Supabase project this server is bound to.
 *
 * The ref is public: it is already part of SUPABASE_URL and of the publishable
 * key's JWT claims. Naming it is what lets an owner see at a glance which
 * project is configured. No key material is returned.
 */
export function projectRefFrom(settings) {
  if (!settings) return '';
  const parts = String(settings.key || '').split('.');
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (claims && claims.ref) return String(claims.ref);
    } catch {
      /* not a JWT — fall back to the host */
    }
  }
  try {
    return new URL(settings.url).host.split('.')[0] || '';
  } catch {
    return '';
  }
}

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
    const projectRef = projectRefFrom(settings);
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
        projectRef,
        reachable: true,
        status: response && response.status ? response.status : 0,
        ms: Date.now() - started,
      };
    } catch (error) {
      const reason = String(
        (error && error.cause ? error.cause.code || error.cause.message : '') ||
          (error && error.name) ||
          'fetch_failed'
      );
      const cause = classifyAuthCause(reason);
      value = {
        configured: true,
        host,
        projectRef,
        reachable: false,
        reason,
        cause,
        ...(cause === 'project_missing'
          ? {
              hint:
                'This Supabase project does not resolve in DNS, which means it was deleted or replaced. ' +
                'Restore or recreate the project, point SUPABASE_URL and SUPABASE_ANON_KEY at it, then redeploy. ' +
                'Retrying sign-in cannot succeed until that is done.',
            }
          : {}),
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
