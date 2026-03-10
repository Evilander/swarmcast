import { setTimeout as delay } from 'timers/promises';
import { config } from './config.js';

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithTimeout(url, options = {}) {
  const retries = options.retries ?? config.external.retries;
  const retryBackoffMs = options.retryBackoffMs ?? config.external.retryBackoffMs;
  const retryStatuses = options.retryStatuses ?? RETRYABLE_STATUSES;

  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    attempt += 1;

    const { signal, cleanup } = createRequestSignal(options.signal, options.timeoutMs ?? config.external.timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal });
      if (retryStatuses.has(response.status) && attempt <= retries) {
        await response.arrayBuffer().catch(() => null);
        await delay(retryBackoffMs * attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = normalizeFetchError(error);
      if (shouldStopRetrying(lastError, options.signal, attempt, retries)) {
        throw lastError;
      }
      await delay(retryBackoffMs * attempt);
    } finally {
      cleanup();
    }
  }

  throw lastError ?? new Error(`Request to ${url} failed.`);
}

function createRequestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const onAbort = () => controller.abort(parentSignal?.reason ?? new Error('Request was aborted.'));
  if (parentSignal) {
    if (parentSignal.aborted) {
      onAbort();
    } else {
      parentSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) {
        parentSignal.removeEventListener('abort', onAbort);
      }
    }
  };
}

function shouldStopRetrying(error, parentSignal, attempt, retries) {
  if (attempt > retries) {
    return true;
  }
  if (parentSignal?.aborted) {
    return true;
  }
  if (error.name === 'AbortError' && parentSignal?.aborted) {
    return true;
  }
  return false;
}

function normalizeFetchError(error) {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
