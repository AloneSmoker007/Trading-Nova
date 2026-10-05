export function reconcileOrder({order, fill}) {
  if (!order || !fill) return {status:"UNRESOLVED", reasons:["MISSING_STATE"]};
  const same=order.symbol===fill.symbol && order.side===fill.side && order.quantity===fill.quantity;
  return same && fill.status==="FILLED" ? {status:"RECONCILED",reasons:[]} : {status:"UNRESOLVED",reasons:["ORDER_FILL_MISMATCH"]};
}

export function requireReconciled(result) {
  if (result?.status !== "RECONCILED") throw new Error("execution is not reconciled");
  return true;
}