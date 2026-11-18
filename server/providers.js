import { AppError, errors, mapUpstreamError } from './errors.js';

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
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: buildGeminiParts(m),
      })),
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
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
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
export async function* streamChat(config, messages, options = {}) {
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
  try {
    for await (const event of parseSSE(response.body)) {
      if (event.raw === '[DONE]') break;
      if (event.data?.error) {
        throw mapUpstreamError(400, event.data, config);
      }
      const delta = extractDelta(config.style, event.data);
      if (delta) {
        sawContent = true;
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
    throw errors.upstreamError(
      'The AI service returned an empty answer.',
      'The model may have refused or the provider may have changed its response format.',
    );
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
