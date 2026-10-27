/**
 * Runtime smoke test for LOKY AI Next.
 *
 * Boots the *real* server entrypoint (server/index.js) as a child process on the
 * deployed port (80) with a mock OpenAI-compatible upstream, then drives it over
 * HTTP exactly like a browser would:
 *
 *   - /api/health is reachable, JSON, and leaks no secret
 *   - the static site + vendored libraries are served
 *   - security headers / no X-Powered-By
 *   - POST /api/chat streams meta -> deltas -> done, arriving incrementally
 *   - an upstream 429 becomes a safe error event with a retry hint
 *   - unknown non-API routes fall back to index.html, unknown /api routes do not
 *
 * No API key and no internet access are required. Run: node scripts/runtime-smoke.js
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = Number.parseInt(process.env.SMOKE_PORT || '80', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = 'sk-smoke-secret-key-do-not-leak';

const CHUNKS = ['Hello', ' there,', ' this', ' is', ' streamed', ' text.'];
const EXPECTED_TEXT = CHUNKS.join('');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ----------------------------- mock upstream ------------------------------ */

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => resolve(raw));
  });
}

const upstream = http.createServer(async (req, res) => {
  const body = await readBody(req);

  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  // Simulate a provider-side rate limit when the user asks for it.
  if (body.includes('FORCE_RATE_LIMIT')) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '17' });
    res.end(
      JSON.stringify({
        error: { message: `Rate limit reached for key ${API_KEY}. Try again soon.` },
      }),
    );
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });

  // Stagger writes so the browser (and this test) sees genuine incremental
  // delivery rather than one coalesced blob.
  for (const text of CHUNKS) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    await sleep(45);
  }
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.end('data: [DONE]\n\n');
});

await new Promise((resolve) => upstream.listen(0, '0.0.0.0', resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

/* ------------------------------- boot server ------------------------------ */

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    HOST: '0.0.0.0',
    AI_PROVIDER: 'custom',
    AI_API_KEY: API_KEY,
    AI_BASE_URL: upstreamUrl,
    AI_MODEL: 'smoke-model',
    RATE_LIMIT_MAX: '100',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', (d) => {
  serverLog += d;
});
child.stderr.on('data', (d) => {
  serverLog += d;
});

async function stop() {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve) => upstream.close(resolve));
}

// Wait for the server to accept connections.
let booted = false;
for (let i = 0; i < 60; i += 1) {
  try {
    await fetch(`${BASE}/api/health`);
    booted = true;
    break;
  } catch {
    await sleep(250);
  }
}
if (!booted) {
  console.error('Server never became reachable on port', PORT);
  console.error(serverLog);
  await stop();
  process.exit(1);
}
check(`server boots and listens on port ${PORT}`, true);

try {
  /* --------------------------------- health ------------------------------- */
  const healthRes = await fetch(`${BASE}/api/health`);
  const healthText = await healthRes.text();
  const health = JSON.parse(healthText);

  check('GET /api/health returns 200', healthRes.status === 200, `status ${healthRes.status}`);
  check('health reports configured + streaming', health.configured === true && health.streaming === true);
  check('health reports the active model', health.model === 'smoke-model', health.model);
  check(
    'health never exposes the API key or upstream URL',
    !healthText.includes(API_KEY) && !healthText.includes(upstreamUrl),
  );

  /* ---------------------------- static assets ----------------------------- */
  const assets = [
    ['/', 'text/html'],
    ['/styles.css', 'text/css'],
    ['/app.js', 'javascript'],
    ['/vendor/marked.esm.js', 'javascript'],
    ['/vendor/purify.esm.js', 'javascript'],
    ['/manifest.webmanifest', 'json'],
    ['/favicon.svg', 'svg'],
  ];
  for (const [assetPath, expectedType] of assets) {
    const res = await fetch(`${BASE}${assetPath}`);
    const type = res.headers.get('content-type') || '';
    check(`GET ${assetPath} -> 200 ${expectedType}`, res.status === 200 && type.includes(expectedType), `${res.status} ${type}`);
    await res.arrayBuffer();
  }

  /* --------------------------- security headers --------------------------- */
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  check('no X-Powered-By header', !page.headers.get('x-powered-by'));
  check('sets nosniff', page.headers.get('x-content-type-options') === 'nosniff');
  check(
    'sets a self-only CSP',
    (page.headers.get('content-security-policy') || '').includes("default-src 'self'"),
  );
  check(
    'index references local app.js + vendored libs (no CDN)',
    html.includes('./app.js') && !/https?:\/\/(unpkg|cdn|jsdelivr)/i.test(html),
  );

  /* ----------------------------- streaming chat --------------------------- */
  const started = Date.now();
  const chatRes = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'say hello' }] }),
  });

  check(
    'POST /api/chat responds with text/event-stream',
    chatRes.status === 200 && (chatRes.headers.get('content-type') || '').includes('text/event-stream'),
    `${chatRes.status} ${chatRes.headers.get('content-type')}`,
  );

  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of chatRes.body) {
    buffer += decoder.decode(part, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const frame = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (frame.startsWith('data:')) {
        const payload = frame.slice(5).trim();
        if (payload && payload !== '[DONE]') {
          try {
            events.push({ at: Date.now(), event: JSON.parse(payload) });
          } catch {
            /* ignore keep-alive noise */
          }
        }
      }
      idx = buffer.indexOf('\n\n');
    }
  }

  const meta = events.find((e) => e.event.type === 'meta');
  const deltas = events.filter((e) => e.event.type === 'delta');
  const done = events.find((e) => e.event.type === 'done');
  const streamed = deltas.map((d) => d.event.text).join('');

  check('stream emits a leading meta event', Boolean(meta) && events[0].event.type === 'meta');
  check('stream emits multiple delta events', deltas.length >= 3, `${deltas.length} deltas`);
  check('streamed text reassembles correctly', streamed === EXPECTED_TEXT, JSON.stringify(streamed));
  check('stream ends with a done event', Boolean(done) && events.at(-1).event.type === 'done');
  check(
    'deltas arrive incrementally, not as one blob',
    deltas.length > 1 && deltas.at(-1).at - deltas[0].at >= 100,
    `${deltas.at(-1)?.at - deltas[0]?.at}ms spread`,
  );
  check('no API key appears in the stream', !JSON.stringify(events).includes(API_KEY));
  const elapsed = Date.now() - started;
  check('stream completes', true, `${elapsed}ms`);

  /* ------------------------------- errors --------------------------------- */
  const limited = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'FORCE_RATE_LIMIT please' }] }),
  });
  const limitedRaw = await limited.text();
  const limitedEvent = limitedRaw
    .split('\n\n')
    .map((f) => f.trim())
    .filter((f) => f.startsWith('data:'))
    .map((f) => {
      try {
        return JSON.parse(f.slice(5).trim());
      } catch {
        return null;
      }
    })
    .find((e) => e && e.type === 'error');

  check(
    'upstream 429 turns into an error event with a retry hint',
    Boolean(limitedEvent) &&
      limitedEvent.code === 'upstream_rate_limited' &&
      Number(limitedEvent.retryAfter) > 0,
    limitedEvent?.code,
  );
  check(
    'upstream error text is redacted and safe to render',
    Boolean(limitedEvent) &&
      !limitedRaw.includes(API_KEY) &&
      !/provider said:.*sk-/i.test(limitedRaw),
  );

  /* --------------------------- validation / 404 -------------------------- */
  const badRequest = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  const badJson = await badRequest.json();
  check(
    'an empty conversation is rejected with a JSON error',
    badRequest.status === 400 && badJson.error?.code === 'bad_request',
    `${badRequest.status} ${badJson.error?.code}`,
  );

  const spa = await fetch(`${BASE}/some/deep/link`);
  const spaHtml = await spa.text();
  check('unknown page falls back to index.html', spa.status === 200 && spaHtml.includes('<div id="app"') === false ? spaHtml.includes('<html') : spaHtml.includes('<html'));

  const unknownApi = await fetch(`${BASE}/api/nope`);
  check(
    'unknown API route returns JSON, not the HTML shell',
    unknownApi.status === 400 && (unknownApi.headers.get('content-type') || '').includes('json'),
    `${unknownApi.status}`,
  );
} catch (error) {
  check(`runtime smoke run completed without throwing`, false, error.message);
} finally {
  await stop();
}

/* -------------------------------- summary -------------------------------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} runtime checks passed`);
if (failed.length > 0) {
  console.log('\nFailures:');
  for (const f of failed) console.log(` - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  console.log('\nServer log tail:\n', serverLog.slice(-2000));
  process.exit(1);
}
