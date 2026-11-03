const SYMBOL_RE = /^[A-Z0-9]{2,24}$/;
const DECIMAL_RE = /^(?:\d+)(?:\.\d+)?$/;
const MAX_SNAPSHOT_LEVELS = 5000;
const MAX_EVENT_LEVELS = 1000;
export const DEPTH_SNAPSHOT_LIMITS = Object.freeze([5, 10, 20, 50, 100, 500, 1000]);

function normalizeSymbol(value) {
  const symbol = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!SYMBOL_RE.test(symbol)) throw new TypeError("invalid depth symbol");
  return symbol;
}

function parseLevelNumber(value, allowZero) {
  if (typeof value === "string" && !DECIMAL_RE.test(value)) throw new TypeError("invalid depth level");
  if (typeof value !== "string" && typeof value !== "number") throw new TypeError("invalid depth level");
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) {
    throw new TypeError("invalid depth level");
  }
  return number;
}

function normalizeRows(rows, {allowZero, maxRows}) {
  if (!Array.isArray(rows) || rows.length > maxRows) throw new TypeError("invalid depth levels");
  const seen = new Set();
  return Object.freeze(rows.map((row) => {
    if (!Array.isArray(row) || row.length !== 2) throw new TypeError("invalid depth level");
    const price = parseLevelNumber(row[0], false);
    const quantity = parseLevelNumber(row[1], allowZero);
    const key = String(price);
    if (seen.has(key)) throw new TypeError("duplicate depth price");
    seen.add(key);
    return Object.freeze([price, quantity]);
  }));
}

function bestPrice(rows, side) {
  if (!rows.length) return null;
  let best = rows[0][0];
  for (let index = 1; index < rows.length; index++) {
    const price = rows[index][0];
    if (side === "bid" ? price > best : price < best) best = price;
  }
  return best;
}

function mapBestPrice(levels, side) {
  let best = null;
  for (const price of levels.keys()) {
    if (best === null || (side === "bid" ? price > best : price < best)) best = price;
  }
  return best;
}

function trimLevels(levels, side, maxLevels) {
  if (levels.size <= maxLevels) return levels;
  const sorted = [...levels.entries()].sort((a, b) => side === "bid" ? b[0] - a[0] : a[0] - b[0]);
  return new Map(sorted.slice(0, maxLevels));
}

export function normalizeDepthSnapshot(raw, {
  symbol,
  receivedAt = Date.now(),
  snapshotLimit = null
} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("invalid depth snapshot");
  if (raw.symbol !== undefined && String(raw.symbol).trim().toUpperCase() !== normalizedSymbol) {
    throw new TypeError("depth snapshot symbol mismatch");
  }
  if (!Number.isSafeInteger(raw.lastUpdateId) || raw.lastUpdateId < 0) {
    throw new TypeError("invalid depth snapshot update id");
  }
  if (snapshotLimit === null || snapshotLimit === undefined) snapshotLimit = raw.snapshotLimit ?? null;
  if (snapshotLimit !== null && (!Number.isInteger(snapshotLimit) || snapshotLimit < 1 || snapshotLimit > MAX_SNAPSHOT_LEVELS)) {
    throw new TypeError("invalid depth snapshot limit");
  }
  if (!Number.isFinite(receivedAt) || receivedAt < 0) throw new TypeError("invalid depth snapshot receipt time");
  const maxRows = snapshotLimit ?? MAX_SNAPSHOT_LEVELS;
  const bids = normalizeRows(raw.bids, {allowZero: false, maxRows});
  const asks = normalizeRows(raw.asks, {allowZero: false, maxRows});
  for (let index = 1; index < bids.length; index++) {
    if (bids[index - 1][0] <= bids[index][0]) throw new TypeError("unsorted depth bids");
  }
  for (let index = 1; index < asks.length; index++) {
    if (asks[index - 1][0] >= asks[index][0]) throw new TypeError("unsorted depth asks");
  }
  const bestBid = bestPrice(bids, "bid");
  const bestAsk = bestPrice(asks, "ask");
  if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) {
    throw new TypeError("crossed depth snapshot");
  }
  return Object.freeze({
    source: "binance-spot",
    symbol: normalizedSymbol,
    lastUpdateId: raw.lastUpdateId,
    bids,
    asks,
    snapshotLimit,
    receivedAt,
    timestamp: null,
    timestampStatus: "not-provided"
  });
}

export function normalizeDepthEvent(raw, {symbol, receivedAt = Date.now()} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || raw.e !== "depthUpdate"
      || typeof raw.s !== "string"
      || raw.s.trim().toUpperCase() !== normalizedSymbol
      || !Number.isSafeInteger(raw.E) || raw.E < 0
      || !Number.isSafeInteger(raw.U) || raw.U < 0
      || !Number.isSafeInteger(raw.u) || raw.u < raw.U
      || !Number.isFinite(receivedAt) || receivedAt < 0) {
    throw new TypeError("invalid depth event");
  }
  return Object.freeze({
    source: "binance-spot",
    symbol: normalizedSymbol,
    eventTime: raw.E,
    firstUpdateId: raw.U,
    finalUpdateId: raw.u,
    bids: normalizeRows(raw.b, {allowZero: true, maxRows: MAX_EVENT_LEVELS}),
    asks: normalizeRows(raw.a, {allowZero: true, maxRows: MAX_EVENT_LEVELS}),
    receivedAt
  });
}

// Sequence-aware local book for Binance Spot diff-depth events. The caller must
// open/buffer the WebSocket stream before fetching the REST snapshot, then call
// setSnapshot(). Any sequence gap or malformed/crossed state invalidates the
// whole book; reset and take a new snapshot before using it again.
// Sequence rules follow Binance's official Spot stream contract:
// https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md
export class BinanceSpotDepthBook {
  constructor({symbol, now = () => Date.now(), maxBufferedEvents = 1000, maxLevels = MAX_SNAPSHOT_LEVELS} = {}) {
    this.symbol = normalizeSymbol(symbol);
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (!Number.isInteger(maxBufferedEvents) || maxBufferedEvents < 1 || maxBufferedEvents > 10000) {
      throw new TypeError("invalid depth event buffer limit");
    }
    if (!Number.isInteger(maxLevels) || maxLevels < 1 || maxLevels > MAX_SNAPSHOT_LEVELS) {
      throw new TypeError("invalid depth level limit");
    }
    this.now = now;
    this.maxBufferedEvents = maxBufferedEvents;
    this.maxLevels = maxLevels;
    this.reset();
  }

  reset() {
    this.state = "syncing";
    this.reason = null;
    this.snapshotLoaded = false;
    this.updateId = null;
    this.snapshotLimit = null;
    this.snapshotReceivedAt = null;
    this.lastEventTime = null;
    this.lastEventReceivedAt = null;
    this.bids = new Map();
    this.asks = new Map();
    this.buffer = [];
    return this.getView();
  }

  _invalidate(reason) {
    this.state = "invalid";
    this.reason = reason;
    this.snapshotLoaded = false;
    this.updateId = null;
    this.snapshotLimit = null;
    this.snapshotReceivedAt = null;
    this.lastEventTime = null;
    this.lastEventReceivedAt = null;
    this.bids.clear();
    this.asks.clear();
    this.buffer = [];
  }

  _applyRows(target, rows) {
    for (const [price, quantity] of rows) {
      if (quantity === 0) target.delete(price);
      else target.set(price, quantity);
    }
  }

  _applyEvent(event) {
    if (!this.snapshotLoaded || this.updateId === null) return;
    if (event.finalUpdateId <= this.updateId) return;
    // Binance requires the snapshot update ID itself to fall inside the first event [U, u].
    // If the first stream event starts after the snapshot, the snapshot must be fetched again.
    if (this.state === "syncing" && event.firstUpdateId > this.updateId) {
      this._invalidate("snapshot-behind-stream");
      return;
    }
    const nextUpdateId = this.updateId + 1;
    if (!Number.isSafeInteger(nextUpdateId)) {
      this._invalidate("sequence-exhausted");
      return;
    }
    if (event.firstUpdateId > nextUpdateId) {
      this._invalidate("sequence-gap");
      return;
    }
    if (event.finalUpdateId < nextUpdateId) return;

    const bids = new Map(this.bids);
    const asks = new Map(this.asks);
    this._applyRows(bids, event.bids);
    this._applyRows(asks, event.asks);
    const bestBid = mapBestPrice(bids, "bid");
    const bestAsk = mapBestPrice(asks, "ask");
    if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) {
      this._invalidate("crossed-book");
      return;
    }

    this.bids = trimLevels(bids, "bid", this.maxLevels);
    this.asks = trimLevels(asks, "ask", this.maxLevels);
    this.updateId = event.finalUpdateId;
    this.lastEventTime = event.eventTime;
    this.lastEventReceivedAt = event.receivedAt;
    this.state = "ready";
    this.reason = null;
  }

  ingest(raw) {
    if (this.state === "invalid") return this.getView();
    let event;
    try {
      event = normalizeDepthEvent(raw, {symbol: this.symbol, receivedAt: this.now()});
    } catch {
      this._invalidate("invalid-event");
      return this.getView();
    }
    if (!this.snapshotLoaded) {
      if (this.buffer.length >= this.maxBufferedEvents) this._invalidate("buffer-overflow");
      else this.buffer.push(event);
      return this.getView();
    }
    this._applyEvent(event);
    return this.getView();
  }

  setSnapshot(raw) {
    if (this.state === "invalid") return this.getView();
    if (this.snapshotLoaded) {
      this._invalidate("snapshot-requires-reset");
      return this.getView();
    }
    let snapshot;
    try {
      snapshot = normalizeDepthSnapshot(raw, {
        symbol: this.symbol,
        receivedAt: this.now(),
        snapshotLimit: raw?.snapshotLimit ?? null
      });
    } catch {
      this._invalidate("invalid-snapshot");
      return this.getView();
    }
    this.snapshotLoaded = true;
    this.state = "syncing";
    this.reason = null;
    this.updateId = snapshot.lastUpdateId;
    this.snapshotLimit = snapshot.snapshotLimit;
    this.snapshotReceivedAt = snapshot.receivedAt;
    this.bids = new Map(snapshot.bids);
    this.asks = new Map(snapshot.asks);
    const buffered = this.buffer;
    this.buffer = [];
    for (const event of buffered) {
      if (this.state === "invalid") break;
      this._applyEvent(event);
    }
    return this.getView();
  }

  getView({limit = 20, maxAgeMs = 1000} = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SNAPSHOT_LEVELS
        || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new TypeError("invalid depth view options");
    }
    let now;
    try { now = this.now(); } catch { now = NaN; }
    if (this.state !== "ready") {
      return Object.freeze({
        source: "binance-spot",
        symbol: this.symbol,
        status: this.state,
        reason: this.reason || "awaiting-sequence-bridge",
        updateId: this.updateId,
        snapshotLimit: this.snapshotLimit,
        coverage: this.snapshotLimit === null ? "snapshot-limit-unknown" : "snapshot-limited",
        snapshotReceivedAt: this.snapshotReceivedAt,
        sourceEventTime: null,
        eventReceivedAt: null,
        ageMs: null,
        freshness: "unknown",
        isUsable: false,
        executionEligible: false,
        bestBid: null,
        bestAsk: null,
        spread: null,
        bids: Object.freeze([]),
        asks: Object.freeze([])
      });
    }
    const rawAgeMs = Number.isFinite(now) ? now - this.lastEventTime : NaN;
    const freshness = !Number.isFinite(rawAgeMs) ? "unknown"
      : rawAgeMs < 0 ? "future"
        : rawAgeMs <= maxAgeMs ? "fresh" : "stale";
    const ageMs = Number.isFinite(rawAgeMs) && rawAgeMs >= 0 ? rawAgeMs : null;
    const bestBid = mapBestPrice(this.bids, "bid");
    const bestAsk = mapBestPrice(this.asks, "ask");
    const twoSided = bestBid !== null && bestAsk !== null;
    const reason = !twoSided ? "one-sided-book" : freshness !== "fresh" ? "depth-" + freshness : null;
    const bidRows = [...this.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, limit)
      .map(([price, quantity]) => Object.freeze({price, quantity}));
    const askRows = [...this.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, limit)
      .map(([price, quantity]) => Object.freeze({price, quantity}));
    return Object.freeze({
      source: "binance-spot",
      symbol: this.symbol,
      status: this.state,
      reason,
      updateId: this.updateId,
      snapshotLimit: this.snapshotLimit,
      coverage: this.snapshotLimit === null ? "snapshot-limit-unknown" : "snapshot-limited",
      snapshotReceivedAt: this.snapshotReceivedAt,
      sourceEventTime: this.lastEventTime,
      eventReceivedAt: this.lastEventReceivedAt,
      ageMs,
      freshness,
      isUsable: reason === null,
      executionEligible: false,
      bestBid,
      bestAsk,
      spread: twoSided ? bestAsk - bestBid : null,
      bids: Object.freeze(bidRows),
      asks: Object.freeze(askRows)
    });
  }
}
