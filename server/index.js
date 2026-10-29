import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, isConfigured } from './config.js';
import { AppError, errors } from './errors.js';
import { streamChat } from './providers.js';
import { validateChatRequest } from './validate.js';
import { createRateLimiter, rateLimitMiddleware } from './rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

const app = express();

// Behind the platform's reverse proxy: trust one hop so req.ip is the client.
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ----------------------------- baseline headers ---------------------------- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      // Mini Chat talks to Supabase Auth + PostgREST directly from the browser.
      // One origin covers both; nothing else is opened up.
      "connect-src 'self' https://jqnzfuimnkghwqccyosw.supabase.co",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  );
  next();
});

app.use(express.json({ limit: '1mb' }));

/* --------------------------------- routes --------------------------------- */

const startedAt = Date.now();

/**
 * Public, secret-free runtime info. The browser uses this to show the active
 * model and to warn early when the server has no API key configured.
 * NOTE: only ever expose a boolean for the key - never the value.
 */
app.get('/api/health', (req, res) => {
  const ready = isConfigured(config);
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'unconfigured',
    provider: config.providerLabel,
    providerId: config.provider,
    model: config.model,
    streaming: true,
    configured: ready,
    missing: ready ? [] : missingSettings(config),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    limits: {
      rateLimitMax: config.limits.rateLimitMax,
      rateLimitWindowMs: config.limits.rateLimitWindowMs,
      maxInputChars: config.limits.maxInputChars,
    },
  });
});

/**
 * Public browser bootstrap for Mini Chat.
 *
 * The Supabase client needs the project URL and a publishable (anon) key before
 * it can sign a user in. Both are public by design: they ship to every browser
 * and are protected by RLS, not by secrecy. This handler therefore returns ONLY
 * those two values. The service-role key is never read into server/config.js at
 * all, so it cannot leak here even by mistake - see loadSupabase().
 */
app.get('/api/supabase-config', (req, res) => {
  // Per-deploy value; never let a proxy cache it.
  res.setHeader('Cache-Control', 'no-store');
  const { url, key, configured } = config.supabase;
  if (!configured) {
    return res.status(503).json({
      error: {
        code: 'supabase_not_configured',
        message: 'Mini Chat is not configured on this server yet.',
        hint: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in the server environment, then restart.',
        retryable: false,
      },
    });
  }
  return res.json({ url, anonKey: key, configured: true });
});

const limiter = createRateLimiter({
  max: config.limits.rateLimitMax,
  windowMs: config.limits.rateLimitWindowMs,
});
limiter.windowMs = config.limits.rateLimitWindowMs;

/**
 * POST /api/chat  ->  text/event-stream
 *
 * Events:
 *   data: {"type":"meta",  model, provider}      once, before any tokens
 *   data: {"type":"delta",  text}                once per token batch
 *   data: {"type":"error",  code, message, hint, retryAfter}
 *   data: {"type":"done",  aborted}              final event on success
 */
app.post('/api/chat', rateLimitMiddleware(limiter), async (req, res) => {
  // 1. Fail fast with a helpful message when the server is not configured.
  if (!isConfigured(config)) {
    const missing = missingSettings(config);
    return res.status(503).json({
      error: {
        code: 'ai_not_configured',
        message: 'The AI service is not configured on this server yet.',
        hint: `Set ${missing.join(' and ')} in the server environment, then restart. See README.md for setup.`,
        retryable: false,
      },
    });
  }

  // 2. Validate the conversation before touching the provider.
  let messages;
  try {
    messages = validateChatRequest(req.body, config.limits);
  } catch (error) {
    return sendError(res, error);
  }

  // 3. Open the SSE stream and pipe tokens through.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Stops nginx buffering the stream when self-hosting.
    'X-Accel-Buffering': 'no',
  });

  const send = (payload) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Heartbeat keeps intermediaries from closing an idle stream.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);

  const abortController = new AbortController();
  res.on('close', () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) abortController.abort();
  });

  send({
    type: 'meta',
    model: config.model,
    provider: config.providerLabel,
  });

  let aborted = false;
  try {
    for await (const delta of streamChat(config, messages, {
      signal: abortController.signal,
    })) {
      send({ type: 'delta', text: delta });
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      aborted = true;
    } else {
      const appError = error instanceof AppError ? error : errors.internal();
      if (!(error instanceof AppError)) {
        console.error('[chat] unexpected error:', error?.message);
      } else {
        console.warn(`[chat] ${appError.code}: ${appError.message}`);
      }
      send({ type: 'error', ...appError.toJSON().error });
    }
  } finally {
    clearInterval(heartbeat);
    if (!aborted && !res.writableEnded) {
      send({ type: 'done', aborted: false });
      res.end();
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

/* ------------------------------- static site ------------------------------ */

app.use(
  express.static(publicDir, {
    etag: true,
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

// SPA-ish fallback for unknown non-API GET routes.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(publicDir, 'index.html'));
});

/* ----------------------------- error handling ---------------------------- */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return sendError(res, errors.badRequest(`Unknown endpoint ${req.method} ${req.path}.`));
  }
  return res.status(404).send('Not found');
});

// eslint-disable-next-line no-unused-vars -- Express needs 4 args here.
app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return sendError(
      res,
      errors.tooLarge('That request was too large.', 'Send a shorter conversation.'),
    );
  }
  if (error instanceof SyntaxError && 'body' in error) {
    return sendError(res, errors.badRequest('The request body was not valid JSON.'));
  }
  console.error('[server] unhandled error:', error?.message);
  return sendError(res, errors.internal());
});

function sendError(res, error) {
  const appError = error instanceof AppError ? error : errors.internal();
  if (res.headersSent) {
    // Already streaming - emit an error event and close.
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', ...appError.toJSON().error })}\n\n`);
      res.end();
    }
    return undefined;
  }
  if (appError.retryAfter) res.setHeader('Retry-After', String(appError.retryAfter));
  return res.status(appError.status).json(appError.toJSON());
}

function missingSettings(cfg) {
  const missing = [];
  if (!cfg.apiKey && cfg.requiresApiKey) missing.push('AI_API_KEY');
  if (!cfg.baseUrl) missing.push('AI_BASE_URL');
  if (!cfg.model) missing.push('AI_MODEL');
  return missing.length > 0 ? missing : ['AI_API_KEY'];
}

/* --------------------------------- startup -------------------------------- */

const { port, host } = config.server;

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(port, host, () => {
    const ready = isConfigured(config);
    console.log(`LOKY AI Next running on http://${host}:${port}`);
    console.log(`Provider: ${config.providerLabel} (${config.provider}) - model: ${config.model}`);
    if (!ready) {
      console.warn(
        `[warn] AI provider not configured - missing ${missingSettings(config).join(', ')}. ` +
          'The UI will explain this instead of failing silently.',
      );
    }
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { app, missingSettings };
