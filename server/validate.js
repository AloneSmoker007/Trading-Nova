// server/validate.js — input validation and whitelisting for the read-only API.
//
// Every user-controlled value (symbol, interval, limit, strategy) passes through
// this module before it reaches any engine code. Unknown or malformed input is
// rejected with a machine-readable reason — never interpolated into a query,
// a path, a shell or a log line. Pure and deterministic: no I/O, no clocks.

// Same symbol vocabulary as src/market-data/providers/crypto.js. Anything else
// (path separators, spaces, percent-escapes that decode to control characters,
// SQL/HTML metacharacters, …) fails the regex and is rejected outright.
const SYMBOL_RE = /^[A-Z0-9]{2,24}$/;

// Must stay a subset of the provider's interval whitelist
// (BINANCE_INTERVAL_MS keys in src/market-data/providers/crypto.js).
const ALLOWED_INTERVALS = Object.freeze(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w"]);

const ALLOWED_STRATEGIES = Object.freeze(["sma-cross"]);

const LIMIT_MIN = 5;
const LIMIT_MAX = 1000;

const fail = (code, message) => ({ok: false, code, message});

// Decode one URL path segment defensively. A segment that is not valid
// percent-encoding, or that decodes to anything outside the symbol vocabulary,
// is rejected — no normalisation, no guessing.
export function parseSymbol(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return fail("invalid-symbol", "symbol must match [A-Z0-9]{2,24}");
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fail("invalid-symbol", "symbol must match [A-Z0-9]{2,24}");
  }
  const symbol = decoded.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return fail("invalid-symbol", "symbol must match [A-Z0-9]{2,24}");
  return {ok: true, symbol};
}

export function parseInterval(raw, fallback = "1h") {
  if (raw === undefined || raw === null || raw === "") return {ok: true, interval: fallback};
  if (typeof raw !== "string" || !ALLOWED_INTERVALS.includes(raw)) {
    return fail("invalid-interval", "interval must be one of: " + ALLOWED_INTERVALS.join(", "));
  }
  return {ok: true, interval: raw};
}

export function parseLimit(raw, fallback = 300) {
  if (raw === undefined || raw === null || raw === "") return {ok: true, limit: fallback};
  const text = String(raw);
  if (!/^\d{1,7}$/.test(text)) return fail("invalid-limit", `limit must be an integer between ${LIMIT_MIN} and ${LIMIT_MAX}`);
  const limit = Number(text);
  if (!Number.isInteger(limit) || limit < LIMIT_MIN || limit > LIMIT_MAX) {
    return fail("invalid-limit", `limit must be an integer between ${LIMIT_MIN} and ${LIMIT_MAX}`);
  }
  return {ok: true, limit};
}

export function parseStrategy(raw) {
  if (raw === undefined || raw === null || raw === "") return {ok: true, strategy: "sma-cross"};
  if (typeof raw !== "string" || !ALLOWED_STRATEGIES.includes(raw)) {
    return fail("invalid-strategy", "strategy must be one of: " + ALLOWED_STRATEGIES.join(", "));
  }
  return {ok: true, strategy: raw};
}

export {ALLOWED_INTERVALS, ALLOWED_STRATEGIES, SYMBOL_RE, LIMIT_MIN, LIMIT_MAX};
