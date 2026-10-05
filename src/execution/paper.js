import { randomUUID } from "node:crypto";

export function createPaperExecution() {
  const orders=new Map();
  return {
    submit(order) {
      if (!order?.symbol || !Number.isFinite(order.quantity) || !Number.isFinite(order.price)) throw new Error("invalid paper order");
      const id=randomUUID();
      const fill={id,orderId:id,tier:"paper",symbol:order.symbol,side:order.side,quantity:order.quantity,price:order.price,status:"FILLED",filledAt:Date.now()};
      orders.set(id,fill);
      return Object.freeze({...fill});
    },
    get(id) { return orders.get(id) || null; }
  };
}