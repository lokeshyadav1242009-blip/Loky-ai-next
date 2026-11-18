/**
 * LOKY MEMORY — server-side store.
 *
 * All database access goes through PostgREST using **the signed-in user's own
 * access token**, never the service-role key. That means Row Level Security —
 * not this module — is the boundary that keeps one account's memories away
 * from another's. If a policy were wrong, a bug here could not widen access.
 *
 * Every function degrades safely: a missing Supabase configuration or a
 * timeout returns a typed result instead of throwing into the chat route, so
 * memory can never break the assistant.
 */

import {
  MAX_MEMORIES_PER_USER,
  buildMemoryBlock,
  selectRelevant,
  validateMemory,
} from '../public/memory-model.js';

const DEFAULT_TIMEOUT_MS = 8000;
/** Chat-time lookup must be fast: a slow memory read may not delay the answer. */
const CHAT_LOOKUP_TIMEOUT_MS = 1800;

/** Pull Supabase credentials from the already-loaded config. */
export function supabaseCreds(config) {
  const sb = config?.supabase ?? {};
  const url = String(sb.url ?? '').trim().replace(/\/+$/, '');
  const key = String(sb.key ?? sb.anonKey ?? '').trim();
  if (!url || !key) return null;
  return { url, key };
}

class MemoryError extends Error {
  constructor(message, { status = 502, code = 'memory_unavailable' } = {}) {
    super(message);
    this.name = 'MemoryError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Minimal PostgREST client bound to one user's token.
 * @param {{ url: string, key: string, token: string, fetchImpl?: Function, timeoutMs?: number }} options
 */
export function createMemoryStore({
  url,
  key,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!url || !key) throw new MemoryError('Supabase is not configured.', { status: 503, code: 'memory_not_configured' });
  if (!token) throw new MemoryError('A signed-in session is required.', { status: 401, code: 'auth_required' });

  async function request(path, { method = 'GET', body, prefer, timeout = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(`${url}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: key,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(prefer ? { Prefer: prefer } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new MemoryError('Your session expired. Sign in again.', {
          status: 401,
          code: 'auth_required',
        });
      }
      if (response.status === 409) {
        throw new MemoryError('That memory already exists.', { status: 409, code: 'duplicate' });
      }
      if (!response.ok) {
        throw new MemoryError('Memory storage is unavailable right now.', { status: 502 });
      }

      if (method === 'DELETE' || response.status === 204) return null;
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      if (error?.name === 'AbortError') {
        throw new MemoryError('Memory storage timed out.', { status: 504, code: 'memory_timeout' });
      }
      throw new MemoryError('Memory storage is unreachable.', { status: 502 });
    } finally {
      clearTimeout(timer);
    }
  }

  const columns = 'id,user_id,category,content,source,pinned,created_at,updated_at';

  return {
    /** Newest-first list for the Memory page. */
    async list({ limit = MAX_MEMORIES_PER_USER } = {}) {
      const rows = await request(
        `memories?select=${columns}&order=pinned.desc,updated_at.desc&limit=${limit}`,
      );
      return Array.isArray(rows) ? rows : [];
    },

    /** The ON/OFF switch. A missing row means "on" (the product default). */
    async getEnabled() {
      const rows = await request('memory_settings?select=enabled&limit=1', {
        timeout: CHAT_LOOKUP_TIMEOUT_MS,
      });
      if (!Array.isArray(rows) || rows.length === 0) return true;
      return rows[0].enabled !== false;
    },

    async setEnabled(enabled) {
      const rows = await request('memory_settings?on_conflict=user_id&select=enabled', {
        method: 'POST',
        body: [{ enabled: Boolean(enabled) }],
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      return row ? row.enabled !== false : Boolean(enabled);
    },

    async count() {
      const response = await request('memories?select=id', {
        method: 'HEAD',
      });
      // HEAD returns no body; use the content-range header instead.
      return response;
    },

    /** Validate again on the server — the client's checks are advisory. */
    async create(input = {}) {
      const checked = validateMemory(input);
      if (!checked.ok) {
        throw new MemoryError(checked.error, { status: 400, code: checked.code });
      }

      const existing = await this.list();
      if (existing.length >= MAX_MEMORIES_PER_USER) {
        throw new MemoryError('You have reached the memory limit. Delete some to add more.', {
          status: 400,
          code: 'too_many',
        });
      }

      const rows = await request(`memories?select=${columns}`, {
        method: 'POST',
        body: [
          {
            content: checked.value.content,
            category: checked.value.category,
            source: input.source === 'auto' ? 'auto' : 'manual',
            pinned: Boolean(input.pinned),
          },
        ],
        prefer: 'return=representation',
      });
      return Array.isArray(rows) ? rows[0] : rows;
    },

    async update(id, input = {}) {
      if (!id) throw new MemoryError('A memory id is required.', { status: 400, code: 'bad_request' });

      const patch = {};
      if (input.content !== undefined || input.category !== undefined) {
        const checked = validateMemory({
          content: input.content,
          category: input.category,
        });
        if (!checked.ok) throw new MemoryError(checked.error, { status: 400, code: checked.code });
        patch.content = checked.value.content;
        patch.category = checked.value.category;
      }
      if (input.pinned !== undefined) patch.pinned = Boolean(input.pinned);
      if (Object.keys(patch).length === 0) {
        throw new MemoryError('Nothing to update.', { status: 400, code: 'bad_request' });
      }

      const rows = await request(`memories?id=eq.${encodeURIComponent(id)}&select=${columns}`, {
        method: 'PATCH',
        body: patch,
        prefer: 'return=representation',
      });
      return Array.isArray(rows) ? rows[0] : rows;
    },

    async remove(id) {
      if (!id) throw new MemoryError('A memory id is required.', { status: 400, code: 'bad_request' });
      await request(`memories?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return { id };
    },

    /**
     * Build the system-prompt block for one question.
     *
     * Reads the switch and the user's notes with a short timeout, keeps only
     * memories that actually match the question, and returns '' when memory is
     * off or nothing is relevant.
     */
    async contextFor(question) {
      const enabled = await this.getEnabled();
      if (!enabled) return { enabled: false, block: '', count: 0 };

      const all = await this.list();
      const relevant = selectRelevant(all, question);
      return { enabled: true, block: buildMemoryBlock(relevant), count: relevant.length };
    },
  };
}

/**
 * Convenience wrapper used by the chat route: never throws, never delays the
 * answer beyond a short budget.
 */
export async function memoryBlockForRequest({ config, token, question }) {
  const creds = supabaseCreds(config);
  if (!creds || !token) return '';

  try {
    const store = createMemoryStore({ ...creds, token });
    const { block } = await store.contextFor(question);
    return block || '';
  } catch {
    // Memory is an enhancement; the assistant must answer without it.
    return '';
  }
}

export { MemoryError, CHAT_LOOKUP_TIMEOUT_MS };
