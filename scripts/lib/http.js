/**
 * scripts/lib/http.js
 *
 * Outbound HTTP hardening for the ops scripts (H-sec-1). Every network call made
 * from `scripts/` must go through here (or pass its own AbortSignal) so a hung
 * upstream — a TCP connection that opens but never responds — can never wedge a
 * load test, soak run, or smoke job indefinitely.
 *
 * Design:
 *   - `fetchWithTimeout` wraps every request in `AbortSignal.timeout(ms)` and
 *     converts abort/timeout into a typed `RequestTimeoutError` (`code: "ETIMEDOUT"`).
 *   - `fetchWithRetry` adds deadline-aware retries: it never sleeps past the
 *     deadline, never starts a request after the deadline, and only retries
 *     retryable failures (network errors, timeouts, HTTP 429/5xx).
 *   - Timeouts are bounded by the caller's overall deadline (`deadlineAt`, epoch
 *     ms) so no single attempt can outlive the run.
 *
 * No secrets are read, stored or logged here.
 */
const {AbortSignal} = globalThis;

export class RequestTimeoutError extends Error {
  constructor(message, {url, timeoutMs} = {}) {
    super(message);
    this.name = "RequestTimeoutError";
    this.code = "ETIMEDOUT";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/** True for abort/timeout-shaped errors from fetch or our own wrappers. */
export function isTimeoutError(error) {
  return error instanceof RequestTimeoutError ||
    error?.name === "TimeoutError" || error?.name === "AbortError";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch with a hard per-request timeout, bounded by an optional overall deadline.
 *
 * @param {string} url
 * @param {{timeoutMs?:number, deadlineAt?:number, init?:RequestInit}} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, {timeoutMs = 5000, deadlineAt = Infinity, init = {}} = {}) {
  const remaining = Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : Infinity;
  const ms = Math.min(timeoutMs, remaining);
  if (!(ms > 0)) {
    throw new RequestTimeoutError(`deadline exceeded before request: ${url}`, {url, timeoutMs});
  }
  try {
    return await fetch(url, {...init, signal: AbortSignal.timeout(ms)});
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new RequestTimeoutError(`request timed out after ${ms}ms: ${url}`, {url, timeoutMs: ms});
    }
    throw error;
  }
}

/**
 * Deadline-aware retrying fetch. Retries network failures, timeouts and
 * HTTP 429/5xx up to `retries` extra attempts with exponential backoff that is
 * clamped to the remaining deadline. A final 429/5xx response is returned to the
 * caller (which decides how to score it); errors are rethrown as-is.
 *
 * @param {string} url
 * @param {{timeoutMs?:number, deadlineAt?:number, retries?:number, backoffMs?:number, init?:RequestInit, onRetry?:(attempt:number, error:Error)=>void}} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, opts = {}) {
  const {timeoutMs = 5000, deadlineAt = Infinity, retries = 2, backoffMs = 250, init = {}, onRetry} = opts;
  let lastError = null;
  let lastResponse = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(backoffMs * 2 ** (attempt - 1), Math.max(0, deadlineAt - Date.now()));
      if (Number.isFinite(deadlineAt) && Date.now() + wait >= deadlineAt && lastError) break;
      await sleep(wait);
    }
    if (Date.now() >= deadlineAt && lastError) break;
    try {
      const res = await fetchWithTimeout(url, {timeoutMs, deadlineAt, init});
      if (res.status !== 429 && res.status < 500) return res;
      lastResponse = res;
      lastError = new Error(`http ${res.status}`);
    } catch (error) {
      lastError = error;
      lastResponse = null;
    }
    if (onRetry && attempt < retries) onRetry(attempt + 1, lastError ?? new Error("retryable response"));
  }
  if (lastResponse) return lastResponse;
  throw lastError ?? new RequestTimeoutError(`deadline exceeded before request: ${url}`, {url, timeoutMs});
}
