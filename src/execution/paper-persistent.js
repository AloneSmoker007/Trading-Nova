import { assertGateArtifact, hashOrderPayload, normalizeSide, normalizeSymbol } from "../risk/gate.js";

export class PersistentPaperEngine {
  constructor(store){if(!store||typeof store.transactIdempotent!=="function")throw new Error("durable store required");this.store=store;}
  async submit(order,{markPrice,gateArtifact,onFill}={}){
    const side = normalizeSide(order?.side);
    if(!order?.idempotencyKey||!order?.symbol||!["BUY","SELL"].includes(side)||!Number.isFinite(order.quantity)||order.quantity<=0)throw new Error("invalid paper order");
    if(!Number.isFinite(markPrice)||markPrice<=0)throw new Error("mark price required");
    const symbol = normalizeSymbol(order.symbol);
    // Idempotency payload = order INTENT (market price is not order intent);
    // reusing a key with different intent is a caller bug and always refused.
    const intentHash = hashOrderPayload({symbol, side, quantity:order.quantity, price:0, reduceOnly:order.reduceOnly===true});
    if(typeof this.store.get==="function"){
      const prior = await this.store.get("paper-fills",order.idempotencyKey);
      if(prior && prior.intentHash!==intentHash) throw new Error("idempotency_key_reuse_with_different_payload");
    }
    // The executed price is part of the gated payload: a verdict computed at one
    // price never authorizes execution at another.
    const gatedOrder = {symbol, side, quantity:order.quantity, price:markPrice, reduceOnly:order.reduceOnly===true};
    return this.store.transactIdempotent("paper:"+order.idempotencyKey,async(tx)=>{
      const writer = tx ?? this.store;
      const prior = typeof writer.get==="function" ? await writer.get("paper-fills",order.idempotencyKey) : null;
      if(prior){
        // Replay of an already-executed order returns the recorded fill;
        // nothing new executes, so no new gate verdict is required.
        if(prior.intentHash!==intentHash) throw new Error("idempotency_key_reuse_with_different_payload");
        return prior;
      }
      // RISK GATE ENFORCEMENT: no execution without a genuine evaluateRiskGate
      // ALLOW artifact bound to exactly this order payload + approved config.
      assertGateArtifact(gateArtifact, gatedOrder);
      const fill={orderId:order.id,side,symbol,quantity:order.quantity,filledQuantity:order.quantity,price:markPrice,fee:0,status:"RECONCILED",timestamp:Date.now(),intentHash};
      // Write through the transaction handle when the store provides one so the
      // fill commits atomically with the idempotency record (all-or-nothing).
      await writer.put("paper-fills",order.idempotencyKey,fill);
      if(onFill) await onFill(writer,fill);
      return fill;
    });
  }
}
