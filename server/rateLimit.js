/**
 * Minimal in-process sliding-window rate limiter.
 *
 * Deliberately dependency-free and small: it protects the AI endpoint (which
 * costs real provider quota) against accidental loops and casual abuse.
 * For a multi-instance deployment you would move this to Redis, but for a
 * single container it is sufficient and needs no extra service.
 */
export function createRateLimiter({ max = 20, windowMs = 60000, now = Date.now } = {}) {
  /** @type {Map<string, number[]>} key -> timestamps of accepted requests */
  const hits = new Map();

  // Bound memory: drop idle keys periodically.
  const sweep = setInterval(() => {
    const cutoff = now() - windowMs;
    for (const [key, timestamps] of hits) {
      const alive = timestamps.filter((t) => t > cutoff);
      if (alive.length === 0) hits.delete(key);
      else hits.set(key, alive);
    }
  }, Math.max(windowMs, 10000));
  if (typeof sweep.unref === 'function') sweep.unref();

  return {
    /**
     * Register a hit for `key`.
     * @returns {{ allowed: boolean, remaining: number, retryAfter: number, limit: number }}
     */
    check(key) {
      const timestamp = now();
      const cutoff = timestamp - windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

      if (recent.length >= max) {
        const oldest = recent[0];
        const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - timestamp) / 1000));
        hits.set(key, recent);
        return { allowed: false, remaining: 0, retryAfter, limit: max };
      }

      recent.push(timestamp);
      hits.set(key, recent);
      return {
        allowed: true,
        remaining: max - recent.length,
        retryAfter: 0,
        limit: max,
      };
    },

    /** Number of tracked keys - used by tests. */
    get size() {
      return hits.size;
    },

    reset() {
      hits.clear();
    },

    stop() {
      clearInterval(sweep);
    },
  };
}

/**
 * Express middleware wrapper. Uses `app.set('trust proxy', ...)` so the real
 * client IP is respected behind a reverse proxy.
 */
export function rateLimitMiddleware(limiter) {
  return (req, res, next) => {
    const key = clientKey(req);
    const result = limiter.check(key);
    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfter));
      return res.status(429).json({
        error: {
          code: 'rate_limited',
          message: `Too many requests from this device. Please wait ${result.retryAfter} second${
            result.retryAfter === 1 ? '' : 's'
          } and try again.`,
          hint: `This server allows ${result.limit} AI requests per ${Math.round(
            (limiter.windowMs ?? 60000) / 1000,
          )} seconds.`,
          retryAfter: result.retryAfter,
          retryable: true,
        },
      });
    }
    return next();
  };
}

export function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
