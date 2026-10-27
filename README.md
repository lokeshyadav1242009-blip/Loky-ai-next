# LOKY AI Next

A mobile-first AI assistant web app by **Lokesh Yadav**. Dark interface, token-by-token
streaming replies, Markdown and syntax-highlighted code blocks with copy buttons, and
persistent chat history.

The AI provider is configured **entirely on the server**. No API key ever reaches the
browser — the frontend only talks to this app's own `/api/chat` endpoint.

---

## Features

- **Streaming answers** — replies arrive over Server-Sent Events and render token by token.
- **Markdown** — headings, lists, tables, links, inline code.
- **Code blocks** — fenced code with a copy button on every block (and on every message).
- **Chat history** — conversations are saved in `localStorage`; start a new chat at any time,
  or revisit, export and delete previous ones. Every entry shows a **title** and a
  **relative timestamp** (plus an exact one on hover); rename a conversation inline with
  the pencil button (Enter commits, Escape cancels).
- **Owner branding** — the **LOKY AI** wordmark appears prominently in the welcome screen
  and in an **About** dialog that credits *Created by Lokesh Yadav*. The dark theme is
  unchanged.
- **Opening animation** — a smooth ~2-second intro with the LOKY AI mark, a subtle glow and
  the *Created by Lokesh Yadav* credit, fading straight into the chat screen. It plays
  **only when the app opens** (never on new chat, conversation switch or message send) and
  is skipped entirely for users who prefer reduced motion.
- **Configurable provider** — switch between OpenAI, Groq, OpenRouter, Mistral, Together,
  DeepSeek, Google Gemini, a local Ollama server, or any OpenAI-compatible endpoint using
  environment variables only.
- **Clear failure states** — missing configuration, bad credentials, provider rate limits
  (with a retry hint), timeouts and mid-stream drops all produce readable messages instead of
  a silent hang.
- **Safe by default** — strict security headers and CSP, input validation with size limits,
  per-IP rate limiting, and API-key redaction on upstream errors that echo the key back.
- **No build step** — plain HTML/CSS/JS frontend; `marked` and `DOMPurify` are served
  locally from `public/vendor` (no CDN, no bundler).

---

## Requirements

- Node.js **20 or newer**
- An API key from one of the supported providers (not required for local Ollama)

---

## Setup

```bash
npm install          # installs deps and vendors marked + DOMPurify into public/vendor
cp .env.example .env # then edit .env and add your key
npm start            # http://localhost:3000
```

For development with automatic restarts on file changes:

```bash
npm run dev
```

Check that the server is configured correctly:

```bash
curl -s http://localhost:3000/api/health
```

A healthy, configured server returns `200` with `"status":"ok"`. If the key is missing it
returns `503` with `"status":"unconfigured"` and lists what is missing — the UI shows this
state instead of failing silently. The response never includes the key itself.

---

## Configuration

Everything lives in `.env` (gitignored). `.env.example` documents every variable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_PROVIDER` | `openai` | Preset name: `openai`, `groq`, `openrouter`, `mistral`, `together`, `deepseek`, `gemini`, `ollama`, `custom` |
| `AI_API_KEY` | _(empty)_ | API key. If empty, the preset's conventional variable is used (`OPENAI_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, …) |
| `AI_BASE_URL` | preset default | Override the API endpoint |
| `AI_MODEL` | preset default | Override the model name |
| `AI_SYSTEM_PROMPT` | built-in | Override the assistant's system prompt |
| `AI_TEMPERATURE` | `0.7` | Sampling temperature (0–2) |
| `AI_MAX_TOKENS` | `2048` | Max tokens per reply |
| `AI_TIMEOUT_MS` | `60000` | Give up if the provider does not respond in time |
| `PORT` | `3000` | HTTP port (the deployed image sets `80`) |
| `HOST` | `0.0.0.0` | Bind address — keep at `0.0.0.0` in containers |
| `RATE_LIMIT_MAX` | `20` | AI answers allowed per IP per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window length |
| `MAX_INPUT_CHARS` | `24000` | Largest accepted conversation payload |

### Switching providers

Change the preset and restart — no code changes:

```dotenv
AI_PROVIDER=groq
AI_API_KEY=gsk_your_key_here
```

### Using a local model (no key, no cost)

```dotenv
AI_PROVIDER=ollama
AI_BASE_URL=http://127.0.0.1:11434/v1
AI_MODEL=llama3.2
```

Local URLs are detected automatically, so no API key is required for Ollama or a
`custom` endpoint on `localhost`.

> **Note on limits:** you get whatever quota your provider plan allows. This app does not
> — and cannot — grant unlimited AI usage. Heavy use is subject to your provider's rate
> limits and billing, plus the per-IP limit above.

---

## API

### `GET /api/health`

Secret-free runtime info: provider, model, whether the server is configured, uptime and the
active limits. Returns `200` when ready, `503` when not configured.

### `POST /api/chat`

Accepts `{ "messages": [{ "role": "user", "content": "…" }] }` and responds with
`text/event-stream`. Events:

```jsonc
{ "type": "meta",  "model": "gpt-4o-mini", "provider": "OpenAI" }
{ "type": "delta", "text": "Hel" }                       // repeated per token batch
{ "type": "error", "code": "upstream_rate_limited", "message": "…", "hint": "…", "retryAfter": 30 }
{ "type": "done",  "aborted": false }
```

Errors are delivered both as SSE `error` events (mid-stream) and as ordinary JSON responses
with a matching HTTP status (before streaming starts).

---

## Tests

```bash
npm test
```

`node:test` covers configuration and provider presets, payload building, SSE delta
extraction, error mapping and key redaction, request validation, the rate limiter, and
end-to-end HTTP behaviour against the real Express app with a mock OpenAI-compatible
upstream (streaming order, incremental delivery, auth failures, 429 with `retryAfter`,
mid-stream breaks, validation errors, security headers, static + SPA fallback).

These tests need no API key and make no network calls.

### Runtime smoke check

```bash
npm run smoke
```

Boots the **real** server entrypoint on port 80 against a mock OpenAI-compatible
upstream and drives it over HTTP the way a browser would: health payload, static
assets and vendored libraries, security headers, incremental SSE delivery
(`meta` → `delta`… → `done`), a provider 429 becoming a safe `error` event with a
retry hint, validation errors, and SPA fallback. Also needs no API key.

Set `SMOKE_PORT` to check a different port.

---

## Deployment

The repository includes a `Dockerfile` (`node:20-alpine`) that listens on **port 80**
and binds `0.0.0.0`, which is what the platform proxy expects.

```bash
docker build -t loky-ai-next .
docker run -p 80:80 -e AI_PROVIDER=openai -e AI_API_KEY=sk-... loky-ai-next
```

On a hosting platform, set the environment variables from the table above in the
service's settings (at minimum `AI_PROVIDER` and `AI_API_KEY`) and expose port `80`.
Do not commit `.env` — it is gitignored, and the image copies only `server/`, `public/`
and `scripts/`.

---

## Project structure

```
server/
  index.js        Express app: static hosting, /api/health, streaming /api/chat, security headers
  config.js       Env → config, provider presets, validation helpers
  providers.js    Request building + SSE parsing for OpenAI-compatible and Gemini APIs
  validate.js     Chat payload validation and limits
  rateLimit.js    Dependency-free per-IP limiter
  errors.js       Error codes/messages + API-key redaction
public/
  index.html      App shell
  styles.css      Dark, mobile-first styling
  app.js          Streaming client, Markdown rendering, history, UI states, intro animation
  chat-utils.js   DOM-free helpers: titles, timestamps, storage key, title sanitising
  vendor/         marked + DOMPurify (vendored at install time)
scripts/
  vendor-assets.js  Copies browser libraries from node_modules into public/vendor
test/
  chat-utils.test.js    Unit tests for the history/timestamp helpers
  client-assets.test.js Static checks that the UI features are wired up correctly
```

---

## License

MIT © Lokesh Yadav
