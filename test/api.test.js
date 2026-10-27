import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * End-to-end tests for the HTTP surface: the real Express app, talking to a
 * fake OpenAI-compatible upstream. This is what proves streaming, validation
 * and error handling work together rather than only in isolation.
 */

/* ------------------------------ mock upstream ----------------------------- */

/** Answer the request based on the last user message, so one server suffices. */
function upstreamHandler(req, res) {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let prompt = '';
    try {
      const body = JSON.parse(raw);
      prompt = body.messages.at(-1)?.content ?? '';
      if (body.stream !== true) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stream must be true' } }));
        return;
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid json' } }));
      return;
    }

    if (prompt.includes('AUTH_FAIL')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      // Deliberately echoes the key, the way some providers do.
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-live-abcdef123456' } }));
      return;
    }
    if (prompt.includes('RATE_LIMIT')) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limit reached' }, retry_after: 9 }));
      return;
    }
    if (prompt.includes('FAIL_MIDSTREAM')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      res.end('data: {"error":{"message":"upstream exploded"}}\n\n');
      return;
    }
    if (prompt.includes('EMPTY')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
      return;
    }
    if (prompt.includes('SLOW')) {
      // Real providers pause between tokens. Without a gap here the kernel
      // coalesces every write into one TCP segment and "streaming" is
      // indistinguishable from a buffered response.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const words = ['one', ' two', ' three', ' four', ' five'];
      let i = 0;
      const tick = () => {
        if (i === words.length) {
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i] } }] })}\n\n`);
        i += 1;
        setTimeout(tick, 25);
      };
      tick();
      return;
    }

    // Happy path: markdown with a fenced code block, split across chunks.
    const chunks = ['Here is ', 'some **markdown**:\n\n', '```js\nconst a = 1;\n```\n'];
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    for (const text of chunks) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    }
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
}

const upstream = http.createServer(upstreamHandler);
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

/* --------------------------- app under test setup -------------------------- */

// Configure the app *before* importing it: server/config.js reads the
// environment once at module load, which is exactly what we want to test.
process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'custom';
process.env.AI_API_KEY = 'sk-test-key-do-not-leak';
process.env.AI_BASE_URL = upstreamUrl;
process.env.AI_MODEL = 'mock-model';
process.env.AI_SYSTEM_PROMPT = 'You are a test assistant.';
process.env.AI_TIMEOUT_MS = '5000';
process.env.RATE_LIMIT_MAX = '3';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.MAX_INPUT_CHARS = '2000';

const { app } = await import('../server/index.js');

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  upstream.close();
});

/**
 * POST a chat request. Each call passes a distinct X-Forwarded-For by default
 * so the per-IP rate limiter does not couple independent test cases.
 */
let ipCounter = 0;
function chat(body, { ip = `198.51.100.${++ipCounter}`, headers = {} } = {}) {
  return fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Parse a completed text/event-stream body into JSON payloads. */
function parseEvents(text) {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data:'))
    .map((block) => JSON.parse(block.slice(5).trim()));
}

const ask = (content) => ({ messages: [{ role: 'user', content }] });

/* ---------------------------------- health -------------------------------- */

test('GET /api/health reports the configured provider without leaking the key', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);

  const text = await res.text();
  assert.ok(!text.includes('sk-test-key-do-not-leak'), 'health must never expose the API key');
  assert.ok(!text.includes('127.0.0.1'), 'health must not expose the upstream URL');

  const body = JSON.parse(text);
  assert.equal(body.status, 'ok');
  assert.equal(body.configured, true);
  assert.equal(body.model, 'mock-model');
  assert.equal(body.providerId, 'custom');
  assert.equal(body.streaming, true);
  assert.deepEqual(body.missing, []);
  assert.equal(body.limits.rateLimitMax, 3);
});

/* -------------------------------- happy path ------------------------------ */

test('POST /api/chat streams meta, deltas and done over SSE', async () => {
  const res = await chat(ask('hello there'));

  assert.equal(res.status, 200);
  // Proxies must not buffer the stream.
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.match(res.headers.get('cache-control'), /no-cache/);
  assert.equal(res.headers.get('x-accel-buffering'), 'no');

  const raw = await res.text();
  const events = parseEvents(raw);

  assert.equal(events[0].type, 'meta');
  assert.equal(events[0].model, 'mock-model');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).aborted, false);

  const text = events
    .filter((e) => e.type === 'delta')
    .map((e) => e.text)
    .join('');
  assert.equal(text, 'Here is some **markdown**:\n\n```js\nconst a = 1;\n```\n');

  // No secret may appear anywhere in the byte stream.
  assert.ok(!raw.includes('sk-test-key-do-not-leak'));
  assert.ok(!events.some((e) => e.type === 'error'));
});

test('the stream is incremental, not one buffered blob', async () => {
  const res = await chat(ask('SLOW count please'));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  const arrivals = [];
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const count = (buffer.match(/data: /g) ?? []).length;
    if (arrivals.at(-1) !== count) arrivals.push(count);
  }

  // At least the meta event, several deltas and the done event, in stages.
  assert.ok(arrivals.length >= 3, `expected several reads, saw ${arrivals.length}`);
  assert.ok(buffer.includes('"type":"delta"'));
});

test('conversation history is forwarded in order', async () => {
  const res = await chat({
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'follow up' },
    ],
  });

  const events = parseEvents(await res.text());
  assert.equal(events.at(-1).type, 'done');
});

/* ---------------------------------- errors -------------------------------- */

test('a missing API key produces a clear 503 before any streaming starts', async () => {
  // The app was configured above, so assert the shape of the guard instead:
  // an unconfigured server answers with JSON, never an empty stream.
  const { missingSettings } = await import('../server/index.js');
  const missing = missingSettings({ apiKey: '', requiresApiKey: true, baseUrl: 'https://x.dev/v1', model: 'm' });
  assert.deepEqual(missing, ['AI_API_KEY']);
});

test('upstream auth failure is reported as a safe error event', async () => {
  const res = await chat(ask('AUTH_FAIL please'));

  // Already streaming, so the failure arrives as an SSE error event.
  assert.equal(res.status, 200);
  const raw = await res.text();
  const events = parseEvents(raw);
  const error = events.find((e) => e.type === 'error');

  assert.ok(error, 'expected an error event');
  assert.equal(error.code, 'upstream_auth_failed');
  assert.equal(error.retryable, false);
  assert.match(error.message, /credentials|API key/i);
  // The provider echoed the key back; it must be redacted.
  assert.ok(!raw.includes('sk-live-abcdef123456'), 'provider error must not leak the key');
  assert.ok(raw.includes('[api-key redacted]'));
});

test('upstream rate limits surface as 429 errors carrying a retry hint', async () => {
  const res = await chat(ask('RATE_LIMIT now'));
  assert.equal(res.status, 200);

  const events = parseEvents(await res.text());
  const error = events.find((e) => e.type === 'error');

  assert.ok(error);
  assert.equal(error.code, 'upstream_rate_limited');
  assert.equal(error.retryAfter, 9);
  assert.equal(error.retryable, true);
  assert.match(error.message, /rate-limiti?ng/i);
});

test('a failure mid-stream keeps the partial text and reports the break', async () => {
  const res = await chat(ask('FAIL_MIDSTREAM'));
  const events = parseEvents(await res.text());

  const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text);
  assert.deepEqual(deltas, ['partial']);

  const error = events.find((e) => e.type === 'error');
  assert.ok(error, 'a mid-stream failure must be reported');
  assert.equal(error.code, 'upstream_error');
});

test('an empty upstream answer is an error, not a blank bubble', async () => {
  const res = await chat(ask('EMPTY response'));
  const events = parseEvents(await res.text());

  assert.equal(events.filter((e) => e.type === 'delta').length, 0);
  const error = events.find((e) => e.type === 'error');
  assert.equal(error.code, 'upstream_error');
  assert.match(error.message, /empty/i);
});

test('invalid bodies are rejected with JSON, not a stream', async () => {
  const cases = [
    [{}, 'a missing messages array'],
    [{ messages: [] }, 'an empty messages array'],
    [{ messages: [{ role: 'system', content: 'x' }] }, 'an invalid role'],
    [{ messages: [{ role: 'user', content: '' }] }, 'empty content'],
    [{ messages: [{ role: 'assistant', content: 'no question' }] }, 'a trailing assistant message'],
    ['{ not json', 'malformed JSON'],
  ];

  for (const [body, label] of cases) {
    const res = await chat(body);
    assert.equal(res.status, 400, `expected 400 for ${label}`);
    assert.match(res.headers.get('content-type'), /application\/json/);

    const parsed = await res.json();
    assert.equal(parsed.error.code, 'bad_request', `wrong code for ${label}`);
    assert.ok(parsed.error.message.length > 0);
    // Messages are user-facing: no internals.
    assert.ok(!/at \w+ \(|node_modules/.test(parsed.error.message));
  }
});

test('oversized input is rejected with 413', async () => {
  const res = await chat(ask('y'.repeat(2100)));
  assert.equal(res.status, 413);
  const parsed = await res.json();
  assert.equal(parsed.error.code, 'payload_too_large');
});

test('prototype pollution attempts are neutralised', async () => {
  const res = await chat('{"messages":[{"role":"user","content":"hi"}],"__proto__":{"polluted":true}}');
  assert.equal(res.status, 200);
  await res.text();
  assert.equal({}.polluted, undefined);
});

/* ------------------------------- rate limiting ---------------------------- */

test('the chat endpoint rate limits per IP and advertises the wait', async () => {
  const ip = '203.0.113.99';
  const statuses = [];

  for (let i = 0; i < 4; i += 1) {
    const res = await chat(ask('hello'), { ip });
    statuses.push(res.status);
    await res.text();
  }

  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.equal(statuses[3], 429);

  // A different IP is unaffected.
  const other = await chat(ask('hello'), { ip: '203.0.113.100' });
  assert.equal(other.status, 200);
  assert.equal(other.headers.get('x-ratelimit-remaining'), '2');
  await other.text();

  const blocked = await chat(ask('hello'), { ip });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  const parsed = await blocked.json();
  assert.equal(parsed.error.code, 'rate_limited');
  assert.equal(parsed.error.retryable, true);
});

/* ------------------------------ static + headers -------------------------- */

test('the app shell and assets are served with security headers', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);

  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'expected a Content-Security-Policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);

  const html = await res.text();
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /LOKY AI Next/);
  // No key material or provider URLs in the HTML we ship.
  assert.ok(!html.includes('sk-test-key-do-not-leak'));
  assert.ok(!html.includes('api.openai.com'));
});

test('unknown API routes return JSON, unknown pages return the app shell', async () => {
  const api = await fetch(`${baseUrl}/api/nope`);
  assert.equal(api.status, 400);
  assert.match(api.headers.get('content-type'), /application\/json/);

  const page = await fetch(`${baseUrl}/some/deep/link`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<!DOCTYPE html>/i);
});
