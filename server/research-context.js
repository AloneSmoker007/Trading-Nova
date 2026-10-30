import {boundedJson, createPublisherNewsService, NEWS_PUBLICATION_WINDOW_MS} from "./research-news.js";

export const TOKEN_METRICS_URL = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana";
export const SENTIMENT_URL = "https://api.alternative.me/fng/?limit=1&format=json";
const ASSETS = Object.freeze({
  BTCUSDT: {id: "bitcoin", ticker: "btc", aliases: ["bitcoin", "btc"]},
  ETHUSDT: {id: "ethereum", ticker: "eth", aliases: ["ethereum", "ether", "eth"]},
  SOLUSDT: {id: "solana", ticker: "sol", aliases: ["solana", "sol"]}
});
export const supportsResearchSymbol = symbol => Object.hasOwn(ASSETS, symbol);

// Public, fixed registry entries only. Cache work is shared across all symbols.
function source(url, {fetchImpl, now, timeoutMs}) {
  let cache, pending, retryAt = 0;
  function project(failed = false) {
    const ageMs = cache ? now() - cache.retrievedAt : null;
    if (!cache || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 1800000) return {state: "unavailable", data: null, retrievedAt: null};
    return {...cache, ageMs, state: failed || ageMs > 300000 ? "stale" : "ok"};
  }
  async function read() {
    if (cache && now() - cache.retrievedAt >= 0 && now() - cache.retrievedAt <= 300000) return project();
    if (pending) return pending;
    if (now() < retryAt) return project(true);
    const controller = new AbortController();
    let timer;
    const task = (async () => {
      try {
        const work = (async () => {
          const response = await fetchImpl(url, {method: "GET", headers: {accept: "application/json"}, redirect: "error", credentials: "omit", signal: controller.signal});
          if (response.url && response.url !== url) throw new Error("unexpected redirect");
          return boundedJson(response, controller.signal);
        })();
        const data = await Promise.race([work, new Promise((_, reject) => {
          timer = setTimeout(() => {controller.abort(); reject(new Error("research deadline"));}, timeoutMs);
        })]);
        cache = {data, retrievedAt: now()}; retryAt = 0;
        return project();
      } catch { retryAt = now() + 30000; return project(true); }
      finally { clearTimeout(timer); controller.abort(); }
    })();
    pending = task;
    try { return await task; } finally { pending = null; }
  }
  return {read};
}

function observedState(snapshot, observedAt, assessedAt, maxAgeMs) {
  const ageMs = observedAt === null ? null : assessedAt - observedAt;
  const retrievalAgeMs = Number.isFinite(snapshot.retrievedAt) ? assessedAt - snapshot.retrievedAt : null;
  return {state: snapshot.state === "unavailable" ? "unavailable"
    : snapshot.state === "ok" && retrievalAgeMs !== null && retrievalAgeMs >= 0 && retrievalAgeMs <= 300000
      && ageMs !== null && ageMs >= 0 && ageMs <= maxAgeMs ? "ok" : "stale",
  observedAt, observationAgeMs: ageMs !== null && ageMs >= 0 ? ageMs : null,
  freshness: ageMs === null ? "unknown" : ageMs < 0 ? "future-date" : ageMs <= maxAgeMs ? "within-window" : "older-than-window",
  retrievedAt: snapshot.retrievedAt, retrievalAgeMs: retrievalAgeMs !== null && retrievalAgeMs >= 0 ? retrievalAgeMs : null, maxAgeMs};
}
function isoTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  return Number.isFinite(time) && time >= 0 && new Date(time).toISOString() === canonical ? time : null;
}
function tokenMetrics(snapshot, asset, assessedAt) {
  const empty = {state: "unavailable", sourceId: "coingecko", sourceUrl: "https://www.coingecko.com/en/coins/" + asset.id, kind: "token-market-and-supply", data: null};
  if (!Array.isArray(snapshot.data) || snapshot.data.length > 3) return empty;
  const rows = snapshot.data.filter(row => row?.id === asset.id && row.symbol === asset.ticker);
  if (rows.length !== 1) return empty;
  const row = rows[0];
  const valid = x => typeof x === "number" && Number.isFinite(x) && x >= 0;
  if (!valid(row.market_cap) || !valid(row.circulating_supply)
      || !(row.total_supply === null || valid(row.total_supply)) || !(row.max_supply === null || valid(row.max_supply))
      || (row.total_supply !== null && row.circulating_supply > row.total_supply * (1 + 1e-9))
      || (row.max_supply !== null && row.total_supply !== null && row.total_supply > row.max_supply * (1 + 1e-9))) return empty;
  return {...empty, ...observedState(snapshot, isoTime(row.last_updated), assessedAt, 1800000),
    data: {marketCapUsd: row.market_cap, circulatingSupply: row.circulating_supply, totalSupply: row.total_supply, maxSupply: row.max_supply},
    note: "CoinGecko token metrics in USD; not company financial statements, fair value or USDT cash accounting."};
}
function bitcoinSentiment(snapshot, assessedAt) {
  const empty = {state: "unavailable", sourceId: "alternative-me", sourceUrl: "https://alternative.me/crypto/fear-and-greed-index/",
    attribution: "Alternative.me", scope: "bitcoin-only", data: null};
  const rows = snapshot?.data?.data;
  if (!Array.isArray(rows) || rows.length !== 1 || snapshot.data.metadata?.error) return empty;
  const row = rows[0];
  if (typeof row?.value !== "string" || !/^(?:100|[0-9]{1,2})$/.test(row.value)
      || !["Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed"].includes(row.value_classification)
      || typeof row.timestamp !== "string" || !/^\d{9,11}$/.test(row.timestamp)) return empty;
  const time = Number(row.timestamp) * 1000;
  return {...empty, ...observedState(snapshot, time, assessedAt, 36 * 3600000),
    data: {value: Number(row.value), classification: row.value_classification},
    note: "Provider-reported Bitcoin index with overlapping volatility/momentum inputs; not an independent social-sentiment signal or an altcoin index."};
}

export function relevantHeadlines(snapshot, symbol, assessedAt = snapshot.assessedAt) {
  const asset = ASSETS[symbol];
  if (!asset) return [];
  const aliases = new RegExp("\\b(?:" + asset.aliases.join("|") + ")\\b", "i");
  return (snapshot.items || []).filter(item => aliases.test(item.title)).map(item => {
    const age = Number.isFinite(item.publishedAt) ? assessedAt - item.publishedAt : null;
    const retrievalAge = Number.isFinite(snapshot.retrievedAt) ? assessedAt - snapshot.retrievedAt : null;
    const risks = item.title.match(/\b(?:hack\w*|breach\w*|lawsuit\w*|reject\w*|risk\w*|declin\w*|fall\w*|loss\w*|fraud\w*|outage\w*)\b/gi) || [];
    const positives = item.title.match(/\b(?:approv\w*|adopt\w*|launch\w*|upgrad\w*|growth|gain\w*|rally|record)\b/gi) || [];
    const negated = /\b(?:not|no|never|fails? to)\b/i.test(item.title);
    return {...item, publicationAgeMs: age !== null && age >= 0 ? age : null,
      publicationFreshness: age === null ? "unknown" : age < 0 ? "future-date" : age <= NEWS_PUBLICATION_WINDOW_MS ? "within-window" : "older-than-window",
      sourceId: snapshot.publisher.id, publisher: snapshot.publisher.name,
      relevance: "headline-alias-match", eligible: snapshot.state === "ok" && retrievalAge !== null && retrievalAge >= 0 && retrievalAge <= 300000
        && age !== null && age >= 0 && age <= NEWS_PUBLICATION_WINDOW_MS,
      cues: {risk: [...new Set(risks.map(x => x.toLowerCase()))].slice(0, 8),
        opportunity: negated ? [] : [...new Set(positives.map(x => x.toLowerCase()))].slice(0, 8), negationDetected: negated},
      interpretation: "headline-candidates-only-not-verified-claims"};
  });
}

export function createStructuredResearchService({fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 5000, primaryPublisher} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000) throw new Error("invalid research deadline");
  const options = {fetchImpl, now, timeoutMs};
  const primary = primaryPublisher || createPublisherNewsService(options);
  const second = createPublisherNewsService({...options, publisherId: "bitfinex-blog"});
  const metrics = source(TOKEN_METRICS_URL, options), sentiment = source(SENTIMENT_URL, options);
  async function read(symbol) {
    if (!supportsResearchSymbol(symbol)) return {state: "unsupported", symbol};
    const [a, b, m, s] = await Promise.all([primary.read(), second.read(), metrics.read(),
      symbol === "BTCUSDT" ? sentiment.read() : Promise.resolve(null)]);
    const assessedAt = now();
    const publishers = [a, b];
    const headlines = publishers.flatMap(snapshot => relevantHeadlines(snapshot, symbol, assessedAt)).slice(0, 20);
    const fresh = headlines.filter(item => item.eligible);
    const metricsContext = tokenMetrics(m, ASSETS[symbol], assessedAt);
    const sentimentContext = s ? bitcoinSentiment(s, assessedAt) : {state: "not-applicable", scope: "bitcoin-only", data: null};
    const freshPublishers = new Set(fresh.map(item => item.sourceId));
    const limitations = ["Headline matching is lexical, not semantic relevance or fact checking.",
      "Both headline publishers are exchanges with commercial interests; independence/corroboration is not established.",
      "Risk/opportunity cues are investigation candidates and do not prove a contradiction, price direction or expected return.",
      "Token metrics are not company fundamentals. Bitcoin sentiment overlaps price/volume inputs; it must not be double-counted."];
    const complete = freshPublishers.size >= 2 && metricsContext.state === "ok" && ["ok", "not-applicable"].includes(sentimentContext.state);
    return {state: complete ? "ok" : fresh.length || metricsContext.data || sentimentContext.data ? "partial" : "unavailable",
      symbol, assessedAt, scoreImpact: "context-and-abstention-only-no-directional-weight", confidence: "limited",
      publishers: publishers.map(snapshot => ({...snapshot.publisher, state: snapshot.state, retrievedAt: snapshot.retrievedAt,
        rejectedCount: snapshot.rejectedCount, eligibleHeadlineCount: fresh.filter(item => item.sourceId === snapshot.publisher.id).length,
        reliabilityPolicy: "attributed-first-party-commercial-not-independent"})),
      sourceCoverage: {eligiblePublisherCount: freshPublishers.size, requiredPublisherCount: 2}, headlines,
      supportingCandidates: fresh.filter(item => item.cues.opportunity.length).map(item => item.id),
      counterEvidence: {state: fresh.some(item => item.cues.risk.length) ? "candidates-found" : "not-found-in-loaded-headlines",
        basis: "headline-risk-cues-only", candidateIds: fresh.filter(item => item.cues.risk.length).map(item => item.id)},
      tokenMetrics: metricsContext, bitcoinSentiment: sentimentContext, limitations};
  }
  return {read};
}
