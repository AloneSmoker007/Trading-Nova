import { randomUUID } from "node:crypto";
import { assertGateArtifact, hashOrderPayload, normalizeSide, normalizeSymbol } from "../risk/gate.js";

const IDEMPOTENCY_CACHE_LIMIT = 10000;

export function createPaperExecution() {
  const orders=new Map(), idempotency=new Map();
  return {
    submit(order, context = {}) {
      const side = normalizeSide(order?.side);
      if (!order?.symbol || !["BUY","SELL"].includes(side) || !Number.isFinite(order.quantity) || order.quantity <= 0 || !Number.isFinite(order.price) || order.price <= 0) throw new Error("invalid paper order");
      const normalized = {symbol:normalizeSymbol(order.symbol), side, quantity:order.quantity, price:order.price, reduceOnly:order.reduceOnly === true};
      // Idempotent replay of an ALREADY EXECUTED order returns the recorded
      // fill; a reuse of the key with a different payload is a caller bug.
      const payloadHash = hashOrderPayload(normalized);
      if (order.idempotencyKey && idempotency.has(order.idempotencyKey)) {
        const record = idempotency.get(order.idempotencyKey);
        if (record.payloadHash !== payloadHash) throw new Error("idempotency_key_reuse_with_different_payload");
        return Object.freeze({...record.fill});
      }
      // RISK GATE ENFORCEMENT: no execution without a genuine evaluateRiskGate
      // ALLOW artifact bound to exactly this order payload + approved config.
      assertGateArtifact(context.gateArtifact, normalized);
      const id=randomUUID();
      const fill={id,orderId:id,tier:"paper",symbol:normalized.symbol,side:normalized.side,quantity:order.quantity,price:order.price,status:"FILLED",filledAt:Date.now()};
      orders.set(id,fill);
      if (order.idempotencyKey) {
        if (idempotency.size >= IDEMPOTENCY_CACHE_LIMIT) idempotency.delete(idempotency.keys().next().value);
        idempotency.set(order.idempotencyKey,{fill,payloadHash});
      }
      return Object.freeze({...fill});
    },
    get(id) { const fill=orders.get(id); return fill ? Object.freeze({...fill}) : null; }
  };
}
