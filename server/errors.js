/**
 * Typed application errors that map cleanly onto HTTP responses.
 *
 * The frontend renders `message` verbatim, so every message must be safe to
 * show to a user (no keys, no internal URLs, no stack traces) and actionable.
 */
export class AppError extends Error {
  constructor(status, code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.retryAfter = options.retryAfter ?? null;
    this.hint = options.hint ?? null;
    this.providerStatus = options.providerStatus ?? null;
    this.retryable = options.retryable ?? status >= 500 || status === 429;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        hint: this.hint,
        retryAfter: this.retryAfter,
        retryable: this.retryable,
      },
    };
  }
}

export const errors = {
  badRequest: (message = 'The request could not be understood.', hint = null) =>
    new AppError(400, 'bad_request', message, { hint, retryable: false }),

  tooLarge: (message, hint = null) =>
    new AppError(413, 'payload_too_large', message, { hint, retryable: false }),

  rateLimited: (retryAfterSeconds, message, hint = null) =>
    new AppError(429, 'rate_limited', message, {
      hint,
      retryAfter: retryAfterSeconds,
      retryable: true,
    }),

  notConfigured: (message, hint = null) =>
    new AppError(503, 'ai_not_configured', message, { hint, retryable: false }),

  upstreamRateLimited: (retryAfterSeconds, message, hint = null) =>
    new AppError(429, 'upstream_rate_limited', message, {
      hint,
      retryAfter: retryAfterSeconds,
      retryable: true,
    }),

  upstreamAuth: (hint = null) =>
    new AppError(
      502,
      'upstream_auth_failed',
      'The AI service rejected our credentials. The server API key is missing, invalid or expired.',
      { hint, retryable: false },
    ),

  upstreamUnavailable: (hint = null) =>
    new AppError(
      503,
      'upstream_unavailable',
      'The AI service is unreachable right now. This is usually temporary.',
      { hint, retryable: true },
    ),

  upstreamError: (message = 'The AI service returned an unexpected error.', hint = null) =>
    new AppError(502, 'upstream_error', message, { hint, retryable: true }),

  timeout: (seconds, hint = null) =>
    new AppError(
      504,
      'upstream_timeout',
      `The AI service did not respond within ${seconds} second${seconds === 1 ? '' : 's'}.`,
      { hint, retryable: true },
    ),

  internal: (hint = null) =>
    new AppError(500, 'internal_error', 'Something went wrong on the server.', {
      hint,
      retryable: true,
    }),
};

/**
 * Convert an upstream HTTP failure into an AppError with a friendly message.
 * Exported for unit testing.
 */
export function mapUpstreamError(status, body, config = {}) {
  const detail = extractDetail(body);
  const keyHint =
    status === 401 || status === 403
      ? 'Check that the API key in your server environment is correct and has access to the selected model.'
      : null;

  if (status === 401 || status === 403) {
    const err = errors.upstreamAuth(keyHint);
    if (detail) err.message = `${err.message} (provider said: ${detail})`;
    return err;
  }

  if (status === 429) {
    const retryAfter = extractRetryAfter(body);
    return errors.upstreamRateLimited(
      retryAfter,
      `The AI provider is rate-limiting requests right now${
        config.model ? ` for model "${config.model}"` : ''
      }. Please wait a moment and try again.`,
      detail
        ? `Provider message: ${detail}`
        : 'Free tiers have per-minute and per-day token limits. Waiting a little usually fixes this.',
    );
  }

  if (status === 402) {
    return errors.upstreamError(
      'The AI provider reports that this account is out of credits or quota.',
      detail || 'Add credits or switch AI_PROVIDER to a free provider such as Ollama or OpenRouter free models.',
    );
  }

  if (status === 404) {
    return errors.upstreamError(
      `The AI provider could not find the requested model${config.model ? ` "${config.model}"` : ''}.`,
      'Check the AI_MODEL and AI_BASE_URL environment variables.',
    );
  }

  if (status === 400 || status === 422) {
    return errors.upstreamError(
      'The AI provider rejected the request as invalid.',
      detail || 'The conversation may contain content the selected model does not accept.',
    );
  }

  if (status >= 500) {
    const err = errors.upstreamUnavailable(
      'The provider is having an outage. Retry in a few seconds.',
    );
    if (detail) err.message = `${err.message} (provider said: ${detail})`;
    return err;
  }

  return errors.upstreamError(
    'The AI service returned an unexpected response.',
    detail || `Upstream status ${status}.`,
  );
}

/** Pull a human readable message out of an arbitrary provider error payload. */
export function extractDetail(body) {
  if (!body) return '';
  let value = body;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
      value = JSON.parse(trimmed);
    } catch {
      return clamp(trimmed);
    }
  }
  if (typeof value !== 'object') return '';

  const candidates = [
    value?.error?.message,
    value?.error?.error?.message,
    Array.isArray(value?.error) ? value.error[0]?.message : null,
    value?.message,
    value?.detail,
    value?.error,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return clamp(candidate.trim());
  }
  return '';
}

function clamp(text, max = 240) {
  const single = String(text).replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function extractRetryAfter(body) {
  const raw =
    body && typeof body === 'object'
      ? body.retry_after ?? body.retryAfter ?? body?.error?.retry_after
      : null;
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed);
  return null;
}
