import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getDefaultLocation } from './locations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const ENV_PATH = join(APP_ROOT, '.env');
const SUPPORTED_PROVIDERS = ['openai', 'anthropic', 'gemini'];
const fallbackLocation = getDefaultLocation();
const DEFAULT_LOCATION = Object.freeze({
  latitude: Number(fallbackLocation.lat),
  longitude: Number(fallbackLocation.lon),
  name: fallbackLocation.name
});

loadEnvFile();

export function createConfig(env = process.env) {
  const nodeEnv = parseEnum(env.NODE_ENV, ['development', 'test', 'production'], 'development', 'NODE_ENV');
  const provider = parseEnum(env.LLM_PROVIDER, SUPPORTED_PROVIDERS, 'openai', 'LLM_PROVIDER');
  const requireLLMKey = parseBoolean(env.REQUIRE_LLM_KEY, nodeEnv === 'production');
  const adminApiKey = cleanString(env.ADMIN_API_KEY);
  const allowedOrigin = cleanString(env.ALLOWED_ORIGIN);
  const dataDir = cleanString(env.DATA_DIR) || join(APP_ROOT, 'data');

  const cfg = {
    appRoot: APP_ROOT,
    dataDir,
    nodeEnv,
    version: '0.3.0',
    server: {
      host: cleanString(env.HOST) || '0.0.0.0',
      port: parseInteger(env.PORT, { name: 'PORT', defaultValue: 3777, min: 1, max: 65535 }),
      jsonBodyLimit: cleanString(env.JSON_BODY_LIMIT) || '256kb',
      trustProxy: parseBoolean(env.TRUST_PROXY, false),
      requestTimeoutMs: parseInteger(env.REQUEST_TIMEOUT_MS, { name: 'REQUEST_TIMEOUT_MS', defaultValue: 30_000, min: 1_000, max: 300_000 }),
      keepAliveTimeoutMs: parseInteger(env.KEEP_ALIVE_TIMEOUT_MS, { name: 'KEEP_ALIVE_TIMEOUT_MS', defaultValue: 5_000, min: 1_000, max: 120_000 }),
      headersTimeoutMs: parseInteger(env.HEADERS_TIMEOUT_MS, { name: 'HEADERS_TIMEOUT_MS', defaultValue: 60_000, min: 1_000, max: 300_000 }),
      shutdownTimeoutMs: parseInteger(env.SHUTDOWN_TIMEOUT_MS, { name: 'SHUTDOWN_TIMEOUT_MS', defaultValue: 15_000, min: 1_000, max: 120_000 }),
      allowedOrigin
    },
    weather: {
      latitude: parseNumber(env.LATITUDE, { name: 'LATITUDE', defaultValue: DEFAULT_LOCATION.latitude, min: -90, max: 90 }),
      longitude: parseNumber(env.LONGITUDE, { name: 'LONGITUDE', defaultValue: DEFAULT_LOCATION.longitude, min: -180, max: 180 }),
      locationName: cleanString(env.LOCATION_NAME) || DEFAULT_LOCATION.name
    },
    llm: {
      provider,
      requireKey: requireLLMKey,
      openaiKey: cleanString(env.OPENAI_API_KEY),
      anthropicKey: cleanString(env.ANTHROPIC_API_KEY),
      geminiKey: cleanString(env.GEMINI_API_KEY)
    },
    external: {
      timeoutMs: parseInteger(env.EXTERNAL_TIMEOUT_MS, { name: 'EXTERNAL_TIMEOUT_MS', defaultValue: 15_000, min: 1_000, max: 120_000 }),
      retries: parseInteger(env.EXTERNAL_RETRIES, { name: 'EXTERNAL_RETRIES', defaultValue: 1, min: 0, max: 5 }),
      retryBackoffMs: parseInteger(env.EXTERNAL_RETRY_BACKOFF_MS, { name: 'EXTERNAL_RETRY_BACKOFF_MS', defaultValue: 400, min: 50, max: 30_000 })
    },
    streaming: {
      heartbeatMs: parseInteger(env.STREAM_HEARTBEAT_MS, { name: 'STREAM_HEARTBEAT_MS', defaultValue: 15_000, min: 1_000, max: 120_000 })
    },
    rateLimits: {
      windowMs: parseInteger(env.RATE_LIMIT_WINDOW_MS, { name: 'RATE_LIMIT_WINDOW_MS', defaultValue: 60_000, min: 1_000, max: 3_600_000 }),
      expensiveRequests: parseInteger(env.EXPENSIVE_ROUTE_LIMIT, { name: 'EXPENSIVE_ROUTE_LIMIT', defaultValue: 6, min: 1, max: 500 }),
      adminRequests: parseInteger(env.ADMIN_ROUTE_LIMIT, { name: 'ADMIN_ROUTE_LIMIT', defaultValue: 30, min: 1, max: 500 })
    },
    admin: {
      enabled: Boolean(adminApiKey),
      apiKey: adminApiKey
    }
  };

  cfg.llm.hasConfiguredKey = Boolean(getProviderApiKey(cfg.llm.provider, cfg.llm));
  cfg.warnings = buildWarnings(cfg);

  if (cfg.llm.requireKey && !cfg.llm.hasConfiguredKey) {
    throw new Error(`Configured provider "${cfg.llm.provider}" is missing its API key.`);
  }

  return cfg;
}

export function getProviderApiKey(provider, llmConfig = config.llm) {
  switch (provider) {
    case 'openai':
      return llmConfig.openaiKey;
    case 'anthropic':
      return llmConfig.anthropicKey;
    case 'gemini':
      return llmConfig.geminiKey;
    default:
      return null;
  }
}

export function loadEnvFile(envPath = ENV_PATH) {
  if (!existsSync(envPath)) {
    return;
  }

  const envContent = readFileSync(envPath, 'utf-8');
  for (const rawLine of envContent.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected a boolean value but received "${value}".`);
}

function parseEnum(value, allowed, defaultValue, name) {
  const candidate = cleanString(value) || defaultValue;
  if (!allowed.includes(candidate)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return candidate;
}

function parseInteger(value, { defaultValue, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, name }) {
  const candidate = value == null || value === '' ? defaultValue : Number.parseInt(String(value), 10);
  if (!Number.isInteger(candidate)) {
    throw new Error(`${name} must be an integer.`);
  }
  if (candidate < min || candidate > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return candidate;
}

function parseNumber(value, { defaultValue, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, name }) {
  const candidate = value == null || value === '' ? defaultValue : Number(value);
  if (!Number.isFinite(candidate)) {
    throw new Error(`${name} must be a number.`);
  }
  if (candidate < min || candidate > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return candidate;
}

function cleanString(value) {
  if (value == null) {
    return '';
  }
  return String(value).trim();
}

function buildWarnings(cfg) {
  const warnings = [];

  if (!cfg.llm.hasConfiguredKey) {
    warnings.push(`Configured provider "${cfg.llm.provider}" does not have an API key. LLM-backed routes will fail until one is configured.`);
  }

  if (!cfg.admin.enabled) {
    warnings.push('ADMIN_API_KEY is not set. Mutating admin routes rely on network-level protection only.');
  }

  return warnings;
}

export const config = createConfig();
