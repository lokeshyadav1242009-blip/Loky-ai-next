import { AppError, errors, mapUpstreamError, describeUpstream } from './errors.js';

/**
 * Provider-agnostic streaming client.
 *
 * Two wire formats are supported, which together cover essentially every
 * hosted or local option:
 *   - "openai":  POST {baseUrl}/chat/completions  (OpenAI, Groq, OpenRouter,
 *                Mistral, Together, DeepSeek, Ollama, vLLM, LM Studio, ...)
 *   - "gemini":  POST {baseUrl}/models/{model}:streamGenerateContent
 *
 * Adding a provider later therefore means: set AI_PROVIDER / AI_BASE_URL /
 * AI_MODEL / AI_API_KEY (and AI_STYLE if it is not OpenAI-compatible).
 */

/** Build the upstream URL for the configured provider. */
export function buildEndpoint({ baseUrl, model, style }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  if (style === 'gemini') {
    return `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  }
  return `${base}/chat/completions`;
}

/** Build request headers, never logging or echoing the key. */
export function buildHeaders({ style, apiKey, provider }) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (apiKey) {
    if (style === 'gemini') {
      headers['x-goog-api-key'] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }
  if (provider === 'openrouter') {
    // OpenRouter uses these for its free-tier attribution. Overridable by env.
    headers['HTTP-Referer'] = process.env.APP_PUBLIC_URL || 'https://loky-ai-next.app';
    headers['X-Title'] = 'LOKY AI Next';
  }
  return headers;
}

/**
 * Convert internal chat messages into the provider's payload.
 * `messages` is a validated array of { role: 'user'|'assistant', content }.
 */
export function buildPayload(config, messages, options = {}) {
  const { style, model, systemPrompt, temperature, maxTokens } = config;
  // Optional second system block (LOKY MEMORY). Kept separate from
  // systemPrompt so every existing payload shape — and its tests — stays
  // byte-identical when no extra context is supplied.
  const systemExtra =
    typeof options.systemExtra === 'string' ? options.systemExtra.trim() : '';

  if (style === 'gemini') {
    return {
      contents: sanitizeGeminiContents(messages),
      ...(systemPrompt || systemExtra
        ? {
            systemInstruction: {
              parts: [
                ...(systemPrompt ? [{ text: systemPrompt }] : []),
                ...(systemExtra ? [{ text: systemExtra }] : []),
              ],
            },
          }
        : {}),
      generationConfig: sanitizeGenerationConfig(temperature, maxTokens),
    };
  }

  const payloadMessages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...(systemExtra ? [{ role: 'system', content: systemExtra }] : []),
    ...messages.map(toOpenAiMessage),
  ];

  return {
    model,
    messages: payloadMessages,
    stream: true,
    temperature,
    max_tokens: maxTokens,
  };
}

/**
 * Gemini content parts for one internal message.
 *
 * Images travel as inlineData (raw base64 bytes) — never as a file name or a
 * URL — so the model genuinely receives the picture. An image-only turn keeps
 * at least one part, because Gemini rejects an empty parts array.
 */
export function buildGeminiParts(message) {
  const parts = [];
  const text = typeof message?.content === 'string' ? message.content : '';
  if (text) parts.push({ text });
  for (const image of Array.isArray(message?.images) ? message.images : []) {
    if (!image?.data || !image?.mimeType) continue;
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  }
  if (parts.length === 0) parts.push({ text: '' });
  return parts;
}

/**
 * Normalise Gemini `contents` before sending.
 *
 * Gemini rejects a request whose first turn is a model turn, whose `parts` array
 * is empty, or that repeats a role in a way it cannot merge. Trimming a long
 * conversation to a recent window produces exactly those shapes, which used to
 * surface as "the provider rejected the request as invalid".
 */
export function sanitizeGeminiContents(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const parts = buildGeminiParts(message);
    if (!parts.length) continue;
    const role = message?.role === 'assistant' ? 'model' : 'user';
    const previous = out[out.length - 1];
    if (previous && previous.role === role) {
      // Merge consecutive same-role turns instead of sending an invalid shape.
      previous.parts.push(...parts);
      continue;
    }
    out.push({ role, parts });
  }

  while (out.length > 1 && out[0].role === 'model') out.shift();
  if (out.length === 1 && out[0].role === 'model') {
    out.unshift({ role: 'user', parts: [{ text: 'Continue.' }] });
  }
  return out;
}

/** Clamp generation parameters into the range the provider accepts. */
export function sanitizeGenerationConfig(temperature, maxTokens) {
  const temp = Number(temperature);
  const tokens = Number(maxTokens);
  return {
    temperature: Number.isFinite(temp) ? Math.min(Math.max(temp, 0), 2) : 0.7,
    maxOutputTokens: Number.isFinite(tokens)
      ? Math.min(Math.max(Math.round(tokens), 1), 8192)
      : 2048,
  };
}

/** OpenAI-compatible content: text plus data-URL image parts when present. */
function toOpenAiMessage(message) {
  const images = Array.isArray(message?.images) ? message.images : [];
  if (images.length === 0) {
    return { role: message.role, content: message.content };
  }
  const content = [];
  if (message.content) content.push({ type: 'text', text: message.content });
  for (const image of images) {
    if (!image?.data || !image?.mimeType) continue;
    content.push({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    });
  }
  return { role: message.role, content };
}

/**
 * Extract the incremental text from one parsed SSE JSON chunk.
 * Returns '' for chunks that carry no content (role deltas, keep-alives, ...).
 */
export function extractDelta(style, chunk) {
  if (!chunk || typeof chunk !== 'object') return '';

  if (style === 'gemini') {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  }

  const choice = chunk?.choices?.[0];
  if (!choice) return '';
  const delta = choice.delta ?? choice.message;
  if (typeof delta?.content === 'string') return delta.content;
  // Some providers send an array of content parts instead of a string.
  if (Array.isArray(delta?.content)) {
    return delta.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  }
  // Legacy completions shape.
  if (typeof choice.text === 'string') return choice.text;
  return '';
}

/** True when the chunk signals end of stream. */
export function isDoneSignal(style, chunk) {
  if (!chunk || typeof chunk !== 'object') return false;
  if (style === 'gemini') {
    return Boolean(chunk?.candidates?.[0]?.finishReason);
  }
  const choice = chunk?.choices?.[0];
  return Boolean(choice?.finish_reason);
}

/**
 * Incrementally parse a text/event-stream body into data objects.
 * Yields { data, raw } for every `data:` line; `[DONE]` is yielded as raw.
 */
export async function* parseSSE(stream) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    let index = buffer.indexOf('\n');
    while (index !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data) {
          if (data === '[DONE]') {
            yield { raw: '[DONE]', data: null };
          } else {
            try {
              yield { raw: data, data: JSON.parse(data) };
            } catch {
              // Ignore malformed keep-alive / partial frames.
            }
          }
        }
      }
      index = buffer.indexOf('\n');
    }
  }
}

/**
 * Stream a chat completion.
 *
 * Yields text deltas (strings) and finishes normally at end-of-stream.
 * Throws AppError with a user-safe message on failure.
 */
async function* streamOnce(config, messages, options = {}, state = null) {
  const { signal } = options;
  const endpoint = buildEndpoint(config);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw errors.badRequest('The request was cancelled.');
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const timeout = setTimeout(() => controller.abort('timeout'), config.timeoutMs);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(buildPayload(config, messages, options)),
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (error) {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (signal?.aborted) return;
    if (error?.name === 'AbortError') {
      throw errors.timeout(Math.round(config.timeoutMs / 1000));
    }
    throw errors.upstreamUnavailable(
      `Could not reach ${safeHost(config.baseUrl)}. Check AI_BASE_URL and that the service is online.`,
    );
  }

  if (!response.ok) {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
    const body = await safeJson(response);
    logUpstream('upstream_error', describeUpstream(response.status, body, config));
    throw mapUpstreamError(
      response.status,
      body,
      config,
      response.headers.get('retry-after'),
    );
  }

  if (!response.body) {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
    throw errors.upstreamError('The AI service returned an empty response.');
  }

  let sawContent = false;
  let finishReason = '';
  try {
    for await (const event of parseSSE(response.body)) {
      if (event.raw === '[DONE]') break;
      if (event.data?.error) {
        throw mapUpstreamError(400, event.data, config);
      }
      if (event.data?.candidates?.[0]?.finishReason) {
        finishReason = event.data.candidates[0].finishReason;
      }
      const delta = extractDelta(config.style, event.data);
      if (delta) {
        sawContent = true;
        if (state) state.yielded = true;
        yield delta;
      }
    }
  } catch (error) {
    if (signal?.aborted) return;
    if (error instanceof AppError) throw error;
    if (error?.name === 'AbortError') {
      throw errors.timeout(Math.round(config.timeoutMs / 1000));
    }
    throw errors.upstreamError(
      'The connection to the AI service was interrupted while streaming.',
      'This is usually a network hiccup - try again.',
    );
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!sawContent) {
    // Distinguish "the model refused" from "the model is busy and sent nothing".
    // The busy case is retryable; the blocked case never is.
    const blocked = ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(
      String(finishReason).toUpperCase(),
    );
    if (blocked) {
      throw new AppError(
        502,
        'content_blocked',
        'The AI model declined to answer because of its safety filters.',
        {
          hint: 'Try rephrasing the request, or remove the part that was refused.',
          retryable: false,
        },
      );
    }
    throw errors.upstreamOverloaded(
      null,
      'The AI model returned an empty answer - it may be busy right now. Please try again.',
    );
  }
}

/** Failures that can genuinely succeed on a second attempt. */
const RETRYABLE_CODES = new Set([
  'upstream_rate_limited',
  'upstream_overloaded',
  'upstream_unavailable',
  'upstream_error',
]);

/** True only for transient provider failures - never for invalid requests. */
export function isRetryableUpstream(error) {
  if (!(error instanceof AppError)) return false;
  if (error.retryable !== true) return false;
  return RETRYABLE_CODES.has(error.code);
}

/** Exponential backoff with jitter, honouring a provider Retry-After hint. */
export function backoffDelayMs(attempt, retryAfterSeconds) {
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 15000);
  }
  const base = 700 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base + Math.floor(Math.random() * 250), 8000);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

/** Secret-free structured diagnostics for the server log. */
export function logUpstream(event, data = {}) {
  try {
    console.warn(`[ai] ${event} ${JSON.stringify(data)}`);
  } catch {
    /* logging must never break a request */
  }
}

/**
 * Stream a chat completion, retrying TRANSIENT failures with exponential
 * backoff. A retry only happens before the first token reaches the client, so
 * the browser can never receive duplicated partial text.
 */
export async function* streamChat(config, messages, options = {}) {
  const maxAttempts = Math.max(
    1,
    Math.min(Number(options.maxAttempts ?? config.maxAttempts ?? 3) || 3, 4),
  );

  for (let attempt = 1; ; attempt += 1) {
    const state = { yielded: false };
    try {
      for await (const delta of streamOnce(config, messages, options, state)) {
        state.yielded = true;
        yield delta;
      }
      return;
    } catch (error) {
      const canRetry =
        !state.yielded &&
        attempt < maxAttempts &&
        !options.signal?.aborted &&
        isRetryableUpstream(error);

      if (!canRetry) throw error;

      const wait = backoffDelayMs(attempt, error.retryAfter);
      logUpstream('retrying', {
        attempt,
        maxAttempts,
        waitMs: wait,
        code: error.code,
        model: config.model ?? null,
      });
      await sleep(wait, options.signal);
      if (options.signal?.aborted) return;
    }
  }
}

function safeHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'the configured AI endpoint';
  }
}

async function safeJson(response) {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
