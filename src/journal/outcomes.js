import {createHash} from "node:crypto";

const EPSILON = 1e-12;
const DEFAULT_MAX_FILLS = 5000;

function cleanNumber(value) {
  if (!Number.isFinite(value)) throw new Error("paper outcome is not finite");
  const cleaned = Number(value.toFixed(12));
  return Object.is(cleaned, -0) ? 0 : cleaned;
}

function validatedThesisRef(ref, symbol) {
  if (ref === undefined || ref === null) return null;
  if (!ref || typeof ref !== "object"
      || typeof ref.hash !== "string" || !/^[a-f0-9]{64}$/.test(ref.hash)
      || !Number.isSafeInteger(ref.index) || ref.index < 0
      || (ref.timestamp !== null && !Number.isFinite(ref.timestamp))
      || typeof ref.symbol !== "string" || ![symbol, "GENERAL"].includes(ref.symbol)
      || typeof ref.title !== "string" || !ref.title.trim() || ref.title.length > 160) {
    throw new Error("invalid paper fill thesis provenance");
  }
  return {
    hash: ref.hash,
    index: ref.index,
    timestamp: ref.timestamp,
    symbol: ref.symbol,
    title: ref.title
  };
}

function validatedFill(fill) {
  const id = typeof fill?.idempotencyKey === "string" && fill.idempotencyKey
    ? fill.idempotencyKey : fill?.orderId;
  if (!fill || fill.status !== "RECONCILED" || typeof id !== "string" || !id
      || typeof fill.orderId !== "string" || !fill.orderId
      // This report uses the terminal's single USDT ledger. Legacy fills in
      // another quote currency need reviewed reconciliation, not an FX guess.
      || typeof fill.symbol !== "string" || !/^[A-Z0-9]{1,20}USDT$/.test(fill.symbol)
      || !["BUY", "SELL"].includes(fill.side)
      || !Number.isFinite(fill.quantity) || fill.quantity <= 0
      || !Number.isFinite(fill.price) || fill.price <= 0
      || !Number.isFinite(fill.fee) || fill.fee < 0
      || !Number.isFinite(fill.timestamp) || fill.timestamp < 0) {
    throw new Error("invalid paper fill in outcome history");
  }
  const sequenced = fill.executionSequence !== undefined || fill.sequenceVersion !== undefined;
  if (sequenced && (fill.sequenceVersion !== 1 || !Number.isSafeInteger(fill.executionSequence) || fill.executionSequence < 1)) {
    throw new Error("invalid paper fill execution sequence");
  }
  return {
    id,
    ...(sequenced ? {executionSequence: fill.executionSequence} : {}),
    orderId: fill.orderId,
    symbol: fill.symbol,
    side: fill.side,
    quantity: fill.quantity,
    price: fill.price,
    fee: fill.fee,
    timestamp: fill.timestamp,
    thesisRef: validatedThesisRef(fill.thesisRef, fill.symbol)
  };
}

function outcomeId(fields) {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

// Deterministic FIFO accounting over already-reconciled paper fills. Outcomes
// are execution facts from the simulator, not user-authored journal claims and
// not evidence of live or profitable trading.
export function derivePaperOutcomes(fills, {maxFills = DEFAULT_MAX_FILLS} = {}) {
  if (!Array.isArray(fills)) throw new Error("paper fill history must be an array");
  if (!Number.isSafeInteger(maxFills) || maxFills < 1 || maxFills > DEFAULT_MAX_FILLS) {
    throw new Error("invalid outcome history limit");
  }
  if (fills.length > maxFills) throw new Error("paper fill history exceeds the outcome limit");

  const ordered = fills.map(validatedFill).sort((a, b) => a.timestamp - b.timestamp
    || (a.executionSequence ?? Infinity) - (b.executionSequence ?? Infinity) || a.id.localeCompare(b.id));
  const ids = new Set();
  const sequences = new Set();
  const lastSequenceBySymbol = new Map();
  const timestampsBySymbol = new Map();
  for (const item of ordered) {
    if (ids.has(item.id)) throw new Error("duplicate paper fill in outcome history");
    ids.add(item.id);
    // IDs are identity, not an authoritative execution sequence. A timestamp
    // tie within one asset can reverse FIFO direction/thesis attribution.
    const timestamps = timestampsBySymbol.get(item.symbol) || new Map();
    if (timestamps.has(item.timestamp) && (timestamps.get(item.timestamp) === undefined || item.executionSequence === undefined)) {
      throw new Error("ambiguous paper fill chronology");
    }
    if (item.executionSequence !== undefined) {
      if (sequences.has(item.executionSequence) || item.executionSequence <= (lastSequenceBySymbol.get(item.symbol) || 0)) {
        throw new Error("inconsistent paper fill execution sequence");
      }
      sequences.add(item.executionSequence);
      lastSequenceBySymbol.set(item.symbol, item.executionSequence);
    }
    timestamps.set(item.timestamp, item.executionSequence);
    timestampsBySymbol.set(item.symbol, timestamps);
  }

  const lotsBySymbol = new Map();
  const outcomes = [];
  for (const closingFill of ordered) {
    const lots = lotsBySymbol.get(closingFill.symbol) || [];
    const fillSign = closingFill.side === "BUY" ? 1 : -1;
    let remaining = closingFill.quantity * fillSign;
    const closeFeePerUnit = closingFill.fee / closingFill.quantity;

    while (Math.abs(remaining) > EPSILON && lots.length > 0
        && Math.sign(lots[0].remaining) !== Math.sign(remaining)) {
      const openingLot = lots[0];
      const matchedQuantity = Math.min(Math.abs(remaining), Math.abs(openingLot.remaining));
      const direction = openingLot.remaining > 0 ? "LONG" : "SHORT";
      const grossPnl = direction === "LONG"
        ? matchedQuantity * (closingFill.price - openingLot.price)
        : matchedQuantity * (openingLot.price - closingFill.price);
      const fees = matchedQuantity * (openingLot.feePerUnit + closeFeePerUnit);
      const netPnl = cleanNumber(grossPnl - fees);
      const identity = {
        openingOrderId: openingLot.orderId,
        closingOrderId: closingFill.orderId,
        quantity: cleanNumber(matchedQuantity),
        openedAt: openingLot.timestamp,
        closedAt: closingFill.timestamp,
        thesisHash: openingLot.thesisRef?.hash || null
      };
      outcomes.push({
        outcomeId: outcomeId(identity),
        status: "REALIZED",
        source: "paper-fill-fifo-v1",
        symbol: closingFill.symbol,
        direction,
        quantity: identity.quantity,
        openedAt: openingLot.timestamp,
        closedAt: closingFill.timestamp,
        openingOrderId: openingLot.orderId,
        closingOrderId: closingFill.orderId,
        openPrice: openingLot.price,
        closePrice: closingFill.price,
        grossPnl: cleanNumber(grossPnl),
        fees: cleanNumber(fees),
        netPnl,
        result: netPnl > EPSILON ? "WIN" : netPnl < -EPSILON ? "LOSS" : "BREAKEVEN",
        thesisRef: openingLot.thesisRef
      });

      openingLot.remaining = cleanNumber(openingLot.remaining - Math.sign(openingLot.remaining) * matchedQuantity);
      remaining = cleanNumber(remaining - Math.sign(remaining) * matchedQuantity);
      if (Math.abs(openingLot.remaining) <= EPSILON) lots.shift();
    }

    if (Math.abs(remaining) > EPSILON) {
      lots.push({
        orderId: closingFill.orderId,
        remaining,
        price: closingFill.price,
        feePerUnit: closeFeePerUnit,
        timestamp: closingFill.timestamp,
        thesisRef: closingFill.thesisRef
      });
    }
    lotsBySymbol.set(closingFill.symbol, lots);
  }

  const summary = outcomes.reduce((acc, item) => {
    acc.realizedNetPnl = cleanNumber(acc.realizedNetPnl + item.netPnl);
    if (item.result === "WIN") acc.wins++;
    else if (item.result === "LOSS") acc.losses++;
    else acc.breakeven++;
    if (item.thesisRef) acc.linkedOutcomeCount++;
    else acc.unlinkedOutcomeCount++;
    return acc;
  }, {
    outcomeCount: outcomes.length,
    linkedOutcomeCount: 0,
    unlinkedOutcomeCount: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    realizedNetPnl: 0,
    openLotCount: [...lotsBySymbol.values()].reduce((count, lots) => count + lots.length, 0)
  });

  return {version: 1, accounting: "FIFO", currency: "USDT", outcomes, summary};
}

export {DEFAULT_MAX_FILLS};
