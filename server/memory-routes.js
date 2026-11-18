/**
 * LOKY MEMORY — HTTP surface.
 *
 *   GET    /api/memories            list + settings
 *   POST   /api/memories            create one
 *   PATCH  /api/memories/:id        edit content/category/pin
 *   DELETE /api/memories/:id        delete one
 *   GET    /api/memory-settings     { enabled }
 *   PATCH  /api/memory-settings     { enabled }
 *
 * Every route is behind requireAuth, and every database call uses the caller's
 * own bearer token, so PostgREST RLS decides what each account can see. The
 * service-role key is never read here.
 */

import express from 'express';

import { requireAuth } from './auth.js';
import { config } from './config.js';
import { MemoryError, createMemoryStore, supabaseCreds } from './memory.js';
import { createRateLimiter, rateLimitMiddleware } from './rateLimit.js';

/** The raw bearer credential, for forwarding to PostgREST. Never logged. */
export function bearerToken(req) {
  const header = req.headers?.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

/** Build a store for this request, or null when the deployment has no Supabase. */
function storeFor(req) {
  const creds = supabaseCreds(config);
  if (!creds) return null;
  const token = bearerToken(req);
  if (!token) return null;
  return createMemoryStore({ ...creds, token });
}

function fail(res, error) {
  if (error instanceof MemoryError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, retryable: error.status >= 500 },
    });
  }
  console.warn('[memory] unexpected error:', error?.message);
  return res.status(502).json({
    error: {
      code: 'memory_unavailable',
      message: 'Memory storage is unavailable right now.',
      retryable: true,
    },
  });
}

const NOT_CONFIGURED = {
  error: {
    code: 'memory_not_configured',
    message: 'Memory needs Supabase to be configured on this server.',
    retryable: false,
  },
};

export function createMemoryRouter() {
  const router = express.Router();

  // Editing memories is cheap but not free: keep it well clear of the chat
  // limiter so a chat burst can never lock the Memory page.
  const limiter = createRateLimiter({ max: 120, windowMs: 60_000 });

  router.use(requireAuth);
  router.use(rateLimitMiddleware(limiter));

  /* ------------------------------- settings ------------------------------- */

  router.get('/settings', async (req, res) => {
    const store = storeFor(req);
    if (!store) return res.status(503).json(NOT_CONFIGURED);
    try {
      const enabled = await store.getEnabled();
      return res.json({ enabled, configured: true });
    } catch (error) {
      return fail(res, error);
    }
  });

  router.patch('/settings', async (req, res) => {
    const store = storeFor(req);
    if (!store) return res.status(503).json(NOT_CONFIGURED);
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({
        error: { code: 'bad_request', message: '`enabled` must be true or false.' },
      });
    }
    try {
      const enabled = await store.setEnabled(req.body.enabled);
      return res.json({ enabled, configured: true });
    } catch (error) {
      return fail(res, error);
    }
  });

  /* ------------------------------- memories ------------------------------- */

  router.get('/', async (req, res) => {
    const store = storeFor(req);
    if (!store) {
      // The page must still open and explain itself instead of showing an
      // error where the list belongs.
      return res.json({ memories: [], enabled: false, configured: false });
    }
    try {
      const [memories, enabled] = await Promise.all([store.list(), store.getEnabled()]);
      return res.json({ memories, enabled, configured: true });
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post('/', async (req, res) => {
    const store = storeFor(req);
    if (!store) return res.status(503).json(NOT_CONFIGURED);
    try {
      const memory = await store.create({
        content: req.body?.content,
        category: req.body?.category,
        pinned: req.body?.pinned,
        source: req.body?.source,
      });
      return res.status(201).json({ memory });
    } catch (error) {
      return fail(res, error);
    }
  });

  router.patch('/:id', async (req, res) => {
    const store = storeFor(req);
    if (!store) return res.status(503).json(NOT_CONFIGURED);
    try {
      const memory = await store.update(req.params.id, {
        content: req.body?.content,
        category: req.body?.category,
        pinned: req.body?.pinned,
      });
      if (!memory) {
        return res.status(404).json({
          error: { code: 'not_found', message: 'That memory no longer exists.' },
        });
      }
      return res.json({ memory });
    } catch (error) {
      return fail(res, error);
    }
  });

  router.delete('/:id', async (req, res) => {
    const store = storeFor(req);
    if (!store) return res.status(503).json(NOT_CONFIGURED);
    try {
      await store.remove(req.params.id);
      return res.json({ ok: true, id: req.params.id });
    } catch (error) {
      return fail(res, error);
    }
  });

  return router;
}
