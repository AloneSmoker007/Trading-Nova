import {DEPTH_SNAPSHOT_LIMITS, BinanceSpotDepthBook} from "./order-book.js";

const SYMBOL_RE = /^[A-Z0-9]{2,24}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {fatal: true});

function normalizeSymbol(value) {
  const symbol = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!SYMBOL_RE.test(symbol)) throw new TypeError("invalid depth symbol");
  return symbol;
}

function subscribe(socket, type, handler) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(type, handler);
    return () => socket.removeEventListener?.(type, handler);
  }
  if (typeof socket.on === "function") {
    socket.on(type, handler);
    return () => {
      if (typeof socket.off === "function") socket.off(type, handler);
      else socket.removeListener?.(type, handler);
    };
  }
  throw new TypeError("WebSocket must support event listeners");
}

function decodeMessage(value, maxBytes) {
  try {
    if (typeof value === "string") {
      if (encoder.encode(value).byteLength > maxBytes) return {ok: false, reason: "message-too-large"};
      return {ok: true, text: value};
    }
    let bytes;
    if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else return {ok: false, reason: "invalid-message"};
    if (bytes.byteLength > maxBytes) return {ok: false, reason: "message-too-large"};
    return {ok: true, text: decoder.decode(bytes)};
  } catch {
    return {ok: false, reason: "invalid-message"};
  }
}

// Owns one public Binance Spot depth stream and its snapshot/resnapshot lifecycle.
// The stream is opened first; the first diff event is buffered before REST snapshot
// fetch, preserving Binance's documented sequence-bridge procedure. This class is
// analysis-only: its book always reports executionEligible=false.
export class BinanceSpotDepthStream {
  constructor({
    symbol,
    provider,
    WebSocketImpl = globalThis.WebSocket,
    now = () => Date.now(),
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    random = Math.random,
    speed = "100ms",
    snapshotLimit = 100,
    maxBufferedEvents = 1000,
    maxMessageBytes = 256 * 1024,
    snapshotTimeoutMs = 10000,
    connectTimeoutMs = 10000,
    idleTimeoutMs = 5000,
    maxAgeMs = 1000,
    reconnectMinMs = 250,
    reconnectMaxMs = 10000,
    onUpdate = () => {}
  } = {}) {
    this.symbol = normalizeSymbol(symbol);
    if (!provider || typeof provider.getDepthSnapshot !== "function" || typeof provider.getDepthStreamUrl !== "function") {
      throw new TypeError("depth provider is required");
    }
    if (typeof WebSocketImpl !== "function") throw new TypeError("WebSocket implementation is required");
    if (typeof now !== "function" || typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function"
        || typeof random !== "function" || typeof onUpdate !== "function") {
      throw new TypeError("invalid depth stream dependency");
    }
    if (speed !== "100ms" && speed !== "1000ms") throw new TypeError("invalid depth stream speed");
    if (!DEPTH_SNAPSHOT_LIMITS.includes(snapshotLimit)) throw new TypeError("invalid depth snapshot limit");
    if (!Number.isInteger(maxBufferedEvents) || maxBufferedEvents < 1 || maxBufferedEvents > 10000) {
      throw new TypeError("invalid depth event buffer limit");
    }
    if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 256 || maxMessageBytes > 1024 * 1024) {
      throw new TypeError("invalid depth message limit");
    }
    if (!Number.isFinite(snapshotTimeoutMs) || snapshotTimeoutMs < 100 || snapshotTimeoutMs > 60000
        || !Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 100 || connectTimeoutMs > 120000
        || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 100 || idleTimeoutMs > 120000
        || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > 60000
        || !Number.isFinite(reconnectMinMs) || reconnectMinMs < 10
        || !Number.isFinite(reconnectMaxMs) || reconnectMaxMs < reconnectMinMs || reconnectMaxMs > 300000) {
      throw new TypeError("invalid depth stream timing");
    }

    this.provider = provider;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.random = random;
    this.speed = speed;
    this.snapshotLimit = snapshotLimit;
    this.maxMessageBytes = maxMessageBytes;
    this.snapshotTimeoutMs = snapshotTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxAgeMs = maxAgeMs;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.onUpdate = onUpdate;

    this.book = new BinanceSpotDepthBook({symbol: this.symbol, now, maxBufferedEvents});
    this.started = false;
    this.state = "idle";
    this.lastError = null;
    this.reconnectAttempt = 0;
    this.lifecycleToken = 0;
    this.connectionToken = 0;
    this.socket = null;
    this.socketDisposers = [];
    this.openedConnection = null;
    this.snapshotStarted = false;
    this.reconnectTimer = null;
    this.idleTimer = null;
    this.snapshotTimer = null;
  }

  start() {
    if (this.started) return this.getView();
    this.started = true;
    this.reconnectAttempt = 0;
    const lifecycle = ++this.lifecycleToken;
    this._connect(lifecycle);
    return this.getView();
  }

  stop() {
    if (!this.started && this.state === "stopped") return this.getView();
    this.started = false;
    this.lifecycleToken++;
    this._clearTimer("reconnectTimer");
    this._clearTimer("idleTimer");
    this._clearTimer("snapshotTimer");
    const socket = this.socket;
    this.socket = null;
    this.connectionToken++;
    this.openedConnection = null;
    this.snapshotStarted = false;
    this._disposeSocketListeners();
    this._closeSocket(socket);
    this.book.reset();
    this.state = "stopped";
    this.lastError = null;
    this.reconnectAttempt = 0;
    this._emit();
    return this.getView();
  }

  getView() {
    const book = this.book.getView({maxAgeMs: this.maxAgeMs});
    const transportState = this.state === "ready" && !book.isUsable ? "degraded" : this.state;
    return Object.freeze({
      ...book,
      transportState,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError
    });
  }

  _emit() {
    try { this.onUpdate(this.getView()); } catch {}
  }

  _clearTimer(name) {
    const timer = this[name];
    if (timer !== null) {
      this.clearTimeoutImpl(timer);
      this[name] = null;
    }
  }

  _disposeSocketListeners() {
    for (const dispose of this.socketDisposers.splice(0)) {
      try { dispose(); } catch {}
    }
  }

  _closeSocket(socket) {
    if (!socket || typeof socket.close !== "function") return;
    try { socket.close(); } catch {}
  }

  _isCurrent(socket, lifecycle, connection) {
    return this.started
      && this.lifecycleToken === lifecycle
      && this.connectionToken === connection
      && this.socket === socket;
  }

  _connect(lifecycle) {
    if (!this.started || this.lifecycleToken !== lifecycle) return;
    this._clearTimer("idleTimer");
    this._clearTimer("snapshotTimer");
    this.book.reset();
    this.openedConnection = null;
    this.snapshotStarted = false;
    this.state = "connecting";
    this._emit();
    if (!this.started || this.lifecycleToken !== lifecycle) return;

    let streamUrl = null;
    try {
      const result = this.provider.getDepthStreamUrl(this.symbol, {speed: this.speed});
      const expectedSuffix = this.speed === "100ms" ? "@100ms" : "";
      const expectedUrl = "wss://stream.binance.com:9443/ws/" + this.symbol.toLowerCase() + "@depth" + expectedSuffix;
      if (result?.ok === true && result.data === expectedUrl) streamUrl = result.data;
    } catch {}
    if (!streamUrl) {
      this._scheduleReconnect("stream-url-unavailable", lifecycle);
      return;
    }

    let socket;
    try { socket = new this.WebSocketImpl(streamUrl); } catch {
      this._scheduleReconnect("socket-construction-failed", lifecycle);
      return;
    }
    if (!socket || typeof socket.close !== "function") {
      this._closeSocket(socket);
      this._scheduleReconnect("socket-construction-failed", lifecycle);
      return;
    }

    const connection = ++this.connectionToken;
    this.socket = socket;
    this.socketDisposers = [];
    try {
      this.socketDisposers.push(subscribe(socket, "open", () => this._handleOpen(socket, lifecycle, connection)));
      this.socketDisposers.push(subscribe(socket, "message", (event) => this._handleMessage(socket, lifecycle, connection, event)));
      this.socketDisposers.push(subscribe(socket, "error", () => this._failConnection("stream-error", socket, lifecycle, connection)));
      this.socketDisposers.push(subscribe(socket, "close", () => this._failConnection("stream-closed", socket, lifecycle, connection)));
      this._armConnectTimer(socket, lifecycle, connection);
    } catch {
      this.socket = null;
      this.connectionToken++;
      this._disposeSocketListeners();
      this._closeSocket(socket);
      this._scheduleReconnect("socket-listener-failed", lifecycle);
    }
  }

  _handleOpen(socket, lifecycle, connection) {
    if (!this._isCurrent(socket, lifecycle, connection) || this.openedConnection === connection) return;
    this.openedConnection = connection;
    this.state = "syncing";
    this._armIdleTimer(socket, lifecycle, connection);
    this._emit();
  }

  _handleMessage(socket, lifecycle, connection, event) {
    if (!this._isCurrent(socket, lifecycle, connection) || this.openedConnection !== connection) return;
    this._armIdleTimer(socket, lifecycle, connection);
    const decoded = decodeMessage(event?.data ?? event, this.maxMessageBytes);
    if (!decoded.ok) {
      this._failConnection(decoded.reason, socket, lifecycle, connection);
      return;
    }

    let payload;
    try { payload = JSON.parse(decoded.text); } catch {
      this._failConnection("invalid-message", socket, lifecycle, connection);
      return;
    }
    const view = this.book.ingest(payload);
    if (view.status === "invalid") {
      this._failConnection("depth-" + view.reason, socket, lifecycle, connection);
      return;
    }
    this._publishBookView(view);
    // Fetch the REST snapshot only after at least one stream event is buffered.
    // This prevents a snapshot-first race and gives the book a real sequence bridge.
    if (!this.snapshotStarted && this._isCurrent(socket, lifecycle, connection)) {
      this.snapshotStarted = true;
      void this._startSnapshot(socket, lifecycle, connection);
    }
  }

  async _startSnapshot(socket, lifecycle, connection) {
    let timeoutId = null;
    const timeout = new Promise((_resolve, reject) => {
      timeoutId = this.setTimeoutImpl(() => reject(new Error("snapshot-timeout")), this.snapshotTimeoutMs);
      this.snapshotTimer = timeoutId;
    });
    try {
      const request = Promise.resolve().then(() => this.provider.getDepthSnapshot(this.symbol, {limit: this.snapshotLimit}));
      const result = await Promise.race([request, timeout]);
      if (!this._isCurrent(socket, lifecycle, connection)) return;
      if (!result || result.ok !== true || !result.data) {
        this._failConnection("snapshot-unavailable", socket, lifecycle, connection);
        return;
      }
      const view = this.book.setSnapshot(result.data);
      if (view.status === "invalid") {
        this._failConnection("snapshot-" + view.reason, socket, lifecycle, connection);
        return;
      }
      this._publishBookView(view);
    } catch (error) {
      if (this._isCurrent(socket, lifecycle, connection)) {
        this._failConnection(error?.message === "snapshot-timeout" ? "snapshot-timeout" : "snapshot-failed", socket, lifecycle, connection);
      }
    } finally {
      if (timeoutId !== null) this.clearTimeoutImpl(timeoutId);
      if (this.snapshotTimer === timeoutId) this.snapshotTimer = null;
    }
  }

  _publishBookView(view) {
    if (view.status === "ready") {
      this.state = view.isUsable ? "ready" : "degraded";
      if (view.isUsable) {
        this.reconnectAttempt = 0;
        this.lastError = null;
      }
    } else {
      this.state = "syncing";
    }
    this._emit();
  }

  _armConnectTimer(socket, lifecycle, connection) {
    this._clearTimer("idleTimer");
    this.idleTimer = this.setTimeoutImpl(() => {
      this.idleTimer = null;
      if (this._isCurrent(socket, lifecycle, connection)) {
        this._failConnection("connect-timeout", socket, lifecycle, connection);
      }
    }, this.connectTimeoutMs);
  }

  _armIdleTimer(socket, lifecycle, connection) {
    this._clearTimer("idleTimer");
    this.idleTimer = this.setTimeoutImpl(() => {
      this.idleTimer = null;
      if (this._isCurrent(socket, lifecycle, connection)) {
        this._failConnection("stream-idle", socket, lifecycle, connection);
      }
    }, this.idleTimeoutMs);
  }

  _failConnection(reason, socket, lifecycle, connection) {
    if (!this._isCurrent(socket, lifecycle, connection)) return;
    this.socket = null;
    this.connectionToken++;
    this.openedConnection = null;
    this.snapshotStarted = false;
    this._disposeSocketListeners();
    this._clearTimer("idleTimer");
    this._clearTimer("snapshotTimer");
    this.book.reset();
    this._closeSocket(socket);
    this._scheduleReconnect(reason, lifecycle);
  }

  _scheduleReconnect(reason, lifecycle) {
    if (!this.started || this.lifecycleToken !== lifecycle || this.reconnectTimer !== null) return;
    this.state = "reconnecting";
    this.lastError = reason;
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt = Math.min(attempt + 1, 31);
    const baseDelay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * (2 ** Math.min(attempt, 20)));
    let sample = 0.5;
    try {
      const value = this.random();
      if (Number.isFinite(value)) sample = Math.max(0, Math.min(1, value));
    } catch {}
    const delay = Math.max(1, Math.min(this.reconnectMaxMs, Math.round(baseDelay * (0.5 + sample))));
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      this._connect(lifecycle);
    }, delay);
    this._emit();
  }
}
