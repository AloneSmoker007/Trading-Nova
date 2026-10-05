import { randomUUID } from "node:crypto";

// In-memory paper engine with BOUNDED retention (audit LOAD F-02: ~635 B were
// retained per fill forever -> OOM under sustained load). Durable history
// belongs to PersistentPaperEngine; this engine is a bounded cache.
//
// IMPORTANT (safety semantics): retention window is maxRetainedFills fills.
// When a fill is evicted, its idempotencyKey is dropped with it — re-submitting
// an evicted key therefore produces a NEW fill. Callers needing durable
// idempotency must use the persistent engine (see audit DB-02 race finding).
export function createPaperExecution({ maxRetainedFills = 50000 } = {}) {
  if (!Number.isInteger(maxRetainedFills) || maxRetainedFills <= 0) throw new Error("invalid maxRetainedFills");
  const orders = new Map(), idempotency = new Map(), fillKeys = new Map();
  const evict = () => {
    while (orders.size > maxRetainedFills) {
      const oldestId = orders.keys().next().value;
      orders.delete(oldestId);
      const key = fillKeys.get(oldestId);
      if (key !== undefined) {
        fillKeys.delete(oldestId);
        if (idempotency.get(key)?.id === oldestId) idempotency.delete(key);
      }
    }
  };
  return {
    submit(order) {
      if (!order?.symbol || !["BUY","SELL"].includes(order.side) || !Number.isFinite(order.quantity) || order.quantity <= 0 || !Number.isFinite(order.price) || order.price <= 0) throw new Error("invalid paper order");
      if (order.idempotencyKey && idempotency.has(order.idempotencyKey)) return Object.freeze({...idempotency.get(order.idempotencyKey)});
      const id = randomUUID();
      const fill = {id,orderId:id,tier:"paper",symbol:order.symbol.toUpperCase(),side:order.side,quantity:order.quantity,price:order.price,status:"FILLED",filledAt:Date.now()};
      orders.set(id, fill);
      if (order.idempotencyKey) { idempotency.set(order.idempotencyKey, fill); fillKeys.set(id, order.idempotencyKey); }
      evict();
      return Object.freeze({...fill});
    },
    get(id) { const fill = orders.get(id); return fill ? Object.freeze({...fill}) : null; }
  };
}
