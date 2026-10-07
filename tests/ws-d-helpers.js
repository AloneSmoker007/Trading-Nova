// tests/ws-d-helpers.js — shared fixtures for the WS-D web-foundation tests.
// (Not a *.test.js file, so node --test does not execute it directly.)
//
// Everything is transport-injectable: tests never touch the network and never
// depend on wall-clock timing (the clock is injected too).

import {createNovaServer} from "../server/app.js";

export function jsonResponse(status, data) {
  return {ok: status >= 200 && status < 300, status, json: async () => data};
}

// Minimal fetch replacement: first matching needle wins; unmatched -> HTTP 404.
export function fakeFetch(routes) {
  return async (url) => {
    const text = String(url);
    for (const [needle, handler] of routes) {
      if (text.includes(needle)) return typeof handler === "function" ? handler(text) : handler;
    }
    return jsonResponse(404, {error: "not found"});
  };
}

// Deterministic synthetic Binance kline rows (strings, exactly like upstream).
// Gentle sine + drift so moving averages and the SMA cross have something real
// to compute over.
export function klineRows(count, {start = 1700000000000, intervalMs = 3600000, base = 100} = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const open = base + Math.sin(i / 7) * 5 + i * 0.05;
    const close = base + Math.sin((i + 1) / 7) * 5 + (i + 1) * 0.05;
    const high = Math.max(open, close) + 1;
    const low = Math.min(open, close) - 1;
    const ts = start + i * intervalMs;
    rows.push([ts, open.toFixed(2), high.toFixed(2), low.toFixed(2), close.toFixed(2), "10.5", ts + intervalMs - 1, 100, "0", "0", "0", "0"]);
  }
  return rows;
}

export function ticker24hPayload(symbol = "BTCUSDT") {
  return {
    symbol,
    lastPrice: "42000.50",
    bidPrice: "42000.00",
    askPrice: "42001.00",
    highPrice: "43000.00",
    lowPrice: "41000.00",
    volume: "1234.5",
    quoteVolume: "52000000.0",
    priceChangePercent: "1.23"
  };
}

// Start a real server on an ephemeral loopback port.
export async function startTestServer(options = {}) {
  const server = createNovaServer({
    fetchImpl: async () => jsonResponse(500, {}),
    tradingMode: "paper",
    ...options
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const {port} = server.address();
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export async function getJson(base, path) {
  const res = await fetch(base + path, {headers: {Accept: "application/json"}});
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return {status: res.status, body, text: JSON.stringify(body), headers: res.headers};
}

// ---------------------------------------------------------------------------
// Secret-leak assertions (mirrors scripts/secret-scan.js high-confidence shapes).
// ---------------------------------------------------------------------------

const SECRET_KEY_RE = /token|secret|password|api.?key|authorization/i;
const SECRET_VALUE_RES = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ED25519 )?PRIVATE KEY-----/,
  /\bpostgres(?:ql)?:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/i
];

function walk(value, path, violations) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, violations));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) violations.push(`secret-like key at ${path}.${key}`);
      walk(item, `${path}.${key}`, violations);
    }
    return;
  }
  if (typeof value === "string") {
    for (const re of SECRET_VALUE_RES) {
      if (re.test(value)) violations.push(`secret-like value at ${path}`);
    }
  }
}

export function findSecretViolations(body, rawText) {
  const violations = [];
  walk(body, "$", violations);
  const text = rawText !== undefined ? rawText : JSON.stringify(body);
  for (const re of SECRET_VALUE_RES) {
    if (re.test(text)) violations.push("secret-like value in raw payload");
  }
  return violations;
}
