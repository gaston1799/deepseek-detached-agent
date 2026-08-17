// Shared classification of transient DeepSeek fetch failures and the retry
// backoff schedule. Used by the watch CLI (deepseek-watch.js) and the
// detached worker (deepseek-detached.js) so both keep retrying a turn
// instead of crashing when the API connection blips.

// HTTP statuses worth re-sending the same request for. 408/425/429 are
// client-side "slow down / wait" signals, 5xx are server-side blips. Any
// other 4xx (401 auth, 402 balance, 403, 404, 400) is a terminal config or
// payload error and must fail loudly instead of retrying forever.
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529, 598, 599]);

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "EADDRINUSE"
]);

export function isRetryableFetchError(error) {
  if (!error) return false;
  // HTTP status attached by deepSeekHttpError().
  const status = Number(error.status);
  if (Number.isInteger(status) && status >= 400) {
    return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
  }
  // AbortError that is not a user interrupt means the per-attempt timeout
  // (or an external signal) killed the request. Callers check their own
  // user-interrupt flag before consulting this helper.
  if (error?.name === "AbortError") return true;
  // Node/undici network failures surface as "TypeError: fetch failed" with
  // the real code on error.cause (sometimes AggregateError, sometimes a
  // bare Error with .code).
  const cause = error.cause;
  const codes = [];
  if (cause?.code) codes.push(cause.code);
  if (Array.isArray(cause?.errors)) {
    for (const inner of cause.errors) {
      if (inner?.code) codes.push(inner.code);
    }
  }
  if (typeof error.code === "string") codes.push(error.code);
  for (const code of codes) {
    if (typeof code !== "string") continue;
    if (RETRYABLE_NETWORK_CODES.has(code)) return true;
    if (code.startsWith("UND_ERR_")) return true;
  }
  if (error?.name === "TypeError" && /fetch failed/i.test(String(error.message || ""))) return true;
  // Malformed SSE payload (server restarted mid-stream, proxy mangled a chunk).
  if (error instanceof SyntaxError) return true;
  return false;
}

export function retryBackoffMs(retryDelay, retryMaxDelay, attempt) {
  const base = Math.max(Number(retryDelay) || 1000, 100);
  const cap = Math.max(Number(retryMaxDelay) || 30000, base);
  return Math.min(base * 2 ** (attempt - 1), cap);
}
