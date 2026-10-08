import {performance} from "node:perf_hooks";
import {createCryptoProvider} from "../src/market-data/providers/crypto.js";

const symbol = (process.env.MARKET_SYMBOL ?? "BTCUSDT").toUpperCase();
const interval = process.env.MARKET_INTERVAL ?? "1m";
const intervalMs = { "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000 }[interval];
if (!intervalMs) throw new Error("unsupported soak interval");

const durationMs = Math.max(10_000, Number(process.env.MARKET_SOAK_DURATION_MS ?? 120_000));
const pollMs = Math.max(1_000, Number(process.env.MARKET_SOAK_INTERVAL_MS ?? 5_000));
const maxFreshMs = Math.max(intervalMs * 2, Number(process.env.MARKET_MAX_AGE_MS ?? intervalMs * 2));
const maxErrorRate = Math.min(1, Math.max(0, Number(process.env.MARKET_MAX_ERROR_RATE ?? 0.05)));
const maxLatencyMs = Math.max(1, Number(process.env.MARKET_MAX_LATENCY_MS ?? 2_000));
const binanceBaseUrl = process.env.MARKET_BINANCE_BASE_URL?.trim();
const provider = createCryptoProvider({
  sources: binanceBaseUrl ? {binance: {baseUrl: binanceBaseUrl}} : undefined,
  http: {
    timeoutMs: Math.max(1, Number(process.env.MARKET_REQUEST_TIMEOUT_MS ?? 5_000)),
    retries: 2,
    retryDelayMs: 100,
    deadlineMs: Math.max(5_000, Number(process.env.MARKET_REQUEST_DEADLINE_MS ?? 15_000))
  }
});

const end = Date.now() + durationMs;
const samples = [];
let failures = 0;
let gapFailures = 0;
let freshnessFailures = 0;
let lastSuccessfulAt = null;

while (Date.now() < end) {
  const started = performance.now();
  let sample;
  try {
    const [quote, candles] = await Promise.all([
      provider.getQuote(symbol),
      provider.getKlines({symbol, interval, limit: 3})
    ]);
    const latencyMs = performance.now() - started;
    if (!quote.ok || !candles.ok) {
      const describe = (result) => result.ok ? "ok" : `${result.reason ?? "unknown"}${Number.isFinite(result.status) && result.status > 0 ? `(${result.status})` : ""}`;\n      throw new Error(`upstream failure: quote=${describe(quote)} candles=${describe(candles)}`);
    }

    const latest = candles.data.at(-1);
    const gaps = candles.gaps ?? [];
    const freshnessMs = latest ? Date.now() - latest.ts : Infinity;
    const fresh = Number.isFinite(freshnessMs) && freshnessMs <= maxFreshMs;

    if (gaps.length) gapFailures++;
    if (!fresh) freshnessFailures++;
    if (latencyMs > maxLatencyMs) throw new Error(`latency ${Math.round(latencyMs)}ms > ${maxLatencyMs}ms`);
    if (gaps.length) throw new Error(`candle gaps=${gaps.length}`);
    if (!fresh) throw new Error(`stale candles age=${Math.round(freshnessMs)}ms`);

    lastSuccessfulAt = Date.now();
    sample = {ok: true, latencyMs, freshnessMs, latestTs: latest.ts, gaps: gaps.length};
  } catch (error) {
    failures++;
    sample = {ok: false, error: error instanceof Error ? error.message : String(error)};
  }

  samples.push({at: new Date().toISOString(), ...sample});
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

const latencies = samples.filter((x) => x.ok).map((x) => x.latencyMs).sort((a, b) => a - b);
const percentile = (p) => latencies.length
  ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * (latencies.length - 1)))]
  : null;
const errorRate = samples.length ? failures / samples.length : 1;
const passed = samples.length > 0 &&
  errorRate <= maxErrorRate &&
  gapFailures === 0 &&
  freshnessFailures === 0 &&
  lastSuccessfulAt !== null &&
  Date.now() - lastSuccessfulAt <= maxFreshMs;

const report = {
  source: "binance-public-rest",
  baseUrl: binanceBaseUrl ?? "default",
  symbol,
  interval,
  durationMs,
  pollMs,
  samples: samples.length,
  failures,
  errorRate,
  gapFailures,
  freshnessFailures,
  p50Ms: percentile(50),
  p95Ms: percentile(95),
  maxLatencyMs,
  maxFreshMs,
  lastSuccessfulAt: lastSuccessfulAt ? new Date(lastSuccessfulAt).toISOString() : null,
  passed,
  noTradeRequired: true,
  recentSamples: samples.slice(-10)
};

console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
