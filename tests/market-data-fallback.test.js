import test from "node:test";
import assert from "node:assert/strict";
import {createMarketService} from "../server/market.js";

test("market service falls back to CoinGecko price when Binance ticker fails", async () => {
  const fetchImpl = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("binance.com")) {
      return {ok: false, status: 503, json: async () => ({code: -1003, msg: "Too many requests"})};
    }
    if (urlStr.includes("coingecko.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            id: "bitcoin",
            symbol: "btc",
            name: "Bitcoin",
            current_price: 65432.1,
            total_volume: 12345678,
            price_change_percentage_24h: 2.5,
            last_updated: "2026-10-08T12:00:00.000Z"
          }
        ]
      };
    }
    return {ok: false, status: 404, json: async () => ({})};
  };

  const market = createMarketService({fetchImpl, ttlMs: 0});
  const ticker = await market.getTicker("BTCUSDT");

  assert.equal(ticker.state, "ok");
  assert.equal(ticker.data.symbol, "BTCUSDT");
  assert.equal(ticker.data.last, 65432.1);
  assert.equal(ticker.data.source, "coingecko-fallback");

  const health = market.getSourceHealth();
  assert.equal(health.length, 2);
  const fallbackSource = health.find(s => s.name === "coingecko-fallback");
  assert.equal(fallbackSource.status, "healthy");
});

test("market service returns primary Binance ticker when available", async () => {
  const fetchImpl = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("ticker/24hr")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          symbol: "BTCUSDT",
          lastPrice: "67000.00",
          bidPrice: "66999.00",
          askPrice: "67001.00",
          highPrice: "68000.00",
          lowPrice: "65000.00",
          volume: "1000.0",
          quoteVolume: "67000000.0",
          priceChangePercent: "1.5"
        })
      };
    }
    return {ok: false, status: 404, json: async () => ({})};
  };

  const market = createMarketService({fetchImpl, ttlMs: 0});
  const ticker = await market.getTicker("BTCUSDT");

  assert.equal(ticker.state, "ok");
  assert.equal(ticker.data.last, 67000.00);
  assert.equal(ticker.data.bid, 66999.00);
  assert.equal(ticker.data.ask, 67001.00);

  const health = market.getSourceHealth();
  const primarySource = health.find(s => s.name === "binance-primary");
  assert.equal(primarySource.status, "healthy");
});


test("market cache stays bounded and evicts the least-recently-used key", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/api/v3/ticker/24hr")) {
      const symbol = parsed.searchParams.get("symbol");
      requests.push(symbol);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          symbol,
          lastPrice: "10",
          bidPrice: "9.99",
          askPrice: "10.01",
          highPrice: "11",
          lowPrice: "9",
          volume: "100",
          quoteVolume: "1000",
          priceChangePercent: "1"
        })
      };
    }
    return {ok: false, status: 404, json: async () => ({})};
  };

  const market = createMarketService({fetchImpl, ttlMs: 10000, maxCacheEntries: 2});
  await market.getTicker("AAA");
  await market.getTicker("BBB");
  const recent = await market.getTicker("AAA");
  assert.equal(recent.cached, true);
  await market.getTicker("CCC"); // evicts BBB, not the recently-used AAA
  await market.getTicker("BBB");

  assert.deepEqual(requests, ["AAA", "BBB", "CCC", "BBB"]);
});

test("market cache capacity must be a positive integer", () => {
  assert.throws(() => createMarketService({maxCacheEntries: 0}), /maxCacheEntries/);
  assert.throws(() => createMarketService({maxCacheEntries: 1.5}), /maxCacheEntries/);
});


test("concurrent requests for the same market key share one upstream read", async () => {
  let requestCount = 0;
  let markStarted;
  let releaseResponse;
  const started = new Promise(resolve => { markStarted = resolve; });
  const blockedResponse = new Promise(resolve => { releaseResponse = resolve; });
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    if (!parsed.pathname.endsWith("/api/v3/ticker/24hr")) {
      return {ok: false, status: 404, json: async () => ({})};
    }
    requestCount++;
    markStarted();
    return blockedResponse;
  };

  const market = createMarketService({fetchImpl, ttlMs: 10000});
  const first = market.getTicker("AAA");
  await started;
  const second = market.getTicker("AAA");
  releaseResponse({
    ok: true,
    status: 200,
    json: async () => ({
      symbol: "AAA",
      lastPrice: "10",
      bidPrice: "9.99",
      askPrice: "10.01",
      highPrice: "11",
      lowPrice: "9",
      volume: "100",
      quoteVolume: "1000",
      priceChangePercent: "1"
    })
  });

  const [one, two] = await Promise.all([first, second]);
  assert.equal(requestCount, 1);
  assert.equal(one.state, "ok");
  assert.equal(two.state, "ok");
  assert.equal(two.cached, true);
});


test("market service caps concurrent distinct upstream reads", async () => {
  let requestCount = 0;
  let markStarted;
  let releaseResponse;
  const started = new Promise(resolve => { markStarted = resolve; });
  const blockedResponse = new Promise(resolve => { releaseResponse = resolve; });
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    if (!parsed.pathname.endsWith("/api/v3/ticker/24hr")) {
      return {ok: false, status: 404, json: async () => ({})};
    }
    requestCount++;
    markStarted();
    return blockedResponse;
  };

  const market = createMarketService({fetchImpl, ttlMs: 10000, maxInFlight: 1});
  const first = market.getTicker("AAA");
  await started;
  const overflow = await market.getTicker("BBB");
  assert.equal(overflow.state, "unavailable");
  assert.equal(overflow.reason, "upstream-capacity");
  assert.equal(requestCount, 1);

  releaseResponse({
    ok: true,
    status: 200,
    json: async () => ({
      symbol: "AAA",
      lastPrice: "10",
      bidPrice: "9.99",
      askPrice: "10.01",
      highPrice: "11",
      lowPrice: "9",
      volume: "100",
      quoteVolume: "1000",
      priceChangePercent: "1"
    })
  });
  assert.equal((await first).state, "ok");
});

test("market service validates in-flight capacity", () => {
  assert.throws(() => createMarketService({maxInFlight: 0}), /maxInFlight/);
  assert.throws(() => createMarketService({maxInFlight: 1.25}), /maxInFlight/);
});

test("market cache freshness starts when the upstream response completes", async () => {
  let time = 1_000;
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/api/v3/ticker/24hr")) {
      // Simulate a slow upstream read without using real wall-clock sleeps.
      time += 250;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          symbol: "AAA",
          lastPrice: "10",
          bidPrice: "9.99",
          askPrice: "10.01",
          highPrice: "11",
          lowPrice: "9",
          volume: "100",
          quoteVolume: "1000",
          priceChangePercent: "1"
        })
      };
    }
    return {ok: false, status: 404, json: async () => ({})};
  };

  const market = createMarketService({fetchImpl, now: () => time, ttlMs: 10000});
  const first = await market.getTicker("AAA");
  assert.equal(first.state, "ok");
  assert.equal(first.ageMs, 0);

  time += 120;
  const cached = await market.getTicker("AAA");
  assert.equal(cached.cached, true);
  assert.equal(cached.ageMs, 120);
});

