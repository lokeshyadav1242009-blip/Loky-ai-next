import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadConfig,
  isConfigured,
  normaliseBaseUrl,
  isLocalUrl,
} from '../server/config.js';

test('defaults to OpenAI and reports itself unconfigured without a key', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.style, 'openai');
  assert.equal(cfg.baseUrl, 'https://api.openai.com/v1');
  assert.equal(cfg.model, 'gpt-4o-mini');
  assert.equal(cfg.apiKey, '');
  assert.equal(cfg.requiresApiKey, true);
  assert.equal(isConfigured(cfg), false);
});

test('provider preset picks up its conventional key variable', () => {
  const cfg = loadConfig({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'gsk_abc' });
  assert.equal(cfg.provider, 'groq');
  assert.equal(cfg.apiKey, 'gsk_abc');
  assert.equal(cfg.model, 'llama-3.3-70b-versatile');
  assert.equal(isConfigured(cfg), true);
});

test('an explicit AI_API_KEY wins over the preset variable', () => {
  const cfg = loadConfig({ AI_PROVIDER: 'groq', AI_API_KEY: 'explicit', GROQ_API_KEY: 'preset' });
  assert.equal(cfg.apiKey, 'explicit');
});

test('unknown provider falls back to the custom preset and is reported', () => {
  const cfg = loadConfig({ AI_PROVIDER: 'does-not-exist' });
  assert.equal(cfg.provider, 'custom');
  assert.equal(cfg.unknownProvider, 'does-not-exist');
});

test('local endpoints do not require an API key', () => {
  const cfg = loadConfig({
    AI_PROVIDER: 'ollama',
    AI_BASE_URL: 'http://127.0.0.1:11434/v1',
  });
  assert.equal(cfg.requiresApiKey, false);
  assert.equal(isConfigured(cfg), true);
});

test('numeric settings are clamped into safe ranges', () => {
  const cfg = loadConfig({
    AI_MAX_TOKENS: '999999',
    AI_TEMPERATURE: '9',
    AI_TIMEOUT_MS: '1',
    PORT: 'nope',
    RATE_LIMIT_MAX: '0',
  });
  assert.equal(cfg.maxTokens, 32000);
  assert.equal(cfg.temperature, 2);
  assert.equal(cfg.timeoutMs, 1000);
  assert.equal(cfg.server.port, 3000);
  assert.equal(cfg.limits.rateLimitMax, 1);
});

test('AI_STYLE only accepts known wire formats', () => {
  assert.equal(loadConfig({ AI_STYLE: 'gemini' }).style, 'gemini');
  assert.equal(loadConfig({ AI_STYLE: 'something-else' }).style, 'openai');
});

test('normaliseBaseUrl strips trailing slashes and rejects non-http URLs', () => {
  assert.equal(normaliseBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(normaliseBaseUrl('  https://api.example.com/v1//  '), 'https://api.example.com/v1');
  assert.equal(normaliseBaseUrl(''), '');
  assert.equal(normaliseBaseUrl('not a url'), '');
  assert.equal(normaliseBaseUrl('ftp://example.com'), '');
});

test('isLocalUrl recognises loopback hosts', () => {
  assert.equal(isLocalUrl('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLocalUrl('http://localhost:8000/v1'), true);
  assert.equal(isLocalUrl('http://box.local/v1'), true);
  assert.equal(isLocalUrl('https://api.openai.com/v1'), false);
});
