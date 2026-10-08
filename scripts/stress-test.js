import {performance} from "node:perf_hooks";

const url = process.env.STRESS_TEST_URL ?? "http://127.0.0.1:7411/api/health";
const durationMs = Math.max(5_000, Number(process.env.STRESS_TEST_DURATION_MS ?? 30_000));
const concurrency = Math.max(1, Number(process.env.STRESS_TEST_CONCURRENCY ?? 20));
const targetRps = Math.max(1, Number(process.env.STRESS_TEST_RPS ?? 100));
const timeoutMs = Math.max(100, Number(process.env.STRESS_TEST_REQUEST_TIMEOUT_MS ?? 5_000));
const maxErrorRate = Math.min(1, Math.max(0, Number(process.env.STRESS_TEST_MAX_ERROR_RATE ?? 0.01)));
const maxP95Ms = Math.max(1, Number(process.env.STRESS_TEST_MAX_P95_MS ?? 500));
const maxRssGrowthMb = Math.max(1, Number(process.env.STRESS_TEST_MAX_RSS_GROWTH_MB ?? 128));

const samples = [];
let attempted = 0;
let completed = 0;
let errors = 0;
let inFlight = 0;
let maxInFlight = 0;
const startedAt = Date.now();
const deadline = startedAt + durationMs;
let nextDispatchAt = performance.now();
const intervalMs = 1000 / targetRps;

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)))];
}

function rssMb() {
  return process.memoryUsage().rss / 1048576;
}

const rssStart = rssMb();

async function request() {
  const t = performance.now();
  attempted++;
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {signal: controller.signal, headers: {"accept": "application/json"}});
    if (!response.ok) errors++;
    else completed++;
    await response.arrayBuffer();
  } catch {
    errors++;
  } finally {
    clearTimeout(timer);
    samples.push(performance.now() - t);
    inFlight--;
  }
}

const workers = new Set();
while (Date.now() < deadline) {
  const now = performance.now();
  if (now < nextDispatchAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, nextDispatchAt - now)));
    continue;
  }
  nextDispatchAt += intervalMs;
  if (workers.size >= concurrency) {
    continue;
  }
  const job = request().finally(() => workers.delete(job));
  workers.add(job);
}
await Promise.all(workers);

const endedAt = Date.now();
const errorRate = attempted ? errors / attempted : 1;
const p95Ms = percentile(samples, 95);
const rssEnd = rssMb();
const rssGrowthMb = rssEnd - rssStart;
const passed = attempted > 0 &&
  errorRate <= maxErrorRate &&
  p95Ms !== null &&
  p95Ms <= maxP95Ms &&
  rssGrowthMb <= maxRssGrowthMb;

const report = {
  url,
  durationMs: endedAt - startedAt,
  targetRps,
  concurrency,
  timeoutMs,
  attempted,
  completed,
  errors,
  errorRate,
  achievedRps: attempted / Math.max(1, (endedAt - startedAt) / 1000),
  maxInFlight,
  p50Ms: percentile(samples, 50),
  p95Ms,
  p99Ms: percentile(samples, 99),
  rssStartMb: Number(rssStart.toFixed(2)),
  rssEndMb: Number(rssEnd.toFixed(2)),
  rssGrowthMb: Number(rssGrowthMb.toFixed(2)),
  thresholds: {maxErrorRate, maxP95Ms, maxRssGrowthMb},
  passed,
  noTradeRequired: true
};

console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
