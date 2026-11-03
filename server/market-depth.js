// server/market-depth.js — bounded shared owner for read-only public depth streams.

const SYMBOL_RE = /^[A-Z0-9]{2,24}$/;
const DEFAULT_IDLE_MS = 15000;
const DEFAULT_MAX_SESSIONS = 4;

export function createMarketDepthService({
  createStream,
  now = () => Date.now(),
  idleMs = DEFAULT_IDLE_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout
} = {}) {
  if (typeof createStream !== "function" || typeof now !== "function"
      || typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
    throw new TypeError("invalid market depth service dependencies");
  }
  if (!Number.isInteger(idleMs) || idleMs < 1000 || idleMs > 120000
      || !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 16) {
    throw new TypeError("invalid market depth service bounds");
  }

  const sessions = new Map();
  let closed = false;

  function dispose(symbol, record) {
    if (sessions.get(symbol) !== record) return;
    sessions.delete(symbol);
    if (record.timer !== null) {
      clearTimeoutImpl(record.timer);
      record.timer = null;
    }
    try { record.stream.stop(); } catch {}
  }

  function scheduleExpiry(symbol, record) {
    if (record.timer !== null) clearTimeoutImpl(record.timer);
    record.timer = setTimeoutImpl(() => {
      record.timer = null;
      if (sessions.get(symbol) !== record) return;
      let elapsed;
      try { elapsed = now() - record.lastAccessAt; } catch { elapsed = NaN; }
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= idleMs) {
        dispose(symbol, record);
        return;
      }
      scheduleExpiry(symbol, record);
    }, idleMs);
    record.timer?.unref?.();
  }

  function read(symbol) {
    if (closed) return {ok: false, reason: "service-closed"};
    if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) {
      return {ok: false, reason: "invalid-symbol"};
    }
    let accessedAt;
    try { accessedAt = now(); } catch { accessedAt = NaN; }
    if (!Number.isFinite(accessedAt)) return {ok: false, reason: "clock-unavailable"};

    let record = sessions.get(symbol);
    if (!record) {
      if (sessions.size >= maxSessions) return {ok: false, reason: "capacity"};
      let stream;
      try { stream = createStream(symbol); } catch { return {ok: false, reason: "transport-unavailable"}; }
      if (!stream || typeof stream.start !== "function" || typeof stream.stop !== "function"
          || typeof stream.getView !== "function") {
        try { stream?.stop?.(); } catch {}
        return {ok: false, reason: "transport-unavailable"};
      }
      record = {stream, lastAccessAt: accessedAt, timer: null};
      sessions.set(symbol, record);
      try { stream.start(); } catch {
        dispose(symbol, record);
        return {ok: false, reason: "transport-unavailable"};
      }
    }

    record.lastAccessAt = accessedAt;
    scheduleExpiry(symbol, record);
    let view;
    try { view = record.stream.getView(); } catch {
      dispose(symbol, record);
      return {ok: false, reason: "stream-unavailable"};
    }
    if (!view || typeof view !== "object" || view.symbol !== symbol || view.executionEligible !== false) {
      dispose(symbol, record);
      return {ok: false, reason: "invalid-view"};
    }
    return {ok: true, data: view};
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const [symbol, record] of [...sessions]) dispose(symbol, record);
  }

  return Object.freeze({
    read,
    close,
    get activeCount() { return sessions.size; }
  });
}

export {DEFAULT_IDLE_MS, DEFAULT_MAX_SESSIONS};
