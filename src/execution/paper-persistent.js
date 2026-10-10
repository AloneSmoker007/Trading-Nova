import { assertGateArtifact, hashOrderPayload, normalizeSide, normalizeSymbol } from "../risk/gate.js";
import {DEFAULT_PAPER_FEE_RATE, DEFAULT_PAPER_SLIPPAGE_BPS, validatePaperExecutionCostConfig} from "./costs.js";

export class PersistentPaperEngine {
  constructor(store, {feeRate = DEFAULT_PAPER_FEE_RATE} = {}) {
    if (!store || typeof store.transactIdempotent !== "function") throw new Error("durable store required");
    this.store = store;
    this.feeRate = validatePaperExecutionCostConfig({feeRate, slippageBps: DEFAULT_PAPER_SLIPPAGE_BPS}).feeRate;
  }

  async submit(order, {
    markPrice,
    referencePrice = markPrice,
    gateArtifact,
    onFill,
    execution = null
  } = {}) {
    const side = normalizeSide(order?.side);
    if (!order?.idempotencyKey || !order?.symbol || !["BUY", "SELL"].includes(side)
        || !Number.isFinite(order.quantity) || order.quantity <= 0) {
      throw new Error("invalid paper order");
    }
    if (!Number.isFinite(markPrice) || markPrice <= 0) throw new Error("execution price required");
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) throw new Error("reference mark price required");
    const symbol = normalizeSymbol(order.symbol);
    // Idempotency payload = order INTENT (market price is not order intent);
    // reusing a key with different intent is a caller bug and always refused.
    const intentHash = hashOrderPayload({symbol, side, quantity: order.quantity, price: 0, reduceOnly: order.reduceOnly === true});
    if (typeof this.store.get === "function") {
      const prior = await this.store.get("paper-fills", order.idempotencyKey);
      if (prior && prior.intentHash !== intentHash) throw new Error("idempotency_key_reuse_with_different_payload");
    }

    // The execution price is the exact payload authorized by the Risk Gate.
    const gatedOrder = {symbol, side, quantity: order.quantity, price: markPrice, reduceOnly: order.reduceOnly === true};
    const notional = order.quantity * markPrice;
    const fee = notional * this.feeRate;
    if (!Number.isFinite(notional) || notional <= 0 || !Number.isFinite(fee) || fee < 0) {
      throw new Error("paper execution costs are not finite");
    }
    if (execution && (execution.side !== side || execution.quantity !== order.quantity
        || execution.executionPrice !== markPrice || execution.feeRate !== this.feeRate
        || execution.notional !== notional || execution.fee !== fee)) {
      throw new Error("paper execution cost estimate does not match the authorized fill");
    }

    return this.store.transactIdempotent("paper:" + order.idempotencyKey, async (tx) => {
      const writer = tx ?? this.store;
      const prior = typeof writer.get === "function" ? await writer.get("paper-fills", order.idempotencyKey) : null;
      if (prior) {
        // Replay of an already-executed order returns its stored fill and costs;
        // nothing new executes, so no new gate verdict is required.
        if (prior.intentHash !== intentHash) throw new Error("idempotency_key_reuse_with_different_payload");
        return prior;
      }
      // No order executes without a genuine ALLOW artifact bound to this payload.
      assertGateArtifact(gateArtifact, gatedOrder);
      const fill = {
        orderId: order.idempotencyKey,
        side,
        symbol,
        quantity: order.quantity,
        filledQuantity: order.quantity,
        price: markPrice,
        markPrice: referencePrice,
        referencePrice,
        notional,
        fee,
        feeRate: this.feeRate,
        quoteBid: execution?.quoteBid ?? null,
        quoteAsk: execution?.quoteAsk ?? null,
        midPrice: execution?.midPrice ?? null,
        quotePrice: execution?.quotePrice ?? null,
        spreadBps: execution?.spreadBps ?? null,
        spreadCost: execution?.spreadCost ?? null,
        slippageBps: execution?.slippageBps ?? null,
        slippageCost: execution?.slippageCost ?? null,
        status: "RECONCILED",
        timestamp: Date.now(),
        intentHash
      };
      // Fill, fee and portfolio mutation commit atomically through the transaction handle.
      await writer.put("paper-fills", order.idempotencyKey, fill);
      if (onFill) await onFill(writer, fill);
      return fill;
    });
  }
}
