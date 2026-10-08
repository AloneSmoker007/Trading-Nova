import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createPaperOrderService} from "../server/orders.js";

function marketAt({price = 100, now, ageMs = 0} = {}) {
  return {
    async getTicker(symbol) {
      return {
        state: "ok",
        data: {symbol, last: price, bid: price - 0.5, ask: price + 0.5},
        ageMs: ageMs
      };
    }
  };
}

async function tempPaths() {
  const dir = await mkdtemp(join(tmpdir(), "trading-nova-phase7-"));
  return {dir, stateFile: join(dir, "paper-state.json"), executionStateFile: join(dir, "paper-orders.json")};
}

function order(overrides = {}) {
  return {
    symbol: "BTCUSDT",
    side: "BUY",
    quantity: 1,
    price: 100,
    idempotencyKey: "phase7-order-1",
    ...overrides
  };
}

test("Phase 7: fresh paper order passes gate and reconciles", async () => {
  const paths = await tempPaths();
  try {
    const service = createPaperOrderService({
      market: marketAt({price: 100}),
      ...paths
    });
    const result = await service.submit(order());
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.data.fill.tier, "paper");
    assert.equal(result.body.data.fill.status, "RECONCILED");
    assert.equal(result.body.data.verdict.decision, "ALLOW");
    assert.equal(result.body.data.reconciliation.state, "reconciled");

    const portfolio = await service.getPortfolio();
    assert.equal(portfolio.state, "ok");
    assert.equal(portfolio.portfolio.positions[0].symbol, "BTCUSDT");
    assert.equal(portfolio.portfolio.positions[0].quantity, 1);
  } finally {
    await rm(paths.dir, {recursive: true, force: true});
  }
});

test("Phase 7: identical replay is idempotent and creates no second fill", async () => {
  const paths = await tempPaths();
  try {
    const service = createPaperOrderService({market: marketAt({price: 100}), ...paths});
    const first = await service.submit(order());
    const replay = await service.submit(order());
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.state, "replayed");
    assert.equal(replay.body.data.fill.orderId, first.body.data.fill.orderId);

    const portfolio = await service.getPortfolio();
    assert.equal(portfolio.portfolio.positions[0].quantity, 1);
  } finally {
    await rm(paths.dir, {recursive: true, force: true});
  }
});

test("Phase 7: idempotency-key reuse with changed intent is rejected", async () => {
  const paths = await tempPaths();
  try {
    const service = createPaperOrderService({market: marketAt({price: 100}), ...paths});
    assert.equal((await service.submit(order())).status, 200);
    const changed = await service.submit(order({quantity: 2}));
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, "idempotency-key-reused");
  } finally {
    await rm(paths.dir, {recursive: true, force: true});
  }
});

test("Phase 7: stale critical market data fails closed", async () => {
  const paths = await tempPaths();
  try {
    const service = createPaperOrderService({
      market: marketAt({price: 100, ageMs: 10001}),
      ...paths
    });
    const result = await service.submit(order());
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "risk-gate-rejected");
    assert.match(result.body.error.reason, /STALE_CRITICAL_DATA/);
  } finally {
    await rm(paths.dir, {recursive: true, force: true});
  }
});

test("Phase 7: position limit rejects oversized paper order", async () => {
  const paths = await tempPaths();
  try {
    const service = createPaperOrderService({
      market: marketAt({price: 6000}),
      ...paths
    });
    const result = await service.submit(order({price: 6000}));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "risk-gate-rejected");
    assert.match(result.body.error.reason, /MAX_POSITION/);
  } finally {
    await rm(paths.dir, {recursive: true, force: true});
  }
});

test("Phase 7: paper order state survives service restart", async () => {
  const paths = await tempPaths();
  try {
    const firstService = createPaperOrderService({market: marketAt({price: 100}), ...paths});
    const first = await firstService.submit(order());
    assert.equal(first.status, 200);

    const persisted = JSON.parse(await readFile(paths.executionStateFile, "utf8"));
    assert.ok(persisted.state);

    const restarted = createPaperOrderService({market: marketAt({price: 100}), ...paths});
    const replay = await restarted.submit(order());
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.state, "replayed");
    assert.equal(replay.body.data.fill.orderId, first.body.data.fill.orderId);
  } finally {
    await rm(paths.dir, {recursive: true, force: true});
  }
});
