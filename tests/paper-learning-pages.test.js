import test from "node:test";
import assert from "node:assert/strict";
import {DurableStore} from "../src/persistence/store.js";
import {derivePaperOutcomes} from "../src/journal/outcomes.js";
import {startTestServer} from "./ws-d-helpers.js";

function history() {
  return Array.from({length: 202}, (_, index) => ({
    orderId: "page-fill-" + index,
    idempotencyKey: "page-fill-" + index,
    status: "RECONCILED", symbol: "BTCUSDT", side: index % 2 === 0 ? "BUY" : "SELL",
    quantity: 1, price: index % 2 === 0 ? 100 : 99, fee: 0.1, timestamp: index + 1
  }));
}

async function fixture(transform, run, fills = history()) {
  const store = new DurableStore();
  for (const fill of fills) store.put("paper-fills", fill.idempotencyKey, fill);
  const original = store.listPage.bind(store);
  const reads = [];
  store.listPage = (namespace, options) => {
    reads.push({...options});
    const page = original(namespace, options);
    return transform ? transform(page, options) : page;
  };
  let providerCalls = 0;
  const srv = await startTestServer({store, fetchImpl: async () => {
    providerCalls++;
    throw new Error("no provider call expected");
  }});
  try {
    await run({base: srv.base, store, reads, fills});
    assert.equal(providerCalls, 0);
  } finally {
    await srv.close();
  }
}

test("complete learning history spans pages and reproduces all FIFO losses", async () => {
  await fixture(null, async ({base, reads, fills}) => {
    const response = await fetch(base + "/api/learning/outcomes");
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    const expected = derivePaperOutcomes(fills);
    assert.deepEqual(data.outcomes, expected.outcomes);
    assert.equal(data.fillCount, 202);
    assert.equal(data.summary.losses, 101);
    assert.equal(data.summary.realizedNetPnl, expected.summary.realizedNetPnl);
    assert.deepEqual(reads, [{limit: 200, offset: 0}, {limit: 2, offset: 200}]);
  });
});

test("an honestly empty learning history remains available", async () => {
  await fixture(null, async ({base}) => {
    const response = await fetch(base + "/api/learning/outcomes");
    const data = (await response.json()).data;
    assert.equal(response.status, 200);
    assert.equal(data.state, "empty");
    assert.equal(data.fillCount, 0);
    assert.deepEqual(data.outcomes, []);
  }, []);
});

test("inconsistent page lengths cannot publish incomplete learning or authorize an autopsy", async t => {
  const cases = [
    ["short first page", (page, options) => options.offset === 0 ? {...page, items: page.items.slice(0, 199)} : page],
    ["short final page", (page, options) => options.offset === 200 ? {...page, items: page.items.slice(0, 1)} : page],
    ["empty final page", (page, options) => options.offset === 200 ? {...page, items: []} : page],
    ["oversized final page", (page, options) => options.offset === 200
      ? {...page, items: [...page.items, {...page.items[0], orderId: "extra", idempotencyKey: "extra"}]} : page],
    ["nonempty page claiming zero total", page => ({...page, total: 0})]
  ];
  for (const [name, transform] of cases) {
    await t.test(name, async () => {
      await fixture(transform, async ({base, store, fills}) => {
        const response = await fetch(base + "/api/learning/outcomes");
        assert.equal(response.status, 503, "inconsistent history must fail closed");
        const body = await response.json();
        assert.equal(body.error.code, "paper-learning-unavailable");
        assert.equal(body.data, undefined);
        const outcomeId = derivePaperOutcomes(fills).outcomes[0].outcomeId;
        const review = await fetch(base + "/api/journal/entry", {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({type: "loss-autopsy", outcomeId, title: "Partial history", text: "Must not be saved"})
        });
        assert.equal(review.status, 503);
        assert.equal((await review.json()).error.code, "paper-learning-unavailable");
        assert.equal(store.get("paper-journal", "main"), null);
        for (const fill of fills) assert.deepEqual(store.get("paper-fills", fill.idempotencyKey), fill);
      });
    });
  }
});
