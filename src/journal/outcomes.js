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
  const campaigns = new Map();
  const activeCampaignBySymbol = new Map();
  const addUnique = (values, value) => {
    if (!values.includes(value)) values.push(value);
  };
  const openCampaign = (fill, signedQuantity) => {
    const direction = signedQuantity > 0 ? "LONG" : "SHORT";
    const identity = {
      symbol: fill.symbol,
      direction,
      openingFillId: fill.id,
      openedAt: fill.timestamp,
      executionSequence: fill.executionSequence ?? null
    };
    const tradeId = createHash("sha256")
      .update("paper-position-cycle-v1:" + JSON.stringify(identity)).digest("hex");
    const campaign = {
      tradeId,
      symbol: fill.symbol,
      direction,
      openedAt: fill.timestamp,
      closedAt: null,
      status: "OPEN",
      openingOrderIds: [],
      closingOrderIds: [],
      openedQuantity: 0,
      closedQuantity: 0,
      matchedFragments: 0,
      grossPnl: 0,
      fees: 0,
      netPnl: 0
    };
    campaigns.set(tradeId, campaign);
    activeCampaignBySymbol.set(fill.symbol, campaign);
    return campaign;
  };
  for (const closingFill of ordered) {
    const lots = lotsBySymbol.get(closingFill.symbol) || [];
    let activeCampaign = activeCampaignBySymbol.get(closingFill.symbol) || null;
    if (lots.length > 0) {
      const lotCampaign = campaigns.get(lots[0].tradeId);
      if (!lotCampaign || lotCampaign.status !== "OPEN"
          || (activeCampaign && activeCampaign.tradeId !== lotCampaign.tradeId)) {
        throw new Error("invalid paper trade-cycle state");
      }
      activeCampaign = lotCampaign;
      activeCampaignBySymbol.set(closingFill.symbol, lotCampaign);
    }
    const fillSign = closingFill.side === "BUY" ? 1 : -1;
    let remaining = closingFill.quantity * fillSign;
    const closeFeePerUnit = closingFill.fee / closingFill.quantity;

    while (Math.abs(remaining) > EPSILON && lots.length > 0
        && Math.sign(lots[0].remaining) !== Math.sign(remaining)) {
      const openingLot = lots[0];
      const campaign = campaigns.get(openingLot.tradeId);
      if (!campaign || campaign.status !== "OPEN"
          || (activeCampaign && activeCampaign.tradeId !== campaign.tradeId)) {
        throw new Error("invalid paper trade-cycle attribution");
      }
      activeCampaign = campaign;
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
      campaign.closedQuantity = cleanNumber(campaign.closedQuantity + matchedQuantity);
      campaign.matchedFragments++;
      campaign.grossPnl = cleanNumber(campaign.grossPnl + grossPnl);
      campaign.fees = cleanNumber(campaign.fees + fees);
      campaign.netPnl = cleanNumber(campaign.netPnl + netPnl);
      addUnique(campaign.closingOrderIds, closingFill.orderId);

      openingLot.remaining = cleanNumber(openingLot.remaining - Math.sign(openingLot.remaining) * matchedQuantity);
      remaining = cleanNumber(remaining - Math.sign(remaining) * matchedQuantity);
      if (Math.abs(openingLot.remaining) <= EPSILON) lots.shift();
    }

    if (lots.length === 0 && activeCampaign) {
      activeCampaign.status = "CLOSED";
      activeCampaign.closedAt = closingFill.timestamp;
      activeCampaignBySymbol.delete(closingFill.symbol);
      activeCampaign = null;
    }

    if (Math.abs(remaining) > EPSILON) {
      if (lots.length > 0) {
        const lotCampaign = campaigns.get(lots[0].tradeId);
        if (!lotCampaign || lotCampaign.status !== "OPEN"
            || (activeCampaign && activeCampaign.tradeId !== lotCampaign.tradeId)
            || Math.sign(lots[0].remaining) !== Math.sign(remaining)) {
          throw new Error("inconsistent paper trade-cycle direction");
        }
        activeCampaign = lotCampaign;
      } else {
        activeCampaign = openCampaign(closingFill, remaining);
      }
      addUnique(activeCampaign.openingOrderIds, closingFill.orderId);
      activeCampaign.openedQuantity = cleanNumber(activeCampaign.openedQuantity + Math.abs(remaining));
      lots.push({
        tradeId: activeCampaign.tradeId,
        orderId: closingFill.orderId,
        remaining,
        price: closingFill.price,
        feePerUnit: closeFeePerUnit,
        timestamp: closingFill.timestamp,
        thesisRef: closingFill.thesisRef
      });
      activeCampaignBySymbol.set(closingFill.symbol, activeCampaign);
    } else if (lots.length > 0) {
      activeCampaign = campaigns.get(lots[0].tradeId);
      if (!activeCampaign || activeCampaign.status !== "OPEN") {
        throw new Error("invalid open paper trade cycle");
      }
      activeCampaignBySymbol.set(closingFill.symbol, activeCampaign);
    } else {
      activeCampaignBySymbol.delete(closingFill.symbol);
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

  const groups = new Map();
  const groupFor = ref => {
    const hash = ref?.hash || null;
    if (!groups.has(hash)) groups.set(hash, {thesisHash: hash, title: ref?.title || "Unlinked fills",
      symbols: new Set(), matchedFragments: 0, wins: 0, losses: 0, breakeven: 0,
      grossPnl: 0, fees: 0, netPnl: 0, openLotCount: 0, lastClosedAt: null});
    return groups.get(hash);
  };
  for (const item of outcomes) {
    const group = groupFor(item.thesisRef);
    group.symbols.add(item.symbol);
    group.matchedFragments++;
    if (item.result === "WIN") group.wins++;
    else if (item.result === "LOSS") group.losses++;
    else group.breakeven++;
    group.grossPnl = cleanNumber(group.grossPnl + item.grossPnl);
    group.fees = cleanNumber(group.fees + item.fees);
    group.netPnl = cleanNumber(group.netPnl + item.netPnl);
    group.lastClosedAt = Math.max(group.lastClosedAt ?? 0, item.closedAt);
  }
  for (const [symbol, lots] of lotsBySymbol) for (const lot of lots) {
    const group = groupFor(lot.thesisRef);
    group.symbols.add(symbol);
    group.openLotCount++;
  }
  const thesisSummaries = [...groups.values()].map(group => ({...group, symbols: [...group.symbols].sort(),
    meanNetPnlPerFragment: group.matchedFragments ? cleanNumber(group.netPnl / group.matchedFragments) : null,
    source: "paper-fifo-thesis-summary-v1", unit: "matched-fifo-fragments-not-whole-trades"}))
    .sort((a, b) => (b.lastClosedAt ?? -1) - (a.lastClosedAt ?? -1) || (a.thesisHash || "").localeCompare(b.thesisHash || ""));
  const tradeSummaries = [...campaigns.values()].map(campaign => {
    const openLots = (lotsBySymbol.get(campaign.symbol) || [])
      .filter(lot => lot.tradeId === campaign.tradeId);
    const openQuantity = cleanNumber(openLots.reduce((total, lot) => total + Math.abs(lot.remaining), 0));
    const status = openLots.length ? "OPEN" : "CLOSED";
    if ((campaign.status === "OPEN") !== (status === "OPEN")
        || (status === "CLOSED" && !Number.isFinite(campaign.closedAt))) {
      throw new Error("paper trade-cycle lifecycle does not reconcile");
    }
    const openedQuantity = cleanNumber(campaign.openedQuantity);
    const closedQuantity = cleanNumber(campaign.closedQuantity);
    if (Math.abs(openedQuantity - closedQuantity - openQuantity) > 1e-8) {
      throw new Error("paper trade-cycle quantities do not reconcile");
    }
    const realizedNetPnl = cleanNumber(campaign.netPnl);
    let result = null;
    if (status === "CLOSED") {
      if (realizedNetPnl > EPSILON) result = "WIN";
      else if (realizedNetPnl < -EPSILON) result = "LOSS";
      else result = "BREAKEVEN";
    }
    return {
      tradeId: campaign.tradeId,
      source: "paper-position-cycle-v1",
      unit: "flat-to-flat-symbol-position-cycle",
      symbol: campaign.symbol,
      direction: campaign.direction,
      status,
      result,
      openedAt: campaign.openedAt,
      closedAt: status === "CLOSED" ? campaign.closedAt : null,
      openingOrderIds: [...campaign.openingOrderIds],
      closingOrderIds: [...campaign.closingOrderIds],
      openedQuantity,
      closedQuantity,
      openQuantity,
      openLotCount: openLots.length,
      matchedFragments: campaign.matchedFragments,
      realizedGrossPnl: cleanNumber(campaign.grossPnl),
      realizedFees: cleanNumber(campaign.fees),
      realizedNetPnl
    };
  }).sort((a, b) => b.openedAt - a.openedAt || a.tradeId.localeCompare(b.tradeId));
  const closedTrades = tradeSummaries.filter(trade => trade.status === "CLOSED");
  const openTrades = tradeSummaries.filter(trade => trade.status === "OPEN");
  const closedTradeWins = closedTrades.filter(trade => trade.result === "WIN").length;
  const closedTradeLosses = closedTrades.filter(trade => trade.result === "LOSS").length;
  const closedTradeBreakeven = closedTrades.filter(trade => trade.result === "BREAKEVEN").length;
  const sumTradePnl = trades => cleanNumber(trades.reduce((total, trade) => total + trade.realizedNetPnl, 0));
  const tradeSummary = {
    tradeCount: tradeSummaries.length,
    closedTradeCount: closedTrades.length,
    openTradeCount: openTrades.length,
    closedTradeWins,
    closedTradeLosses,
    closedTradeBreakeven,
    closedTradeWinRate: closedTrades.length ? cleanNumber(closedTradeWins / closedTrades.length) : null,
    closedTradeNetPnl: sumTradePnl(closedTrades),
    openTradeRealizedNetPnl: sumTradePnl(openTrades),
    realizedNetPnl: sumTradePnl(tradeSummaries),
    source: "paper-position-cycle-v1",
    note: "Only flat-to-flat closed position cycles receive a whole-trade result. Open cycles show realized partials separately; open exposure and unrealized P&L are excluded."
  };
  if (Math.abs(tradeSummary.realizedNetPnl - summary.realizedNetPnl) > 1e-8) {
    throw new Error("whole-trade and FIFO fragment P&L do not reconcile");
  }

  return {version: 1, accounting: "FIFO", currency: "USDT", outcomes, summary, thesisSummaries,
    tradeSummaries, tradeSummary};
}

export {DEFAULT_MAX_FILLS};
