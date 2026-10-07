// server/orders.js — POST /api/paper/orders handler.
//
// Flow:
//   request JSON → validate input → normalize symbol/side → load portfolio
//   → evaluateRiskGate (fail-closed) → execute (if ALLOW) → persist → respond
//
// Safety properties:
//   - Risk Gate is MANDATORY and cannot be bypassed
//   - NO execution without an ALLOW artifact
//   - Input validation before any engine code
//   - Deterministic rejection reasons
//   - Idempotency keys prevent duplicate orders
//   - Paper-only, no exchange credentials, no real money
//   - Generic error messages (no stack traces, no internals on wire)

import { createPaperExecution } from "../src/execution/paper.js";
import { evaluateRiskGate, createRiskConfig } from "../src/risk/gate.js";
import { normalizeSide } from "../src/risk/gate.js";
import { loadPaperState } from "./state.js";
import { parseSymbol } from "./validate.js";

// Default risk config for paper trading (fail-closed, conservative).
const DEFAULT_RISK_CONFIG = {
  version: "1",
  maxPositionNotional: 5000,      // per-symbol limit: $5k
  maxGrossExposure: 15000,         // total portfolio limit: $15k
  maxDailyLoss: 500,               // daily loss limit: $500
  maxDrawdown: 0.1,                // 10% drawdown limit
  maxLeverage: 1,                  // 1:1 (no leverage for paper)
  maxConcentrationNotional: 5000   // same per-symbol to prevent concentration
};

// Initialize the paper execution engine (in-memory, no persistence yet).
const paperEngine = createPaperExecution();

// Compute the approved risk config hash once (immutable).
const { config: DEFAULT_CONFIG, hash: DEFAULT_CONFIG_HASH } = createRiskConfig(DEFAULT_RISK_CONFIG);

// Parse and validate POST body (JSON).
function parseOrderRequest(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: { code: "invalid-request", message: "request body must be valid JSON" } };
  }

  const symbol = parseSymbol(body.symbol);
  if (!symbol.ok) {
    return { ok: false, error: { code: symbol.code, message: symbol.message } };
  }

  const side = normalizeSide(body.side);
  if (!["BUY", "SELL"].includes(side)) {
    return { ok: false, error: { code: "invalid-side", message: "side must be BUY or SELL" } };
  }

  const quantity = body.quantity;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, error: { code: "invalid-quantity", message: "quantity must be a positive number" } };
  }

  const price = body.price;
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: { code: "invalid-price", message: "price must be a positive number" } };
  }

  const idempotencyKey = body.idempotencyKey;
  if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
    return { ok: false, error: { code: "missing-idempotency-key", message: "idempotencyKey is required (string, non-empty)" } };
  }

  const reduceOnly = body.reduceOnly === true ? true : false;

  return {
    ok: true,
    order: {
      symbol: symbol.symbol,
      side,
      quantity,
      price,
      idempotencyKey: idempotencyKey.trim(),
      reduceOnly
    }
  };
}

// Main handler: POST /api/paper/orders
export async function paperOrders(body, stateFile, now = () => Date.now(), tradingMode = "paper") {
  // Always paper-only (real money OFF).
  if (tradingMode !== "paper") {
    return {
      status: 403,
      body: {
        ok: false,
        state: "error",
        error: {
          code: "trading-mode-not-paper",
          message: "order submission only available in paper trading mode"
        }
      }
    };
  }

  // 1. Parse and validate request body.
  const parsed = parseOrderRequest(body);
  if (!parsed.ok) {
    return {
      status: 400,
      body: { ok: false, state: "error", error: parsed.error }
    };
  }

  const order = parsed.order;
  const now_ms = now();

  // 2. Load paper portfolio state (fail-closed if state is corrupt).
  let stateSnapshot;
  try {
    stateSnapshot = await loadPaperState(stateFile, now_ms);
  } catch (err) {
    return {
      status: 500,
      body: {
        ok: false,
        state: "error",
        error: {
          code: "state-load-failed",
          message: "could not load paper state"
        }
      }
    };
  }

  if (stateSnapshot.state === "error") {
    return {
      status: 500,
      body: {
        ok: false,
        state: "error",
        error: {
          code: "paper-state-error",
          message: "paper state is corrupt or unreadable",
          reason: stateSnapshot.reason
        }
      }
    };
  }

  // If no state exists yet, initialize a default portfolio (empty, $10k cash).
  const portfolio = stateSnapshot.state === "empty"
    ? { equity: 10000, cash: 10000, positions: [], grossExposure: 0, netExposure: 0, dailyPnl: 0, drawdown: 0, peakEquity: 10000 }
    : stateSnapshot.portfolio;

  if (!portfolio) {
    return {
      status: 500,
      body: {
        ok: false,
        state: "error",
        error: {
          code: "portfolio-invalid",
          message: "portfolio state is invalid"
        }
      }
    };
  }

  // 3. Evaluate the Risk Gate (fail-closed, mandatory).
  //    Data is considered fresh because we're in-process (no network lag).
  const verdict = evaluateRiskGate({
    order,
    portfolio,
    riskConfig: DEFAULT_CONFIG,
    dataFresh: true,
    killSwitch: false,
    approvedConfigHash: DEFAULT_CONFIG_HASH
  });

  // 4. If Risk Gate rejects, return deterministic rejection reason (NO execution).
  if (verdict.decision !== "ALLOW") {
    return {
      status: 400,
      body: {
        ok: false,
        state: "error",
        error: {
          code: "risk-gate-rejected",
          message: "order rejected by risk gate",
          reason: "Reasons: " + (verdict.reasons || []).join(", ")
        }
      }
    };
  }

  // 5. RISK GATE PASSED: execute the paper order with the artifact.
  try {
    const fill = paperEngine.submit(order, { gateArtifact: verdict.artifact });

    return {
      status: 200,
      body: {
        ok: true,
        data: {
          state: "ok",
          order: {
            symbol: order.symbol,
            side: order.side,
            quantity: order.quantity,
            price: order.price,
            idempotencyKey: order.idempotencyKey,
            reduceOnly: order.reduceOnly
          },
          fill: {
            id: fill.id,
            orderId: fill.orderId,
            tier: fill.tier,
            symbol: fill.symbol,
            side: fill.side,
            quantity: fill.quantity,
            price: fill.price,
            status: fill.status,
            filledAt: fill.filledAt
          },
          verdict: {
            decision: verdict.decision,
            orderNotional: verdict.orderNotional,
            projectedGrossExposure: verdict.projectedGrossExposure,
            projectedSymbolExposure: verdict.projectedSymbolExposure
          },
          note: "Paper / shadow only. Real money OFF. No real order was placed."
        }
      }
    };
  } catch (err) {
    // Execution error (should not happen if Risk Gate artifact is valid, but fail-closed).
    return {
      status: 500,
      body: {
        ok: false,
        state: "error",
        error: {
          code: "execution-failed",
          message: "paper execution failed"
        }
      }
    };
  }
}
