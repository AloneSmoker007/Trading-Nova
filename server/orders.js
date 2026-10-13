// server/orders.js — durable, fail-closed paper order service.

import {mkdir, readFile, rename, unlink, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {PersistentPaperEngine} from "../src/execution/paper-persistent.js";
import {DEFAULT_PAPER_FEE_RATE, DEFAULT_PAPER_SLIPPAGE_BPS, estimateMarketExecution, validatePaperExecutionCostConfig} from "../src/execution/costs.js";
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
const unavailable = (code, message) => ({
  status: 503,
  body: {ok: false, state: "unavailable", error: {code, message}}
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

  if (type === "MARKET" && (body.stopPrice !== undefined || body.takeProfitPrice !== undefined)) {
    return {error: {code: "unsupported-order-trigger", message: "Market orders cannot include stop or take-profit trigger prices."}};
  }
  if (type === "LIMIT" && (body.stopPrice !== undefined || body.takeProfitPrice !== undefined)) {
    return {error: {code: "invalid-order-trigger", message: "Limit orders use price as the limit; stop and take-profit triggers are not allowed."}};
  }
  if (type === "STOP_LOSS" && body.takeProfitPrice !== undefined) {
    return {error: {code: "invalid-order-trigger", message: "STOP_LOSS accepts only a stopPrice trigger."}};
  }
  if (type === "TAKE_PROFIT" && body.stopPrice !== undefined) {
    return {error: {code: "invalid-order-trigger", message: "TAKE_PROFIT accepts only a takeProfitPrice trigger."}};
  }
  const stopPrice = type === "STOP_LOSS"
    ? (body.stopPrice === undefined ? body.price : body.stopPrice)
    : null;
  const takeProfitPrice = type === "TAKE_PROFIT"
    ? (body.takeProfitPrice === undefined ? body.price : body.takeProfitPrice)
    : null;
  if (stopPrice !== null && (!Number.isFinite(stopPrice) || stopPrice <= 0)) {
    return {error: {code: "invalid-stop-price", message: "stopPrice must be a positive finite number"}};
  }
  if (takeProfitPrice !== null && (!Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0)) {
    return {error: {code: "invalid-take-profit-price", message: "takeProfitPrice must be a positive finite number"}};
  }
  const price = type === "STOP_LOSS" ? stopPrice
    : type === "TAKE_PROFIT" ? takeProfitPrice
      : body.price;
  return {order: {
    symbol: symbol.symbol,
    side,
    type,
    quantity: body.quantity,
    price,
    limitPrice: type === "LIMIT" ? price : null,
    stopPrice,
    takeProfitPrice,
    idempotencyKey: body.idempotencyKey.trim(),
    reduceOnly: body.reduceOnly === true
  }};
}

function orderIntentHash(order) {
  const intent = {
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    type: order.type || "MARKET",
    price: order.type === "MARKET" ? null : order.price,
    reduceOnly: order.reduceOnly === true
  };
  return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

function isOrderTriggered(order, quote) {
  if (!quote || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) return false;
  if (order.type === "LIMIT") {
    return order.side === "BUY" ? quote.ask <= order.limitPrice : quote.bid >= order.limitPrice;
  }
  if (order.type === "STOP_LOSS") {
    return order.side === "BUY" ? quote.ask >= order.stopPrice : quote.bid <= order.stopPrice;
  }
  if (order.type === "TAKE_PROFIT") {
    return order.side === "BUY" ? quote.ask <= order.takeProfitPrice : quote.bid >= order.takeProfitPrice;
  }
  return false;
}

function estimateOrderExecution(order, quote, referencePrice, costs) {
  const execution = estimateMarketExecution({
    side: order.side,
    quantity: order.quantity,
    last: referencePrice,
    bid: quote.bid,
    ask: quote.ask,
    feeRate: costs.feeRate,
    slippageBps: costs.slippageBps
  });
  if (order.type !== "LIMIT") return execution;

  // Limit orders may execute at a better price, never worse than their limit.
  const executionPrice = order.side === "BUY"
    ? Math.min(execution.executionPrice, order.limitPrice)
    : Math.max(execution.executionPrice, order.limitPrice);
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
    throw new RangeError("limit execution price is invalid");
  }
  const notional = order.quantity * executionPrice;
  const fee = notional * costs.feeRate;
  const slippageCost = Math.abs(executionPrice - execution.quotePrice) * order.quantity;
  const slippageBps = Math.abs(executionPrice - execution.quotePrice) / execution.quotePrice * 10000;
  if (![notional, fee, slippageCost, slippageBps].every(Number.isFinite)) {
    throw new RangeError("limit execution costs are invalid");
  }
  return Object.freeze({...execution, executionPrice, notional, fee, slippageCost, slippageBps});
}

function noTrade(verdict, message = "order rejected by risk gate") {
  return {
    status: 400,
    body: {
      ok: false,
      state: "error",
      error: {
        code: "risk-gate-rejected",
        message,
        reason: verdict.reasons.join(", ")
      },
      verdict: {decision: "NO_TRADE", reasons: verdict.reasons}
    }
  };
}

export function applyFill(portfolio, fill) {
  if (!fill || !["BUY", "SELL"].includes(fill.side) || !Number.isFinite(fill.quantity) || fill.quantity <= 0
      || !Number.isFinite(fill.price) || fill.price <= 0) {
    throw new TypeError("invalid fill");
  }
  const fee = fill.fee === undefined ? 0 : fill.fee;
  if (!Number.isFinite(fee) || fee < 0) throw new TypeError("fill fee must be finite and non-negative");
  const markPrice = fill.markPrice === undefined ? fill.price : fill.markPrice;
  if (!Number.isFinite(markPrice) || markPrice <= 0) throw new TypeError("fill markPrice must be positive and finite");

  const positions = new Map((portfolio.positions || []).map((position) => [position.symbol, {...position}]));
  const previous = positions.get(fill.symbol) || {symbol: fill.symbol, quantity: 0, markPrice};
  const quantity = previous.quantity + (fill.side === "BUY" ? fill.quantity : -fill.quantity);
  // The portfolio is marked at the reference market price, while cash settles
  // at the executable fill price and immediately pays the simulated fee.
  const cash = portfolio.cash + (fill.side === "BUY" ? -1 : 1) * fill.quantity * fill.price - fee;
  if (!Number.isFinite(cash) || cash < 0) throw new RangeError("fill would make portfolio cash negative");
  if (quantitiesMatch(quantity, 0)) positions.delete(fill.symbol);
  else positions.set(fill.symbol, {...previous, quantity, markPrice});

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
  maxMarketAgeMs = 10000,
  feeRate = DEFAULT_PAPER_FEE_RATE,
  slippageBps = DEFAULT_PAPER_SLIPPAGE_BPS
}) {
  const executionCostConfig = validatePaperExecutionCostConfig({feeRate, slippageBps});
  const store = configuredStore ?? new DurableStore();
  const databaseBacked = configuredStore !== undefined;
  const engine = new PersistentPaperEngine(store, {feeRate: executionCostConfig.feeRate});
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
    const quotes = new Map();
    for (const symbol of symbols) {
      try {
        const result = await market.getTicker(symbol);
        const data = result?.data;
        const price = data?.last;
        if (result?.state === "ok" && Number.isFinite(result.ageMs)
            && result.ageMs <= maxMarketAgeMs && Number.isFinite(price) && price > 0) {
          marks.set(symbol, price);
          if (Number.isFinite(data.bid) && data.bid > 0
              && Number.isFinite(data.ask) && data.ask > 0 && data.bid <= data.ask) {
            quotes.set(symbol, {bid: data.bid, ask: data.ask});
          }
        }
      } catch {
        // Missing or failed critical data keeps the gate closed.
      }
    }
    if (marks.size !== symbols.length) return {fresh: false, portfolio, marks, quotes};
    try {
      const startingEquity = portfolio.equity - portfolio.dailyPnl;
      const marked = buildPortfolioState({
        cash: portfolio.cash,
        positions: portfolio.positions.map((position) => ({...position, markPrice: marks.get(position.symbol)})),
        startingEquity,
        peakEquity: portfolio.peakEquity ?? portfolio.equity
      });
      return {fresh: true, portfolio: marked, marks, quotes};
    } catch {
      return {fresh: false, portfolio, marks, quotes};
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
      let execution = null;
      if (marketState.fresh) {
        const quote = marketState.quotes.get(order.symbol);
        if (!quote) {
          return unavailable("execution-quote-unavailable", "a fresh, valid bid/ask quote is required for paper market execution");
        }
        try {
          execution = estimateMarketExecution({
            side: order.side,
            quantity: order.quantity,
            last: marketState.marks.get(order.symbol),
            bid: quote.bid,
            ask: quote.ask,
            feeRate: executionCostConfig.feeRate,
            slippageBps: executionCostConfig.slippageBps
          });
        } catch {
          return unavailable("execution-quote-unavailable", "the paper market execution quote or cost configuration is invalid");
        }
      }
      const executionPrice = execution?.executionPrice ?? null;
      const gatedOrder = Number.isFinite(executionPrice) && executionPrice > 0
        ? {...order, price: executionPrice}
        : order;
      const estimatedFee = execution?.fee ?? 0;
      if (gatedOrder.side === "BUY" && marketState.fresh
          && gatedOrder.quantity * gatedOrder.price + estimatedFee > portfolio.cash) {
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
      let projectedPortfolio = portfolio;
      if (execution) {
        try {
          // Simulate the exact executable price and fee before asking the Risk
          // Gate. This is a calculation only; persistence still happens after
          // a genuine ALLOW artifact is issued.
          projectedPortfolio = applyFill(portfolio, {
            symbol: order.symbol,
            side: order.side,
            quantity: order.quantity,
            price: execution.executionPrice,
            markPrice: execution.referencePrice,
            fee: execution.fee
          });
        } catch {
          return {
            status: 400,
            body: {
              ok: false,
              state: "error",
              error: {code: "risk-gate-rejected", message: "projected post-fill portfolio is invalid"},
              verdict: {decision: "NO_TRADE", reasons: ["PROJECTED_PORTFOLIO_UNAVAILABLE"]}
            }
          };
        }
      }
      const verdict = evaluateRiskGate({
        order: gatedOrder,
        portfolio: marketState.portfolio,
        projectedPortfolio,
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
            referencePrice: execution?.referencePrice ?? gatedOrder.price,
            execution,
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

  async function getOrders({limit = 100, offset = 0} = {}) {
    return serialize(async () => {
      if (!(await initialize())) return {state: "error", reason: storeError};
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
          || !Number.isSafeInteger(offset) || offset < 0) {
        return {state: "error", reason: "invalid-order-page"};
      }
      if (typeof store.listPage === "function") {
        const page = await store.listPage("paper-fills", {limit, offset});
        return {state: "ok", fills: page.items, total: page.total, limit, offset,
          hasMore: offset + page.items.length < page.total};
      }
      const orderFills = (await stateValues("paper-fills"))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      return {state: "ok", fills: orderFills.slice(offset, offset + limit), total: orderFills.length,
        limit, offset, hasMore: offset + limit < orderFills.length};
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
        executionCosts: {
          referencePrice: fill.referencePrice ?? fill.markPrice ?? fill.price,
          quoteBid: fill.quoteBid ?? null,
          quoteAsk: fill.quoteAsk ?? null,
          spreadBps: fill.spreadBps ?? null,
          spreadCost: fill.spreadCost ?? null,
          slippageBps: fill.slippageBps ?? null,
          slippageCost: fill.slippageCost ?? null,
          feeRate: fill.feeRate ?? null,
          fee: fill.fee ?? 0
        },
        note: "Paper only. Fill uses a fresh bid/ask quote, configured slippage and simulated fees. No real-money order was placed."
      }
    }
  };
}
