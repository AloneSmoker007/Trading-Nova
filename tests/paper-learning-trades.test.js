import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DurableStore} from "../src/persistence/store.js";
import {derivePaperOutcomes} from "../src/journal/outcomes.js";
import {startTestServer} from "./ws-d-helpers.js";

const fill = ({id, side, quantity, price, fee = 0, timestamp, executionSequence, symbol = "BTCUSDT"}) => ({
  orderId: id,
  idempotencyKey: id,
  status: "RECONCILED",
  symbol,
  side,
  quantity,
  price,
  fee,
  timestamp,
  ...(executionSequence === undefined ? {} : {sequenceVersion: 1, executionSequence})
});

test("scale-ins and multiple partial closes aggregate into one fee-reconciled whole trade", () => {
  const report = derivePaperOutcomes([
    fill({id: "open-one", side: "BUY", quantity: 1, price: 100, fee: 1, timestamp: 1}),
    fill({id: "open-two", side: "BUY", quantity: 1, price: 110, fee: 1, timestamp: 2}),
    fill({id: "close-one", side: "SELL", quantity: 0.5, price: 120, fee: 0.6, timestamp: 3}),
    fill({id: "close-two", side: "SELL", quantity: 1.5, price: 130, fee: 1.8, timestamp: 4})
  ]);
  assert.equal(report.outcomes.length, 3, "FIFO fragments remain available as lower-level facts");
  assert.equal(report.tradeSummaries.length, 1, "scale-in lots and partial closes belong to one flat-to-flat cycle");
  const [trade] = report.tradeSummaries;
  assert.equal(trade.status, "CLOSED");
  assert.equal(trade.direction, "LONG");
  assert.equal(trade.result, "WIN");
  assert.deepEqual(trade.openingOrderIds, ["open-one", "open-two"]);
  assert.deepEqual(trade.closingOrderIds, ["close-one", "close-two"]);
  assert.equal(trade.openedQuantity, 2);
  assert.equal(trade.closedQuantity, 2);
  assert.equal(trade.openQuantity, 0);
  assert.equal(trade.openLotCount, 0);
  assert.equal(trade.matchedFragments, 3);
  assert.equal(trade.realizedGrossPnl, 45);
  assert.equal(trade.realizedFees, 4.4);
  assert.equal(trade.realizedNetPnl, 40.6);
  assert.equal(report.tradeSummary.closedTradeCount, 1);
  assert.equal(report.tradeSummary.openTradeCount, 0);
  assert.equal(report.tradeSummary.closedTradeWinRate, 1);
  assert.equal(report.tradeSummary.closedTradeNetPnl, 40.6);
  assert.equal(report.tradeSummary.realizedNetPnl, report.summary.realizedNetPnl);
});

test("short scale-ins and partial closes use the same fee-adjusted whole-trade accounting", () => {
  const report = derivePaperOutcomes([
    fill({id: "short-open-one", side: "SELL", quantity: 1, price: 100, fee: 1, timestamp: 1}),
    fill({id: "short-open-two", side: "SELL", quantity: 1, price: 90, fee: 1, timestamp: 2}),
    fill({id: "short-close", side: "BUY", quantity: 2, price: 80, fee: 2, timestamp: 3})
  ]);
  assert.equal(report.tradeSummaries.length, 1);
  const [trade] = report.tradeSummaries;
  assert.equal(trade.direction, "SHORT");
  assert.equal(trade.status, "CLOSED");
  assert.equal(trade.result, "WIN");
  assert.equal(trade.openedQuantity, 2);
  assert.equal(trade.closedQuantity, 2);
  assert.equal(trade.realizedGrossPnl, 30);
  assert.equal(trade.realizedFees, 4);
  assert.equal(trade.realizedNetPnl, 26);
  assert.equal(report.tradeSummary.closedTradeWins, 1);
});

test("simultaneous symbol positions form independent whole-trade cycles", () => {
  const report = derivePaperOutcomes([
    fill({id: "btc-open", side: "BUY", quantity: 1, price: 100, timestamp: 1, symbol: "BTCUSDT"}),
    fill({id: "eth-open", side: "BUY", quantity: 2, price: 50, timestamp: 2, symbol: "ETHUSDT"}),
    fill({id: "btc-close", side: "SELL", quantity: 1, price: 110, timestamp: 3, symbol: "BTCUSDT"}),
    fill({id: "eth-close", side: "SELL", quantity: 2, price: 45, timestamp: 4, symbol: "ETHUSDT"})
  ]);
  assert.equal(report.tradeSummaries.length, 2);
  assert.deepEqual(report.tradeSummaries.map(trade => trade.symbol).sort(), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(report.tradeSummary.closedTradeWins, 1);
  assert.equal(report.tradeSummary.closedTradeLosses, 1);
  assert.equal(report.tradeSummary.closedTradeCount, 2);
});

test("a partially realized but still open position is not classified as a whole-trade win or loss", () => {
  const report = derivePaperOutcomes([
    fill({id: "open", side: "BUY", quantity: 1, price: 100, fee: 1, timestamp: 1}),
    fill({id: "partial-close", side: "SELL", quantity: 0.5, price: 120, fee: 0.6, timestamp: 2})
  ]);
  const [trade] = report.tradeSummaries;
  assert.equal(trade.status, "OPEN");
  assert.equal(trade.result, null);
  assert.equal(trade.openedQuantity, 1);
  assert.equal(trade.closedQuantity, 0.5);
  assert.equal(trade.openQuantity, 0.5);
  assert.equal(trade.openLotCount, 1);
  assert.equal(trade.realizedGrossPnl, 10);
  assert.equal(trade.realizedFees, 1.1);
  assert.equal(trade.realizedNetPnl, 8.9);
  assert.equal(report.tradeSummary.closedTradeCount, 0);
  assert.equal(report.tradeSummary.openTradeCount, 1);
  assert.equal(report.tradeSummary.closedTradeWinRate, null);
  assert.equal(report.tradeSummary.closedTradeNetPnl, 0);
  assert.equal(report.tradeSummary.openTradeRealizedNetPnl, 8.9);
});

test("a reversal closes the old cycle and starts a distinct opposite-direction cycle", () => {
  const report = derivePaperOutcomes([
    fill({id: "long-open", side: "BUY", quantity: 1, price: 100, fee: 1, timestamp: 1}),
    fill({id: "reverse", side: "SELL", quantity: 1.5, price: 90, fee: 1.5, timestamp: 2})
  ]);
  assert.equal(report.tradeSummaries.length, 2);
  const long = report.tradeSummaries.find(trade => trade.direction === "LONG");
  const short = report.tradeSummaries.find(trade => trade.direction === "SHORT");
  assert.ok(long && short);
  assert.notEqual(long.tradeId, short.tradeId);
  assert.equal(long.status, "CLOSED");
  assert.equal(long.result, "LOSS");
  assert.equal(long.openedQuantity, 1);
  assert.equal(long.closedQuantity, 1);
  assert.equal(long.realizedGrossPnl, -10);
  assert.equal(long.realizedFees, 2);
  assert.equal(long.realizedNetPnl, -12);
  assert.deepEqual(long.closingOrderIds, ["reverse"]);
  assert.equal(short.status, "OPEN");
  assert.equal(short.result, null);
  assert.equal(short.openedQuantity, 0.5);
  assert.equal(short.openQuantity, 0.5);
  assert.deepEqual(short.openingOrderIds, ["reverse"]);
  assert.equal(report.tradeSummary.closedTradeLosses, 1);
  assert.equal(report.tradeSummary.openTradeCount, 1);
});

test("separate flat-to-flat cycles on the same symbol keep distinct deterministic identities", () => {
  const fills = [
    fill({id: "cycle-one-open", side: "BUY", quantity: 1, price: 100, timestamp: 1}),
    fill({id: "cycle-one-close", side: "SELL", quantity: 1, price: 110, timestamp: 2}),
    fill({id: "cycle-two-open", side: "BUY", quantity: 1, price: 110, timestamp: 3}),
    fill({id: "cycle-two-close", side: "SELL", quantity: 1, price: 100, timestamp: 4})
  ];
  const first = derivePaperOutcomes(fills);
  const replay = derivePaperOutcomes([...fills].reverse());
  assert.equal(first.tradeSummaries.length, 2);
  assert.deepEqual(first.tradeSummaries, replay.tradeSummaries);
  assert.notEqual(first.tradeSummaries[0].tradeId, first.tradeSummaries[1].tradeId);
  assert.equal(first.tradeSummary.closedTradeWins, 1);
  assert.equal(first.tradeSummary.closedTradeLosses, 1);
  assert.equal(first.tradeSummary.closedTradeWinRate, 0.5);
});

test("same-time sequence-backed fills keep the whole-trade result deterministic", () => {
  const fills = [
    fill({id: "same-time-open", side: "BUY", quantity: 1, price: 100, fee: 1,
      timestamp: 10, executionSequence: 10}),
    fill({id: "same-time-close", side: "SELL", quantity: 1, price: 110, fee: 1,
      timestamp: 10, executionSequence: 11})
  ];
  const a = derivePaperOutcomes(fills);
  const b = derivePaperOutcomes([...fills].reverse());
  assert.deepEqual(a.tradeSummaries, b.tradeSummaries);
  assert.equal(a.tradeSummaries[0].status, "CLOSED");
  assert.equal(a.tradeSummaries[0].result, "WIN");
});

test("HTTP learning report exposes open-only cycles without inventing realized outcomes", async () => {
  const store = new DurableStore();
  const open = fill({id: "http-open-only", side: "BUY", quantity: 2, price: 100, fee: 2, timestamp: 100});
  store.put("paper-fills", open.idempotencyKey, open);
  const server = await startTestServer({store});
  try {
    const response = await fetch(server.base + "/api/learning/outcomes");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.state, "open");
    assert.deepEqual(body.data.outcomes, []);
    assert.equal(body.data.summary.outcomeCount, 0);
    assert.equal(body.data.tradeSummary.tradeCount, 1);
    assert.equal(body.data.tradeSummary.openTradeCount, 1);
    assert.equal(body.data.tradeSummary.closedTradeCount, 0);
    assert.equal(body.data.tradeSummary.closedTradeWinRate, null);
    assert.equal(body.data.tradeSummaries[0].status, "OPEN");
    assert.equal(body.data.tradeSummaries[0].openQuantity, 2);
    assert.match(body.data.note, /Only open paper position cycles exist/);
  } finally {
    await server.close();
  }
});

test("learning UI separates whole-trade cycles from FIFO fragment and thesis summaries", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(html, /id="learning-trades-body"/);
  assert.match(html, /Whole-trade position cycles/);
  assert.match(html, /Session grouping is not inferred/);
  assert.match(app, /tradeSummary\.closedTradeWinRate/);
  assert.match(app, /tradeSummary\.openTradeRealizedNetPnl/);
  assert.match(app, /learning-trades-body/);
});
