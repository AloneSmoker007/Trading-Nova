import { assertGateArtifact, hashOrderPayload, normalizeSide, normalizeSymbol } from "../risk/gate.js";
import {DEFAULT_PAPER_FEE_RATE, DEFAULT_PAPER_SLIPPAGE_BPS, validatePaperExecutionCostConfig} from "./costs.js";

const EPSILON = 1e-12;

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
    authorizeFill,
    onFill,
    execution = null
  } = {}) {
    const side = normalizeSide(order?.side);
    if (!order?.idempotencyKey || !order?.symbol || !["BUY", "SELL"].includes(side)
        || !Number.isFinite(order.quantity) || order.quantity <= 0) {
      throw new Error("invalid paper order");
    }
    const fillQuantity = order.fillQuantity === undefined ? order.quantity : order.fillQuantity;
    if (!Number.isFinite(fillQuantity) || fillQuantity <= 0 || fillQuantity > order.quantity + EPSILON) {
      throw new Error("invalid paper execution quantity");
    }
    const executionKey = order.executionKey === undefined ? null : order.executionKey;
    if (executionKey !== null && (typeof executionKey !== "string" || !executionKey.trim() || executionKey.length > 128)) {
      throw new Error("invalid paper execution key");
    }
    if (!Number.isFinite(markPrice) || markPrice <= 0) throw new Error("execution price required");
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) throw new Error("reference mark price required");
    const symbol = normalizeSymbol(order.symbol);
    // Idempotency payload = original order INTENT, not the quantity of one
    // partial execution slice. Reusing a key with different intent is refused.
    const intentHash = hashOrderPayload({symbol, side, quantity: order.quantity, price: 0, reduceOnly: order.reduceOnly === true});
    if (typeof this.store.get === "function") {
      const prior = await this.store.get("paper-fills", order.idempotencyKey);
      if (prior && prior.intentHash !== intentHash) throw new Error("idempotency_key_reuse_with_different_payload");
    }

    // The Risk Gate artifact authorizes exactly this execution slice.
    const gatedOrder = {symbol, side, quantity: fillQuantity, price: markPrice, reduceOnly: order.reduceOnly === true};
    const notional = fillQuantity * markPrice;
    const fee = notional * this.feeRate;
    if (!Number.isFinite(notional) || notional <= 0 || !Number.isFinite(fee) || fee < 0) {
      throw new Error("paper execution costs are not finite");
    }
    if (execution && (execution.side !== side || execution.quantity !== fillQuantity
        || execution.executionPrice !== markPrice || execution.feeRate !== this.feeRate
        || execution.notional !== notional || execution.fee !== fee)) {
      throw new Error("paper execution cost estimate does not match the authorized fill");
    }

    const transactionKey = executionKey
      ? "paper:" + order.idempotencyKey + ":" + executionKey
      : "paper:" + order.idempotencyKey;
    return this.store.transactIdempotent(transactionKey, async (tx) => {
      const writer = tx ?? this.store;
      if (typeof writer.lockPortfolio !== "function") throw new Error("paper portfolio transaction lock required");
      await writer.lockPortfolio();
      if (typeof writer.lock !== "function") throw new Error("paper order transaction lock required");
      await writer.lock("order:" + order.idempotencyKey);
      const prior = typeof writer.get === "function" ? await writer.get("paper-fills", order.idempotencyKey) : null;
      if (prior) {
        if (prior.intentHash !== intentHash) throw new Error("idempotency_key_reuse_with_different_payload");
        if (!executionKey || prior.remainingQuantity <= EPSILON) return prior;
        if (!Array.isArray(prior.executionSlices)) {
          throw new Error("legacy paper fill cannot be extended without authoritative slice history");
        }
        if (prior.executionSlices.some(slice => slice.executionKey === executionKey)) return prior;
      }
      // Re-authorize after the global portfolio lock is held. The callback
      // reads the latest committed portfolio and issues the final ALLOW artifact.
      const authorization = typeof authorizeFill === "function"
        ? await authorizeFill(writer, {
          order, gatedOrder, markPrice, referencePrice, execution,
          fill: {symbol, side, quantity: fillQuantity, price: markPrice, markPrice: referencePrice, fee}
        })
        : {artifact: gateArtifact, context: null};
      assertGateArtifact(authorization?.artifact, gatedOrder);
      const executionSequence = await writer.nextPaperSequence();
      const timestamp = Date.now();
      const slice = {
        fillId: order.idempotencyKey + ":" + executionSequence,
        idempotencyKey: order.idempotencyKey + ":" + executionSequence,
        executionKey: executionKey ?? "complete",
        sequenceVersion: 1,
        executionSequence,
        orderId: order.orderId || order.idempotencyKey,
        type: order.type || "MARKET",
        ...(order.limitPrice !== null && order.limitPrice !== undefined ? {limitPrice: order.limitPrice} : {}),
        ...(order.stopPrice !== null && order.stopPrice !== undefined ? {stopPrice: order.stopPrice} : {}),
        ...(order.takeProfitPrice !== null && order.takeProfitPrice !== undefined ? {takeProfitPrice: order.takeProfitPrice} : {}),
        orderIntentHash: order.orderIntentHash || null,
        ...(order.thesisRef ? {thesisRef: order.thesisRef} : {}),
        reduceOnly: order.reduceOnly === true,
        side,
        symbol,
        quantity: fillQuantity,
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
        bookUpdateId: execution?.bookUpdateId ?? null,
        participationRate: execution?.participationRate ?? null,
        liquidityModel: execution?.liquidityModel ?? null,
        status: "RECONCILED",
        timestamp,
        thesisRef: order.thesisRef ?? null
      };
      const slices = [...(prior?.executionSlices || []), slice];
      const totalQuantity = slices.reduce((sum, item) => sum + item.quantity, 0);
      const totalNotional = slices.reduce((sum, item) => sum + item.notional, 0);
      const totalFee = slices.reduce((sum, item) => sum + item.fee, 0);
      const totalSpreadCost = slices.reduce((sum, item) => sum + (item.spreadCost ?? 0), 0);
      const totalSlippageCost = slices.reduce((sum, item) => sum + (item.slippageCost ?? 0), 0);
      const weighted = field => slices.reduce((sum, item) => sum + (item[field] ?? 0) * item.quantity, 0) / totalQuantity;
      const remainingQuantity = Math.max(0, order.quantity - totalQuantity);
      if (![totalQuantity, totalNotional, totalFee, totalSpreadCost, totalSlippageCost, remainingQuantity].every(Number.isFinite)
          || totalQuantity > order.quantity + EPSILON || totalNotional <= 0 || totalFee < 0) {
        throw new Error("paper aggregate fill is invalid");
      }
      const aggregate = {
        ...slice,
        idempotencyKey: order.idempotencyKey,
        quantity: totalQuantity,
        filledQuantity: totalQuantity,
        orderQuantity: order.quantity,
        remainingQuantity,
        price: totalNotional / totalQuantity,
        notional: totalNotional,
        fee: totalFee,
        spreadBps: weighted("spreadBps"),
        spreadCost: totalSpreadCost,
        slippageBps: weighted("slippageBps"),
        slippageCost: totalSlippageCost,
        executionSequence: slices[0].executionSequence,
        timestamp,
        executionSlices: slices,
        intentHash
      };
      // Aggregate fill, individual execution slice, fees and portfolio mutation
      // commit atomically. FIFO learning expands the immutable slices by sequence.
      await writer.put("paper-fills", order.idempotencyKey, aggregate);
      if (onFill) await onFill(writer, slice, authorization?.context ?? null, aggregate);
      return aggregate;
    });
  }
}
