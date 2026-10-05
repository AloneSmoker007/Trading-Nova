// Proposed: real WebSocket market-data feed supervisor (public feed, read-only).
// Evidence source: Binance public spot streams provide exchange event time `E`
// and depth update IDs `U`/`u` for latency + sequence-continuity checks.
// Fail-closed contract: canTrade() is false unless the feed is CONNECTED,
// fresh, sequence-continuous and free of invalid data.

const DEFAULT_BACKOFF_BASE_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 30000;
const RESYNC_EVENTS_REQUIRED = 3;

/**
 * Parse one Binance `<symbol>@depth` frame into a normalized event.
 * Throws on malformed/invalid content; the caller must catch and count.
 */
export function parseBinanceDepthFrame(raw, { receivedAt = Date.now() } = {}) {
  const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!msg || typeof msg !== "object") throw new TypeError("frame is not an object");
  const { E, U, u, s } = msg;
  if (!Number.isFinite(E) || E <= 0) throw new TypeError("missing exchange event time E");
  if (!Number.isFinite(U) || !Number.isFinite(u) || u < U) throw new TypeError("invalid depth update ids");
  if (typeof s !== "string" || !s.trim()) throw new TypeError("missing symbol");
  if (!Array.isArray(msg.b) || !Array.isArray(msg.a)) throw new TypeError("missing depth levels");
  for (const level of [...msg.b, ...msg.a]) {
    if (!Array.isArray(level) || level.length < 2) throw new TypeError("invalid depth level");
    const [price, qty] = [Number(level[0]), Number(level[1])];
    if (!(price > 0) || !(qty >= 0)) throw new TypeError("invalid depth level values");
  }
  return Object.freeze({
    type: "depth",
    symbol: s.toUpperCase(),
    sequenceStart: U,
    sequenceEnd: u,
    exchangeTime: E,
    receivedAt,
    exchangeLatencyMs: Math.max(0, receivedAt - E)
  });
}

export class WsFeed {
  constructor({
    url,
    parse = parseBinanceDepthFrame,
    WebSocketImpl = globalThis.WebSocket,
    now = () => Date.now(),
    maxAgeMs = 10000,
    maxLatencyMs = 2000,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
    resyncEventsRequired = RESYNC_EVENTS_REQUIRED
  } = {}) {
    if (typeof url !== "string" || !url.trim()) throw new Error("feed url required");
    if (typeof WebSocketImpl !== "function") throw new Error("WebSocket implementation required");
    this.url = url;
    this.parse = parse;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.maxLatencyMs = maxLatencyMs;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.resyncEventsRequired = resyncEventsRequired;
    this.state = "DISCONNECTED";
    this.socket = null;
    this.reconnectTimer = null;
    this.retries = 0;
    this.closedByUser = false;
    // quality state (fail-closed: everything starts unhealthy)
    this.lastValidAt = null;
    this.lastExchangeTime = null;
    this.lastSequenceEnd = null;
    this.gapOpen = true; // no sequence observed yet => continuity unproven
    this.invalidData = false;
    this.malformedCount = 0;
    this.invalidCount = 0;
    this.gapCount = 0;
    this.reconnectCount = 0;
    this.validCount = 0;
    this.resyncStreak = 0;
    this.latenciesMs = [];
    this.onEvent = null; // optional observer for soak/metrics
  }

  connect() {
    this.closedByUser = false;
    this._open();
    return this;
  }

  _open() {
    this.state = "CONNECTING";
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    socket.onopen = () => { this.state = "CONNECTED"; };
    socket.onmessage = (frame) => this._onMessage(frame?.data ?? frame);
    socket.onerror = () => { this.state = "DEGRADED"; };
    socket.onclose = () => {
      this.socket = null;
      this.state = "DISCONNECTED";
      this.lastSequenceEnd = null;
      this.gapOpen = true; // continuity must be re-proven after reconnect
      if (!this.closedByUser) this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const n = Math.min(this.retries++, 10);
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** n);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectCount += 1;
      this._open();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  _onMessage(raw) {
    let event;
    try {
      event = this.parse(raw, { receivedAt: this.now() });
    } catch {
      // A malformed frame may hide a real event: continuity is unproven now.
      this.malformedCount += 1;
      this.invalidData = true;
      this.gapOpen = true;
      this.resyncStreak = 0;
      return;
    }
    // sequence continuity (Binance spot rule: U <= lastId+1 && u >= lastId+1)
    if (this.lastSequenceEnd !== null) {
      if (event.sequenceStart > this.lastSequenceEnd + 1) {
        const afterSequence = this.lastSequenceEnd;
        this.gapCount += 1;
        this.gapOpen = true;
        this.resyncStreak = 0;
        this.state = "GAP";
        // Re-baseline on the new sequence window; NO-TRADE stays on until
        // resyncEventsRequired consecutive continuous frames re-prove order.
        this.lastSequenceEnd = null;
        this.onEvent?.({ type: "gap", afterSequence, event });
        return;
      }
      if (event.sequenceEnd < this.lastSequenceEnd) {
        // out-of-order/duplicate frame: invalid, continuity unproven
        this.invalidCount += 1;
        this.invalidData = true;
        this.gapOpen = true;
        this.resyncStreak = 0;
        return;
      }
    }
    this.lastSequenceEnd = event.sequenceEnd;
    this.lastExchangeTime = event.exchangeTime;
    this.lastValidAt = this.now();
    this.validCount += 1;
    this.latenciesMs.push(event.exchangeLatencyMs);
    if (event.exchangeLatencyMs > this.maxLatencyMs) this.invalidData = true;
    if (this.gapOpen) {
      this.resyncStreak += 1;
      if (this.resyncStreak >= this.resyncEventsRequired) {
        this.gapOpen = false;
        this.invalidData = false;
        this.state = "CONNECTED";
        this.onEvent?.({ type: "gap-recovered", afterEvents: this.resyncStreak });
      }
    } else {
      this.invalidData = false;
      this.state = "CONNECTED";
    }
    this.onEvent?.({ type: "event", event });
  }

  freshness() {
    return this.lastValidAt !== null && this.now() - this.lastValidAt <= this.maxAgeMs;
  }

  canTrade() {
    return this.state === "CONNECTED" && this.freshness() && !this.gapOpen && !this.invalidData;
  }

  qualityState() {
    return Object.freeze({
      state: this.state,
      connected: this.socket !== null && (this.state === "CONNECTED" || this.state === "GAP"),
      fresh: this.freshness(),
      gapOpen: this.gapOpen,
      invalidData: this.invalidData,
      lastValidAt: this.lastValidAt,
      lastExchangeTime: this.lastExchangeTime,
      malformedCount: this.malformedCount,
      invalidCount: this.invalidCount,
      gapCount: this.gapCount,
      validCount: this.validCount,
      reconnectCount: this.reconnectCount,
      maxAgeMs: this.maxAgeMs
    });
  }

  latencySummary() {
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)))] : null);
    return Object.freeze({ samples: sorted.length, p50Ms: pct(50), p95Ms: pct(95), p99Ms: pct(99), maxMs: sorted.at(-1) ?? null });
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
    this.state = "DISCONNECTED";
    this.gapOpen = true;
  }
}
