import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  buildEndpoint,
  buildHeaders,
  buildPayload,
  extractDelta,
  isDoneSignal,
  parseSSE,
  streamChat,
} from '../server/providers.js';
import { AppError } from '../server/errors.js';

const baseConfig = {
  provider: 'openai',
  providerLabel: 'OpenAI',
  style: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: 'test-key',
  systemPrompt: 'Be helpful.',
  temperature: 0.5,
  maxTokens: 256,
  timeoutMs: 5000,
};

/** Start a throwaway HTTP server that replies with `handler`, return its base URL. */
async function withMockUpstream(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Turn an async generator into an array. */
async function collect(iterator) {
  const out = [];
  for await (const value of iterator) out.push(value);
  return out;
}

test('buildEndpoint targets the right path per wire format', () => {
  assert.equal(buildEndpoint(baseConfig), 'https://api.openai.com/v1/chat/completions');
  assert.equal(
    buildEndpoint({ ...baseConfig, baseUrl: 'https://api.openai.com/v1/', style: 'openai' }),
    'https://api.openai.com/v1/chat/completions',
  );
  assert.equal(
    buildEndpoint({
      ...baseConfig,
      style: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.0-flash',
    }),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
  );
});

test('buildHeaders sends the key in the header the provider expects', () => {
  const bearer = buildHeaders(baseConfig);
  assert.equal(bearer.Authorization, 'Bearer test-key');
  assert.equal(bearer['x-goog-api-key'], undefined);

  const gemini = buildHeaders({ ...baseConfig, style: 'gemini', apiKey: 'g-key' });
  assert.equal(gemini['x-goog-api-key'], 'g-key');
  assert.equal(gemini.Authorization, undefined);

  // Local models need no auth header at all.
  const local = buildHeaders({ ...baseConfig, provider: 'ollama', apiKey: '' });
  assert.equal(local.Authorization, undefined);
});

test('buildPayload puts the system prompt first and requests streaming', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const payload = buildPayload(baseConfig, messages);

  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.stream, true);
  assert.equal(payload.temperature, 0.5);
  assert.equal(payload.max_tokens, 256);
  assert.deepEqual(payload.messages[0], { role: 'system', content: 'Be helpful.' });
  assert.deepEqual(payload.messages[1], { role: 'user', content: 'hi' });
});

test('buildPayload omits the system prompt when unset', () => {
  const payload = buildPayload({ ...baseConfig, systemPrompt: '' }, [
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].role, 'user');
});

test('buildPayload maps assistant -> model for the gemini format', () => {
  const payload = buildPayload({ ...baseConfig, style: 'gemini' }, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ]);

  assert.deepEqual(
    payload.contents.map((c) => c.role),
    ['user', 'model', 'user'],
  );
  assert.deepEqual(payload.contents[0].parts, [{ text: 'hi' }]);
  assert.equal(payload.generationConfig.maxOutputTokens, 256);
  assert.ok(payload.systemInstruction);
});

test('extractDelta reads every supported chunk shape', () => {
  const openai = { choices: [{ delta: { content: 'abc' } }] };
  assert.equal(extractDelta('openai', openai), 'abc');

  const parts = { choices: [{ delta: { content: [{ text: 'a' }, { text: 'b' }] } }] };
  assert.equal(extractDelta('openai', parts), 'ab');

  const legacy = { choices: [{ text: 'legacy' }] };
  assert.equal(extractDelta('openai', legacy), 'legacy');

  const message = { choices: [{ message: { content: 'final' } }] };
  assert.equal(extractDelta('openai', message), 'final');

  const gemini = { candidates: [{ content: { parts: [{ text: 'gem' }, { text: 'ini' }] } }] };
  assert.equal(extractDelta('gemini', gemini), 'gemini');

  // Chunks that carry no text must yield '' rather than undefined.
  assert.equal(extractDelta('openai', { choices: [{ delta: { role: 'assistant' } }] }), '');
  assert.equal(extractDelta('openai', null), '');
  assert.equal(extractDelta('gemini', {}), '');
});

test('isDoneSignal recognises finish reasons', () => {
  assert.equal(isDoneSignal('openai', { choices: [{ finish_reason: 'stop' }] }), true);
  assert.equal(isDoneSignal('openai', { choices: [{ delta: { content: 'x' } }] }), false);
  assert.equal(isDoneSignal('gemini', { candidates: [{ finishReason: 'STOP' }] }), true);
  assert.equal(isDoneSignal('openai', null), false);
});

test('parseSSE splits frames across arbitrary chunk boundaries', async () => {
  const encoder = new TextEncoder();
  const frames = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    ': keep-alive\n\n',
    'data: [DONE]\n\n',
  ];

  async function* body() {
    // Feed one byte at a time to force partial frames.
    for (const frame of frames) {
      for (const byte of encoder.encode(frame)) yield new Uint8Array([byte]);
    }
  }

  const events = await collect(parseSSE(body()));
  const deltas = events.filter((e) => e.data).map((e) => extractDelta('openai', e.data));
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.ok(events.some((e) => e.raw === '[DONE]'));
});

test('streamChat yields deltas from a mock OpenAI-compatible upstream', async () => {
  await withMockUpstream(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"Stream"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"ing"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async (baseUrl) => {
      const deltas = await collect(streamChat({ ...baseConfig, baseUrl }, [{ role: 'user', content: 'hi' }]));
      assert.deepEqual(deltas, ['Stream', 'ing']);
    },
  );
});

test('streamChat forwards the configured model and messages upstream', async () => {
  let received = null;
  await withMockUpstream(
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        received = { method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      });
    },
    async (baseUrl) => {
      await collect(streamChat({ ...baseConfig, baseUrl }, [{ role: 'user', content: 'ping' }]));
    },
  );

  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.auth, 'Bearer test-key');
  assert.equal(received.body.model, 'gpt-4o-mini');
  assert.equal(received.body.stream, true);
  assert.deepEqual(received.body.messages.at(-1), { role: 'user', content: 'ping' });
});

test('streamChat maps an upstream 401 to a safe auth error', async () => {
  await withMockUpstream(
    (req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-secret-value' } }));
    },
    async (baseUrl) => {
      await assert.rejects(
        () => collect(streamChat({ ...baseConfig, baseUrl }, [{ role: 'user', content: 'hi' }])),
        (error) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'upstream_auth_failed');
          assert.equal(error.status, 502);
          return true;
        },
      );
    },
  );
});

test('streamChat maps an upstream 429 and keeps the retry hint', async () => {
  await withMockUpstream(
    (req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limit reached' }, retry_after: 7 }));
    },
    async (baseUrl) => {
      await assert.rejects(
        () => collect(streamChat({ ...baseConfig, baseUrl }, [{ role: 'user', content: 'hi' }])),
        (error) => {
          assert.equal(error.code, 'upstream_rate_limited');
          assert.equal(error.retryAfter, 7);
          assert.equal(error.retryable, true);
          return true;
        },
      );
    },
  );
});

test('streamChat reports a reachable-but-empty answer instead of hanging', async () => {
  await withMockUpstream(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    },
    async (baseUrl) => {
      await assert.rejects(
        () => collect(streamChat({ ...baseConfig, baseUrl }, [{ role: 'user', content: 'hi' }])),
        (error) => {
          assert.equal(error.code, 'upstream_error');
          assert.match(error.message, /empty/i);
          return true;
        },
      );
    },
  );
});

test('streamChat reports an unreachable provider clearly', async () => {
  await assert.rejects(
    // Port 1 on loopback refuses connections.
    () => collect(streamChat({ ...baseConfig, baseUrl: 'http://127.0.0.1:1/v1' }, [{ role: 'user', content: 'hi' }])),
    (error) => {
      assert.equal(error.code, 'upstream_unavailable');
      assert.equal(error.status, 503);
      return true;
    },
  );
});
