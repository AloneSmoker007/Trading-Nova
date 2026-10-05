export class PersistentPaperEngine {
  constructor(store){if(!store||typeof store.transactIdempotent!=="function")throw new Error("durable store required");this.store=store;}
  async submit(order,{markPrice}={}){
    if(!order?.idempotencyKey||!["BUY","SELL"].includes(order.side)||!Number.isFinite(order.quantity)||order.quantity<=0)throw new Error("invalid paper order");
    if(!Number.isFinite(markPrice)||markPrice<=0)throw new Error("mark price required");
    return this.store.transactIdempotent("paper:"+order.idempotencyKey,async()=>{
      const fill={orderId:order.id,side:order.side,symbol:String(order.symbol).toUpperCase(),quantity:order.quantity,filledQuantity:order.quantity,price:markPrice,fee:0,status:"RECONCILED",timestamp:Date.now()};
      await this.store.put("paper-fills",order.idempotencyKey,fill);return fill;
    });
  }
}
