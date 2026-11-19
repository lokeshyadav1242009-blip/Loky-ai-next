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
    // Parentheses are required: `??` cannot be mixed with `||` unparenthesised.
    this.retryable = options.retryable ?? (status >= 500 || status === 429);
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

  /**
   * The provider is reachable but the model is busy ("high demand", 503,
   * overload). Transient by nature, so it IS retryable with backoff.
   */
  upstreamOverloaded: (
    retryAfterSeconds = null,
    message = 'The AI model is busy right now. This is temporary - please try again in a moment.',
    hint = null,
  ) =>
    new AppError(503, 'upstream_overloaded', message, {
      hint,
      retryAfter: retryAfterSeconds,
      retryable: true,
    }),

  /**
   * The request itself is wrong (bad role order, unsupported parameter, model
   * refusing images, ...). Retrying the identical request cannot help, so this
   * is explicitly NOT retryable.
   */
  upstreamInvalid: (
    hint = null,
    message = 'The AI provider rejected this request as invalid.',
  ) => new AppError(502, 'upstream_invalid_request', message, { hint, retryable: false }),

  /** The provider account is out of credits/quota. Needs human action. */
  upstreamQuota: (hint = null) =>
    new AppError(
      502,
      'upstream_quota_exhausted',
      'The AI provider account is out of quota or credits for this model.',
      { hint, retryable: false },
    ),

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
export function mapUpstreamError(status, body, config = {}, retryAfterHeader = null) {
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

  // ---------------------------------------------------------------------
  // Classify the REAL reason before trusting the status code.
  //
  // Gemini reports overload and quota conditions with 400/429/503 and puts the
  // truth in error.status / error.details[].reason. Without this check, a
  // "model is experiencing high demand" reply was reported to the user as
  // "the provider rejected the request as invalid" - wrong, and unretryable.
  // ---------------------------------------------------------------------
  const kind = classifyUpstream(status, body);

  if (kind === 'overload') {
    return errors.upstreamOverloaded(
      extractRetryAfter(body, retryAfterHeader),
      `The AI model${config.model ? ` "${config.model}"` : ''} is busy right now. This is temporary - please try again in a moment.`,
      detail
        ? `Provider message: ${detail}`
        : 'Demand spikes are usually short. Retrying shortly normally works.',
    );
  }

  if (kind === 'quota') {
    return errors.upstreamQuota(
      detail
        ? `Provider message: ${detail}`
        : 'Add credits, or switch AI_MODEL / AI_PROVIDER to a free option.',
    );
  }

  if (status === 429) {
    const retryAfter = extractRetryAfter(body, retryAfterHeader);
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

/**
 * Work out WHY the provider refused, instead of trusting the HTTP status alone.
 *
 * Google-style payloads carry the real condition in `error.status`:
 *   RESOURCE_EXHAUSTED -> rate limit or account quota (never "invalid")
 *   UNAVAILABLE        -> model busy / high demand (transient, retryable)
 *   INVALID_ARGUMENT   -> genuinely malformed request (retry cannot help)
 *
 * Exported so the classification itself can be unit tested.
 *
 * @returns {'auth'|'quota'|'overload'|'rate_limit'|'not_found'|'invalid'|'server'|'unknown'}
 */
export function classifyUpstream(status, body) {
  const providerStatus = String(body?.error?.status ?? '').toUpperCase();
  const reason = extractReason(body).toUpperCase();
  const message = extractDetail(body).toLowerCase();

  const quotaish =
    /quota|billing|credits?\b|exceeded your current|payment required/.test(message) ||
    /QUOTA|BILLING|CREDIT/.test(reason);
  const demandish =
    /high demand|overloaded|over capacity|spike in demand|temporarily unavailable|service unavailable|try again later/.test(
      message,
    );
  const ratelimitish =
    /rate limit|too many requests|requests per|per-minute|per minute/.test(message) ||
    /RATE_LIMIT/.test(reason);

  if (
    status === 401 ||
    status === 403 ||
    providerStatus === 'UNAUTHENTICATED' ||
    providerStatus === 'PERMISSION_DENIED'
  ) {
    return 'auth';
  }
  if (status === 402 || quotaish) return 'quota';
  // Checked before the 429 branch: a 429 that says "high demand" is an overload,
  // and saying so is more useful than claiming a rate limit.
  if (demandish) return 'overload';
  if (ratelimitish) return 'rate_limit';
  if (status === 429 || providerStatus === 'RESOURCE_EXHAUSTED') return 'rate_limit';
  if (
    providerStatus === 'UNAVAILABLE' ||
    providerStatus === 'DEADLINE_EXCEEDED' ||
    status === 503 ||
    status === 504 ||
    status === 529
  ) {
    return 'overload';
  }
  if (status === 404 || providerStatus === 'NOT_FOUND') return 'not_found';
  if (
    status === 400 ||
    status === 422 ||
    providerStatus === 'INVALID_ARGUMENT' ||
    providerStatus === 'FAILED_PRECONDITION'
  ) {
    return 'invalid';
  }
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * Structured, secret-free description of an upstream failure for the server log.
 * Never includes headers or the API key.
 */
export function describeUpstream(status, body, config = {}) {
  return {
    status,
    kind: classifyUpstream(status, body),
    providerStatus: String(body?.error?.status ?? '').slice(0, 40) || null,
    reason: extractReason(body).slice(0, 60) || null,
    model: config.model ?? null,
    style: config.style ?? null,
    detail: extractDetail(body).slice(0, 160) || null,
  };
}

/**
 * Machine-readable reason from a Google-style payload:
 * `error.details[] = { reason: 'RATE_LIMIT_EXCEEDED', ... }`.
 */
export function extractReason(body) {
  const details = body?.error?.details;
  if (!Array.isArray(details)) return '';
  for (const entry of details) {
    const reason = entry?.reason ?? entry?.errorInfo?.reason;
    if (typeof reason === 'string' && reason.trim()) return reason.trim();
  }
  return '';
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

/**
 * Token-shaped strings that must never reach the browser.
 * Some providers echo the offending key back in their error message, and that
 * message is forwarded to the client - so redact before it travels any further.
 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\bgsk_[A-Za-z0-9_-]{6,}/g,
  /\bxai-[A-Za-z0-9_-]{6,}/g,
  /\bAIza[A-Za-z0-9_-]{6,}/g,
  /\b(?:tgp_v1|hf)_[A-Za-z0-9_-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
];

/** Remove anything that looks like an API key or bearer token. */
export function redact(text) {
  if (typeof text !== 'string') return '';
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[api-key redacted]'), text);
}

function clamp(text, max = 240) {
  const single = redact(String(text).replace(/\s+/g, ' ').trim());
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/**
 * Pull a retry delay out of an upstream rate-limit response.
 *
 * The hint lives in the JSON body for some providers and in the `Retry-After`
 * header for OpenAI-compatible ones, so both are accepted. The header may be
 * either a number of seconds or an HTTP date.
 */
function extractRetryAfter(body, retryAfterHeader = null) {
  const raw =
    body && typeof body === 'object'
      ? body.retry_after ?? body.retryAfter ?? body?.error?.retry_after
      : null;
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed);

  if (retryAfterHeader) {
    const asSeconds = Number.parseFloat(retryAfterHeader);
    if (Number.isFinite(asSeconds) && asSeconds > 0) return Math.ceil(asSeconds);

    const asDate = Date.parse(retryAfterHeader);
    if (Number.isFinite(asDate)) {
      const seconds = Math.ceil((asDate - Date.now()) / 1000);
      if (seconds > 0) return seconds;
    }
  }

  return null;
}
