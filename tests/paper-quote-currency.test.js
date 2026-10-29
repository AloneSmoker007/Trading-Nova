import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createPaperOrderService} from "../server/orders.js";
import {DurableStore} from "../src/persistence/store.js";
import {buildPortfolioState} from "../src/risk/portfolio.js";

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "nova-currency-"));
  const store = new DurableStore();
  const calls = [];
  const options = {stateFile: join(dir, "seed.json"), store, feeRate: 0, slippageBps: 0,
    market: {getTicker: async (symbol) => {
      calls.push(symbol);
      return {state: "ok", ageMs: 0, data: {last: 0.05, bid: 0.05, ask: 0.05}};
    }}};
  try { await run({store, calls, options, service: createPaperOrderService(options)}); }
  finally { await rm(dir, {recursive: true, force: true}); }
}
const order = (symbol, type = "MARKET") => ({symbol, type, side: "BUY", quantity: 1, price: 0.05,
  idempotencyKey: `${symbol}-${type}`});

test("paper cash cannot buy BTC-quoted or other non-USDT instruments", async () => {
  await fixture(async ({service, calls, store}) => {
    for (const symbol of ["ETHBTC", "BTCUSDC", "USDT", "BTCUSD", "BTCUSDTX"]) {
      for (const type of ["MARKET", "LIMIT", "STOP_LOSS", "TAKE_PROFIT"]) {
        const result = await service.submit(order(symbol, type));
        assert.equal(result.status, 400, `${symbol}/${type}: ${JSON.stringify(result.body)}`);
        assert.equal(result.body.error.code, "unsupported-quote-currency");
      }
    }
    assert.deepEqual(calls, []);
    assert.equal(store.state.size, 0);
    const supported = await service.submit(order("ethusdt"));
    assert.equal(supported.status, 200);
    assert.equal(supported.body.data.fill.symbol, "ETHUSDT");
  });
});

test("legacy non-USDT pending orders are rejected after service recreation without a fill", async () => {
  await fixture(async ({options, calls, store}) => {
    const legacy = {...order("ETHBTC", "LIMIT"), orderId: "legacy", status: "PENDING",
      createdAt: 1, limitPrice: 0.05};
    store.put("paper-orders", legacy.idempotencyKey, legacy);
    const restarted = createPaperOrderService(options);
    await restarted.processPendingOrders();
    const saved = store.get("paper-orders", legacy.idempotencyKey);
    assert.equal(saved.status, "REJECTED");
    assert.equal(saved.rejectionCode, "unsupported-quote-currency");
    assert.equal(store.get("paper-fills", legacy.idempotencyKey), null);
    assert.deepEqual(calls, []);
    await restarted.processPendingOrders();
    assert.deepEqual(store.get("paper-orders", legacy.idempotencyKey), saved);
  });
});

test("legacy cross-currency positions cannot be repriced or authorize a USDT fill", async () => {
  await fixture(async ({service, calls, store}) => {
    const portfolio = buildPortfolioState({cash: 10000, startingEquity: 10000,
      positions: [{symbol: "ETHBTC", quantity: 1, markPrice: 0.05}]});
    store.put("paper-portfolio", "current", portfolio);
    const result = await service.submit(order("BTCUSDT"));
    assert.notEqual(result.status, 200);
    assert.equal(store.get("paper-fills", "BTCUSDT-MARKET"), null);
    assert.deepEqual(store.get("paper-portfolio", "current"), portfolio);
    assert.deepEqual(calls, []);
  });
});
