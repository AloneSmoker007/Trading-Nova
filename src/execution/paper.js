import { randomUUID } from "node:crypto";
export function createPaperExecution() {
  const orders=new Map(), idempotency=new Map();
  return {
    submit(order) {
      if (!order?.symbol || !["BUY","SELL"].includes(order.side) || !Number.isFinite(order.quantity) || order.quantity <= 0 || !Number.isFinite(order.price) || order.price <= 0) throw new Error("invalid paper order");
      if (order.idempotencyKey && idempotency.has(order.idempotencyKey)) return Object.freeze({...idempotency.get(order.idempotencyKey)});
      const id=randomUUID();
      const fill={id,orderId:id,tier:"paper",symbol:order.symbol.toUpperCase(),side:order.side,quantity:order.quantity,price:order.price,status:"FILLED",filledAt:Date.now()};
      orders.set(id,fill);
      if (order.idempotencyKey) idempotency.set(order.idempotencyKey,fill);
      return Object.freeze({...fill});
    },
    get(id) { const fill=orders.get(id); return fill ? Object.freeze({...fill}) : null; }
  };
}