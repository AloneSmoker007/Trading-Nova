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
