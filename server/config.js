import 'dotenv/config';

/**
 * LOKY AI Next - server configuration.
 *
 * Everything provider-related is read from the environment so the assistant can
 * be pointed at a different AI backend without touching application code.
 * None of these values are ever sent to the browser.
 */

const PRESETS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
    style: 'openai',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    envKey: 'GROQ_API_KEY',
    style: 'openai',
    keyUrl: 'https://console.groq.com/keys',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    envKey: 'OPENROUTER_API_KEY',
    style: 'openai',
    keyUrl: 'https://openrouter.ai/keys',
  },
  mistral: {
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    envKey: 'MISTRAL_API_KEY',
    style: 'openai',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  together: {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    envKey: 'TOGETHER_API_KEY',
    style: 'openai',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY',
    style: 'openai',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    envKey: 'GEMINI_API_KEY',
    style: 'gemini',
    keyUrl: 'https://aistudio.google.com/app/apikey',
  },
  ollama: {
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.2',
    envKey: '',
    style: 'openai',
    keyUrl: 'https://ollama.com/download',
  },
  custom: {
    label: 'Custom OpenAI-compatible endpoint',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'local-model',
    envKey: 'AI_API_KEY',
    style: 'openai',
    keyUrl: '',
  },
};

export const PROVIDER_NAMES = Object.keys(PRESETS);
export const PROVIDERS = PRESETS;

const DEFAULT_SYSTEM_PROMPT = [
  'You are LOKY AI Next, a helpful, concise and friendly AI assistant by Lokesh Yadav.',
  'Answer in well-structured Markdown. Use headings, bullet lists and tables where they help.',
  'Always wrap code in fenced code blocks with the correct language tag.',
  'If you are unsure about something, say so instead of inventing facts.',
].join(' ');

function str(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function num(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function int(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Normalise a base URL: strip trailing slashes. Returns '' when invalid.
 */
export function normaliseBaseUrl(raw) {
  const value = str(raw);
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * Build the runtime configuration from an environment object.
 * Pure function so it can be unit tested with fake env values.
 */
export function loadConfig(env = process.env) {
  const requested = str(env.AI_PROVIDER, 'openai').toLowerCase();
  const providerName = PRESETS[requested] ? requested : 'custom';
  const preset = PRESETS[providerName];

  const baseUrl =
    normaliseBaseUrl(env.AI_BASE_URL) || preset.baseUrl;
  const model = str(env.AI_MODEL) || preset.model;
  // An explicit AI_API_KEY always wins, otherwise fall back to the preset's
  // conventional variable (OPENAI_API_KEY, GROQ_API_KEY, ...).
  const apiKey =
    str(env.AI_API_KEY) || (preset.envKey ? str(env[preset.envKey]) : '');

  const style = str(env.AI_STYLE, preset.style) === 'gemini' ? 'gemini' : 'openai';

  return {
    provider: providerName,
    providerLabel: preset.label,
    unknownProvider: requested !== providerName ? requested : null,
    style,
    baseUrl,
    model,
    apiKey,
    // Ollama and other local servers legitimately run without a key.
    requiresApiKey: !isLocalUrl(baseUrl),
    systemPrompt: str(env.AI_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT),
    temperature: Math.min(Math.max(num(env.AI_TEMPERATURE, 0.7), 0), 2),
    maxTokens: int(env.AI_MAX_TOKENS, 2048, 16, 32000),
    timeoutMs: int(env.AI_TIMEOUT_MS, 60000, 1000, 300000),
    keyUrl: preset.keyUrl,
    server: {
      port: int(env.PORT, 3000, 1, 65535),
      host: str(env.HOST, '0.0.0.0'),
    },
    limits: {
      rateLimitMax: int(env.RATE_LIMIT_MAX, 20, 1, 10000),
      rateLimitWindowMs: int(env.RATE_LIMIT_WINDOW_MS, 60000, 1000, 3600000),
      maxInputChars: int(env.MAX_INPUT_CHARS, 24000, 1000, 200000),
      maxMessages: int(env.MAX_MESSAGES, 40, 2, 200),
    },
  };
}

export function isLocalUrl(url) {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.local')
    );
  } catch {
    return false;
  }
}

/** True when the provider has everything it needs to be called. */
export function isConfigured(config) {
  if (!config.baseUrl || !config.model) return false;
  if (config.requiresApiKey && !config.apiKey) return false;
  return true;
}

export const config = loadConfig(process.env);
