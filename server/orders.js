// server/orders.js — durable, fail-closed paper order service.

import {mkdir, readFile, rename, unlink, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {randomUUID} from "node:crypto";
import {PersistentPaperEngine} from "../src/execution/paper-persistent.js";
import {DurableStore} from "../src/persistence/store.js";
import {buildPortfolioState, validatePortfolioState} from "../src/risk/portfolio.js";
import {createRiskConfig, evaluateRiskGate, hashOrderPayload, normalizeSide} from "../src/risk/gate.js";
import {quantitiesMatch} from "../src/reconciliation/reconcile.js";
import {loadPaperState} from "./state.js";
import {parseSymbol} from "./validate.js";

const DEFAULT_RISK_CONFIG = Object.freeze({
  version: "1",
  maxPositionNotional: 5000,
  maxGrossExposure: 15000,
  maxDailyLoss: 500,
  maxDrawdown: 0.1,
  maxLeverage: 1,
  maxConcentrationNotional: 5000
});
const {config: RISK_CONFIG, hash: RISK_CONFIG_HASH} = createRiskConfig(DEFAULT_RISK_CONFIG);
const ALLOWED_FIELDS = new Set(["symbol", "side", "quantity", "price", "idempotencyKey", "reduceOnly", "type", "stopPrice", "takeProfitPrice"]);
const fail = (status, code, message, reason) => ({
  status,
  body: {ok: false, state: "error", error: {code, message, ...(reason ? {reason} : {})}}
});

function parseOrderRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {error: {code: "invalid-request", message: "request body must be a JSON object"}};
  }
  if (Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key))) {
    return {error: {code: "unexpected-field", message: "request contains an unsupported field"}};
  }
  const symbol = parseSymbol(body.symbol);
  if (!symbol.ok) return {error: {code: symbol.code, message: symbol.message}};

  const side = normalizeSide(body.side);
  if (!["BUY", "SELL"].includes(side)) {
    return {error: {code: "invalid-side", message: "side must be BUY or SELL"}};
  }
  if (!Number.isFinite(body.quantity) || body.quantity <= 0) {
    return {error: {code: "invalid-quantity", message: "quantity must be a positive number"}};
  }
  if (!Number.isFinite(body.price) || body.price <= 0) {
    return {error: {code: "invalid-price", message: "price must be a positive number"}};
  }
  if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim()
      || body.idempotencyKey.trim().length > 128) {
    return {error: {code: "missing-idempotency-key", message: "idempotencyKey must contain 1-128 characters"}};
  }
  if (body.reduceOnly !== undefined && typeof body.reduceOnly !== "boolean") {
    return {error: {code: "invalid-reduce-only", message: "reduceOnly must be a boolean"}};
  }
  const type = typeof body.type === "string" ? body.type.toUpperCase() : "MARKET";
  if (!["MARKET", "LIMIT", "STOP_LOSS", "TAKE_PROFIT"].includes(type)) {
    return {error: {code: "invalid-type", message: "type must be MARKET, LIMIT, STOP_LOSS, or TAKE_PROFIT"}};
  }
  if (body.stopPrice !== undefined && (!Number.isFinite(body.stopPrice) || body.stopPrice <= 0)) {
    return {error: {code: "invalid-stop-price", message: "stopPrice must be a positive number"}};
  }
  if (body.takeProfitPrice !== undefined && (!Number.isFinite(body.takeProfitPrice) || body.takeProfitPrice <= 0)) {
    return {error: {code: "invalid-take-profit-price", message: "takeProfitPrice must be a positive number"}};
  }
  return {order: {
    symbol: symbol.symbol,
    side,
    type,
    quantity: body.quantity,
    price: body.price,
    ...(body.stopPrice ? {stopPrice: body.stopPrice} : {}),
    ...(body.takeProfitPrice ? {takeProfitPrice: body.takeProfitPrice} : {}),
    idempotencyKey: body.idempotencyKey.trim(),
    reduceOnly: body.reduceOnly === true
  }};
}

export function applyFill(portfolio, fill) {
  const positions = new Map((portfolio.positions || []).map((position) => [position.symbol, {...position}]));
  const previous = positions.get(fill.symbol) || {symbol: fill.symbol, quantity: 0, markPrice: fill.price};
  const quantity = previous.quantity + (fill.side === "BUY" ? fill.quantity : -fill.quantity);
  const cash = portfolio.cash + (fill.side === "BUY" ? -1 : 1) * fill.quantity * fill.price;
  if (quantitiesMatch(quantity, 0)) positions.delete(fill.symbol);
  else positions.set(fill.symbol, {...previous, quantity, markPrice: fill.price});

  const startingEquity = portfolio.equity - portfolio.dailyPnl;
  return buildPortfolioState({
    cash,
    positions: [...positions.values()],
    startingEquity,
    peakEquity: portfolio.peakEquity ?? portfolio.equity
  });
}

export function createPaperOrderService({
  market,
  stateFile,
  executionStateFile = "db/paper-orders.json",
  store: configuredStore,
  now = () => Date.now(),
  tradingMode = "paper",
  maxMarketAgeMs = 10000
}) {
  const store = configuredStore ?? new DurableStore();
  const databaseBacked = configuredStore !== undefined;
  const engine = new PersistentPaperEngine(store);
  let initialization;
  let storeError = null;
  let queue = Promise.resolve();

  function serialize(work) {
    const result = queue.then(work, work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function initialize() {
    if (!initialization) {
      initialization = (async () => {
        if (databaseBacked) {
          try {
            if (typeof store.health === "function" && !(await store.health())) {
              throw new Error("database health check failed");
            }
            await stateValues("paper-fills");
          } catch {
            storeError = "paper-order-state-unavailable";
          }
          return;
        }
        try {
          const text = await readFile(executionStateFile, "utf8");
          store.restore(JSON.parse(text));
        } catch (error) {
          if (error?.code !== "ENOENT") storeError = "paper-order-state-invalid";
        }
      })();
    }
    await initialization;
    return !storeError;
  }

  async function persist() {
    if (databaseBacked) return;
    const temporary = `${executionStateFile}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(executionStateFile), {recursive: true});
      await writeFile(temporary, JSON.stringify(store.snapshot()), {flag: "wx", mode: 0o600});
      await rename(temporary, executionStateFile);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      storeError = "paper-order-state-unavailable";
      throw error;
    }
  }

  async function baseState() {
    const snapshot = await loadPaperState(stateFile, now());
    if (snapshot.state === "error") return {error: "paper-state-error", reason: snapshot.reason};
    if (snapshot.journal?.integrity === "broken") {
      return {error: "paper-journal-integrity-broken"};
    }
    if (snapshot.state === "empty") {
      return {
        state: "empty",
        portfolio: buildPortfolioState({cash: 10000, startingEquity: 10000, positions: []}),
        limits: null,
        updatedAt: null
      };
    }
    if (!snapshot.portfolio) return {error: "paper-state-invalid"};
    return snapshot;
  }

  async function stateValues(namespace) {
    if (typeof store.list === "function") return store.list(namespace);
    const prefix = `${namespace}:`;
    return [...store.state.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value);
  }

  async function currentPortfolio(base, fillValues) {
    const saved = await store.get("paper-portfolio", "current");
    if (saved) {
      try {
        return validatePortfolioState(saved);
      } catch {
        return null;
      }
    }
    let portfolio = base.portfolio;
    for (const fill of fillValues) {
      if (fill?.status !== "RECONCILED" || !Number.isFinite(fill.quantity)
          || !Number.isFinite(fill.price) || !["BUY", "SELL"].includes(fill.side)) return null;
      try {
        portfolio = applyFill(portfolio, fill);
      } catch {
        return null;
      }
    }
    return portfolio;
  }

  async function freshPortfolio(portfolio, newSymbol) {
    const symbols = [...new Set([newSymbol, ...(portfolio.positions || []).map((p) => p.symbol)])];
    const marks = new Map();
    for (const symbol of symbols) {
      try {
        const result = await market.getTicker(symbol);
        const price = result?.data?.last;
        if (result?.state === "ok" && Number.isFinite(result.ageMs)
            && result.ageMs <= maxMarketAgeMs && Number.isFinite(price) && price > 0) {
          marks.set(symbol, price);
        }
      } catch {
        // Missing or failed critical data keeps the gate closed.
      }
    }
    if (marks.size !== symbols.length) return {fresh: false, portfolio, marks};
    try {
      const startingEquity = portfolio.equity - portfolio.dailyPnl;
      const marked = buildPortfolioState({
        cash: portfolio.cash,
        positions: portfolio.positions.map((position) => ({...position, markPrice: marks.get(position.symbol)})),
        startingEquity,
        peakEquity: portfolio.peakEquity ?? portfolio.equity
      });
      return {fresh: true, portfolio: marked, marks};
    } catch {
      return {fresh: false, portfolio, marks};
    }
  }

  async function getPortfolio() {
    return serialize(async () => {
      if (!(await initialize())) return {state: "error", reason: storeError};
      const base = await baseState();
      if (base.error) return {state: "error", reason: base.reason || base.error};
      const fillValues = await stateValues("paper-fills");
      const portfolio = await currentPortfolio(base, fillValues);
      if (!portfolio) return {state: "error", reason: "paper-order-state-invalid"};
      const hasOrders = fillValues.length > 0;
      if (!hasOrders && base.state === "empty" && !(await store.get("paper-portfolio", "current"))) {
        return {state: "empty", portfolio: null, limits: null, updatedAt: null, ageMs: null};
      }
      const latestFill = fillValues.reduce((latest, fill) => Math.max(latest, fill.timestamp || 0), 0);
      const updatedAt = latestFill || base.updatedAt || null;
      return {
        state: "ok",
        portfolio,
        limits: base.limits,
        updatedAt,
        ageMs: updatedAt === null ? null : Math.max(0, now() - updatedAt)
      };
    });
  }

  async function submit(body) {
    return serialize(async () => {
      if (tradingMode !== "paper") {
        return fail(403, "trading-mode-not-paper", "order submission only available in paper trading mode");
      }
      if (!(await initialize())) return fail(500, storeError, "paper order state is unavailable");
      const parsed = parseOrderRequest(body);
      if (parsed.error) return {status: 400, body: {ok: false, state: "error", error: parsed.error}};
      const order = parsed.order;
      const prior = await store.get("paper-fills", order.idempotencyKey);
      if (prior) {
        const intentHash = hashOrderPayload({...order, price: 0});
        if (prior.intentHash !== intentHash) {
          return fail(409, "idempotency-key-reused", "idempotencyKey was already used for a different order");
        }
        return orderSuccess(order, prior, {decision: "ALLOW", replayed: true}, true);
      }

      const base = await baseState();
      if (base.error) return fail(500, base.error, "paper portfolio state is unavailable", base.reason);
      let portfolio = await currentPortfolio(base, await stateValues("paper-fills"));
      if (!portfolio) return fail(500, "paper-portfolio-invalid", "paper portfolio state is invalid");
      const marketState = await freshPortfolio(portfolio, order.symbol);
      if (marketState.fresh) {
        portfolio = marketState.portfolio;
        try {
          await store.put("paper-portfolio", "current", portfolio);
          await persist();
        } catch {
          storeError ||= "paper-order-state-unavailable";
          return fail(500, "paper-order-state-unavailable", "paper order state is unavailable");
        }
      }
      const executionPrice = marketState.fresh ? marketState.marks.get(order.symbol) : null;
      const gatedOrder = Number.isFinite(executionPrice) && executionPrice > 0
        ? {...order, price: executionPrice}
        : order;
      if (gatedOrder.side === "BUY" && marketState.fresh
          && gatedOrder.quantity * gatedOrder.price > portfolio.cash) {
        return {
          status: 400,
          body: {
            ok: false,
            state: "error",
            error: {
              code: "risk-gate-rejected",
              message: "order rejected by risk gate",
              reason: "INSUFFICIENT_CASH"
            },
            verdict: {decision: "NO_TRADE", reasons: ["INSUFFICIENT_CASH"]}
          }
        };
      }
      const verdict = evaluateRiskGate({
        order: gatedOrder,
        portfolio: marketState.portfolio,
        riskConfig: RISK_CONFIG,
        dataFresh: marketState.fresh,
        killSwitch: base.limits?.ok === false,
        approvedConfigHash: RISK_CONFIG_HASH
      });
      if (verdict.decision !== "ALLOW") {
        return {
          status: 400,
          body: {
            ok: false,
            state: "error",
            error: {
              code: "risk-gate-rejected",
              message: "order rejected by risk gate",
              reason: verdict.reasons.join(", ")
            },
            verdict: {decision: "NO_TRADE", reasons: verdict.reasons}
          }
        };
      }
      try {
        const fill = await engine.submit(
          {...gatedOrder, id: order.idempotencyKey},
          {
            markPrice: gatedOrder.price,
            gateArtifact: verdict.artifact,
            onFill: async (tx, committedFill) => {
              await tx.put("paper-portfolio", "current", applyFill(portfolio, committedFill));
            }
          }
        );
        await persist();
        return orderSuccess(gatedOrder, fill, verdict, false);
      } catch {
        storeError ||= "paper-order-state-unavailable";
        return fail(500, "paper-order-not-persisted", "paper order could not be safely persisted");
      }
    });
  }

  async function getOrders() {
    return serialize(async () => {
      if (!(await initialize())) return {state: "error", reason: storeError};
      const orderFills = (await stateValues("paper-fills")).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      return {state: "ok", fills: orderFills, total: orderFills.length};
    });
  }

  return {submit, getPortfolio, getOrders};
}

function orderSuccess(order, fill, verdict, replayed) {
  return {
    status: 200,
    body: {
      ok: true,
      data: {
        state: replayed ? "replayed" : "ok",
        order,
        fill: {...fill, tier: "paper"},
        verdict: {
          decision: "ALLOW",
          replayed,
          orderNotional: verdict.orderNotional ?? order.quantity * order.price,
          projectedGrossExposure: verdict.projectedGrossExposure ?? null,
          projectedSymbolExposure: verdict.projectedSymbolExposure ?? null
        },
        reconciliation: {state: fill.status === "RECONCILED" ? "reconciled" : "unknown"},
        note: "Paper only. No real-money order was placed."
      }
    }
  };
}
