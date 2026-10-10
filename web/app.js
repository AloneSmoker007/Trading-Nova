// Trading Nova dashboard — vanilla JS, no build step.
//
// Rendering policy (security): ALL dynamic values are written with
// createTextNode / textContent via DOM API helpers. No markup strings
// are assembled from data, so untrusted upstream text cannot become markup.

(function () {
  "use strict";

  var SYMBOL_RE = /^[A-Za-z0-9]{2,24}$/;
  var AUTO_REFRESH_MS = 30000;

  var pendingOrderFingerprint = null;
  var pendingOrderKey = null;
  var orderSubmissionInProgress = false;
  var orderOutcomeUncertain = false;

  var chartInstance = null;
  var candleSeries = null;
  var volumeSeries = null;
  var sma20Series = null;
  var sma50Series = null;
  var chartResizeObserver = null;
  var chartResizeBound = false;
  var chartViewportKey = null;
  var chartNeedsFit = true;

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fmtNum(v, digits) {
    if (!Number.isFinite(v)) return "—";
    return v.toLocaleString("en-US", {
      maximumFractionDigits: digits === undefined ? 2 : digits,
      minimumFractionDigits: 0
    });
  }

  function fmtPct(v, digits) {
    return Number.isFinite(v) ? fmtNum(v, digits) + "%" : "—";
  }

  function fmtTime(ts) {
    return Number.isFinite(ts) ? new Date(ts).toLocaleTimeString() : "—";
  }

  function fmtAge(ms) {
    if (!Number.isFinite(ms)) return "—";
    if (ms < 1000) return Math.round(ms) + " ms";
    if (ms < 60000) return Math.round(ms / 1000) + " s";
    return Math.round(ms / 60000) + " min";
  }

  function setBadge(id, state, text) {
    var badge = $(id);
    if (!badge) return;
    badge.dataset.state = state;
    badge.textContent = text !== undefined ? text : String(state).toUpperCase();
  }

  function setBusy(valuesId, busy) {
    var node = $(valuesId);
    if (node) node.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function row(dl, label, value) {
    if (!dl) return;
    dl.appendChild(el("dt", null, label));
    dl.appendChild(el("dd", null, value === null || value === undefined ? "—" : String(value)));
  }

  function note(id, text) {
    var node = $(id);
    if (node) node.textContent = text || "";
  }

  function api(path, options) {
    var opts = options || {};
    return fetch(path, {
      method: opts.method || "GET",
      cache: "no-store",
      headers: Object.assign({ Accept: "application/json" }, opts.headers || {}),
      body: opts.body
    })
      .then(function (res) {
        return res.json()
          .catch(function () { return null; })
          .then(function (body) { return { status: res.status, body: body }; });
      })
      .catch(function () {
        throw new Error("Cannot reach the local API server (is npm run serve running?)");
      });
  }

  function failureState(result) {
    var body = result.body;
    if (!body || typeof body !== "object") {
      return { state: result.status >= 500 ? "unavailable" : "error", message: "HTTP " + result.status };
    }
    var state = typeof body.state === "string" ? body.state : "error";
    if (state === "not-implemented") state = "error";
    var message = body.error && body.error.message ? String(body.error.message) : "Request failed";
    if (body.error && body.error.reason) message += " (" + String(body.error.reason) + ")";
    return { state: state, message: message };
  }

  // ---------------------------------------------------------------- Panels

  function renderWatchlist() {
    setBadge("watchlist-badge", "loading");
    return api("/api/markets").then(function (result) {
      var container = $("watchlist-grid");
      clear(container);
      var body = result.body;
      if (result.status === 200 && body && body.ok === true && Array.isArray(body.data?.markets)) {
        setBadge("watchlist-badge", "ok", "ACTIVE (" + body.data.markets.length + ")");
        body.data.markets.forEach(function (m) {
          var chip = el("div", "watchlist-chip");
          chip.tabIndex = 0;
          chip.role = "button";
          chip.setAttribute("aria-label", "Switch target symbol to " + m.symbol);

          var head = el("div", "watchlist-chip-head");
          head.appendChild(el("span", "watchlist-symbol", m.symbol));
          var change = el("span", "watchlist-change " + (m.changePct24h >= 0 ? "up" : "down"),
            (m.changePct24h >= 0 ? "+" : "") + fmtPct(m.changePct24h));
          head.appendChild(change);

          chip.appendChild(head);
          chip.appendChild(el("div", "watchlist-price", "$" + fmtNum(m.last)));
          chip.appendChild(el("div", "watchlist-vol", "24h Vol: $" + fmtNum(m.volume24h, 0)));

          chip.addEventListener("click", function () {
            $("symbol-input").value = m.symbol;
            refreshAll();
          });
          chip.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              $("symbol-input").value = m.symbol;
              refreshAll();
            }
          });
          container.appendChild(chip);
        });
      } else {
        setBadge("watchlist-badge", "unavailable", "UNAVAILABLE");
      }
    }).catch(function () {
      setBadge("watchlist-badge", "unavailable", "OFFLINE");
    });
  }

  function renderMarket() {
    setBadge("market-badge", "loading");
    setBusy("market-values", true);
    var symbol = $("symbol-input").value.trim().toUpperCase();
    return api("/api/market/" + encodeURIComponent(symbol)).then(function (result) {
      var dl = $("market-values");
      clear(dl);
      var body = result.body;
      if (result.status === 200 && body && body.ok === true && body.data) {
        var d = body.data;
        var t = d.ticker || {};
        var orderPrice = $("order-price");
        if (orderPrice && !orderSubmissionInProgress && orderPrice.dataset.edited !== "true") {
          var freshMark = d.state === "ok" && Number.isFinite(t.last) && t.last > 0;
          orderPrice.value = freshMark ? String(t.last) : "";
        }
        setBadge("market-badge", d.state === "stale" ? "stale" : "ok", d.state === "stale" ? "STALE" : "OK");
        row(dl, "Symbol", d.symbol);
        row(dl, "Last", fmtNum(t.last));
        row(dl, "Bid", fmtNum(t.bid));
        row(dl, "Ask", fmtNum(t.ask));
        row(dl, "24h high", fmtNum(t.high24h));
        row(dl, "24h low", fmtNum(t.low24h));
        row(dl, "24h volume", fmtNum(t.volume24h, 0));
        row(dl, "24h change", fmtPct(t.changePct24h));
        note("market-note", d.note);
      } else {
        var f = failureState(result);
        setBadge("market-badge", f.state);
        note("market-note", f.message);
      }
    }).catch(function (err) {
      setBadge("market-badge", "unavailable");
      note("market-note", err.message);
    }).finally(function () {
      setBusy("market-values", false);
    });
  }

  function renderChartAndIndicators() {
    setBadge("chart-badge", "loading");
    setBadge("indicators-badge", "loading");
    setBusy("indicators-values", true);
    var symbol = readSymbol();
    if (!symbol) return Promise.resolve();

    $("chart-symbol-label").textContent = symbol;
    var interval = $("interval-input").value;
    var limit = $("limit-input").value;

    var path = "/api/indicators/" + encodeURIComponent(symbol) +
      "?interval=" + encodeURIComponent(interval) + "&limit=" + encodeURIComponent(limit);

    return api(path).then(function (result) {
      var dl = $("indicators-values");
      clear(dl);
      var body = result.body;
      if (result.status === 200 && body && body.ok === true && body.data) {
        var d = body.data;
        var ind = d.indicators || {};
        setBadge("chart-badge", d.state === "stale" ? "stale" : "ok", d.state === "stale" ? "STALE" : "LIVE");
        setBadge("indicators-badge", d.state === "stale" ? "stale" : "ok", d.state === "stale" ? "STALE" : "OK");

        drawInteractiveChart(d.candles, symbol, interval);

        row(dl, "Candles used", d.candleCount + " × " + d.interval);
        var trend = ind.trend || {};
        row(dl, "Trend · SMA(20)", fmtNum(trend.sma20));
        row(dl, "Trend · SMA(50)", fmtNum(trend.sma50));
        row(dl, "Trend · VWAP", fmtNum(trend.vwap));
        row(dl, "Trend · MACD", fmtNum(trend.macd, 4) + " (signal " + fmtNum(trend.macdSignal, 4) + ")");
        row(dl, "Trend direction", trend.trendDirection);

        var mom = ind.momentum || {};
        row(dl, "Momentum · RSI(14)", fmtNum(mom.rsi14));
        row(dl, "Momentum · ATR(14)", fmtNum(mom.atr14));

        var vol = ind.volatility || {};
        row(dl, "Volatility regime", vol.regime);

        note("indicators-note", d.note);
      } else {
        var f = failureState(result);
        setBadge("chart-badge", f.state);
        setBadge("indicators-badge", f.state);
        clearInteractiveChart("Chart unavailable: " + f.message);
        note("indicators-note", f.message);
      }
    }).catch(function (err) {
      setBadge("chart-badge", "unavailable");
      setBadge("indicators-badge", "unavailable");
      clearInteractiveChart("Chart unavailable: " + err.message);
      note("indicators-note", err.message);
    }).finally(function () {
      setBusy("indicators-values", false);
    });
  }

  function clearInteractiveChart(message) {
    if (candleSeries) candleSeries.setData([]);
    if (volumeSeries) volumeSeries.setData([]);
    if (sma20Series) sma20Series.setData([]);
    if (sma50Series) sma50Series.setData([]);
    chartNeedsFit = true;
    if (message) note("chart-note", message);
  }

  function applyChartVisibility() {
    if (sma20Series) sma20Series.applyOptions({ visible: $("chart-sma20").checked });
    if (sma50Series) sma50Series.applyOptions({ visible: $("chart-sma50").checked });
    if (volumeSeries) volumeSeries.applyOptions({ visible: $("chart-volume").checked });
  }

  function resizeInteractiveChart(width, height) {
    if (!chartInstance) return;
    var w = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
    var h = Number.isFinite(height) && height > 0 ? Math.floor(height) : 0;
    if (w >= 200 && h >= 220) chartInstance.applyOptions({ width: w, height: h });
  }

  function ensureInteractiveChart() {
    if (chartInstance) return true;
    var container = $("price-chart");
    var lib = window.LightweightCharts;
    if (!container || !lib || typeof lib.createChart !== "function") {
      setBadge("chart-badge", "unavailable", "CHART OFFLINE");
      note("chart-note", "Interactive chart library unavailable. Run npm install (or npm run charts:vendor) to restore the local chart asset.");
      return false;
    }

    try {
      chartInstance = lib.createChart(container, {
        width: Math.max(200, Math.floor(container.clientWidth || 800)),
        height: Math.max(220, Math.floor(container.clientHeight || 320)),
        layout: {
          background: { type: lib.ColorType.Solid, color: "#070b16" },
          textColor: "#b8c2dc",
          attributionLogo: true
        },
        grid: {
          vertLines: { color: "#1c2438" },
          horzLines: { color: "#1c2438" }
        },
        rightPriceScale: { borderColor: "#2a3550" },
        timeScale: {
          borderColor: "#2a3550",
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 5
        },
        crosshair: { mode: lib.CrosshairMode.Normal },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false
        },
        handleScale: {
          axisPressedMouseMove: true,
          mouseWheel: true,
          pinch: true
        },
        localization: { locale: "en-US" }
      });

      candleSeries = chartInstance.addCandlestickSeries({
        upColor: "#34d399",
        downColor: "#f87171",
        borderUpColor: "#34d399",
        borderDownColor: "#f87171",
        wickUpColor: "#34d399",
        wickDownColor: "#f87171",
        lastValueVisible: true,
        priceLineVisible: true
      });
      volumeSeries = chartInstance.addHistogramSeries({
        priceScaleId: "",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false
      });
      chartInstance.priceScale("").applyOptions({
        scaleMargins: { top: 0.82, bottom: 0 }
      });
      sma20Series = chartInstance.addLineSeries({
        color: "#7aa2f7",
        lineWidth: 2,
        title: "SMA 20",
        lastValueVisible: false,
        priceLineVisible: false
      });
      sma50Series = chartInstance.addLineSeries({
        color: "#fbbf24",
        lineWidth: 2,
        title: "SMA 50",
        lastValueVisible: false,
        priceLineVisible: false
      });
      applyChartVisibility();

      if (typeof window.ResizeObserver === "function") {
        chartResizeObserver = new window.ResizeObserver(function (entries) {
          if (!entries.length) return;
          var rect = entries[0].contentRect;
          resizeInteractiveChart(rect.width, rect.height);
        });
        chartResizeObserver.observe(container);
      } else if (!chartResizeBound) {
        window.addEventListener("resize", function () {
          var rect = container.getBoundingClientRect();
          resizeInteractiveChart(rect.width, rect.height);
        });
        chartResizeBound = true;
      }
      return true;
    } catch (_err) {
      chartInstance = null;
      candleSeries = null;
      volumeSeries = null;
      sma20Series = null;
      sma50Series = null;
      setBadge("chart-badge", "unavailable", "CHART ERROR");
      note("chart-note", "Could not initialize the interactive chart. The terminal remains paper-only; no substitute prices are drawn.");
      return false;
    }
  }

  function simpleMovingAverage(candles, period) {
    var result = [];
    var sum = 0;
    candles.forEach(function (c, index) {
      sum += c.close;
      if (index >= period) sum -= candles[index - period].close;
      if (index >= period - 1) result.push({ time: c.time, value: sum / period });
    });
    return result;
  }

  function drawInteractiveChart(candles, symbol, interval) {
    if (!ensureInteractiveChart()) return;

    if (!Array.isArray(candles) || candles.length === 0) {
      clearInteractiveChart("No real candle data available. Chart withheld instead of generating placeholder prices.");
      setBadge("chart-badge", "unavailable", "NO CANDLES");
      return;
    }

    var actual = candles.map(function (c) {
      return {
        time: c && c.time,
        open: c && c.open,
        high: c && c.high,
        low: c && c.low,
        close: c && c.close,
        volume: c && c.volume
      };
    });
    var invalid = actual.some(function (c) {
      return !c || !Number.isSafeInteger(c.time) || c.time <= 0 ||
        ![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) ||
        c.open <= 0 || c.close <= 0 || c.volume < 0 ||
        c.high < c.low || c.open < c.low || c.open > c.high ||
        c.close < c.low || c.close > c.high;
    });
    if (invalid) {
      clearInteractiveChart("Invalid OHLCV payload — chart withheld.");
      setBadge("chart-badge", "error", "INVALID DATA");
      return;
    }

    actual.sort(function (a, b) { return a.time - b.time; });
    for (var i = 1; i < actual.length; i++) {
      if (actual[i].time <= actual[i - 1].time) {
        clearInteractiveChart("Duplicate or out-of-order candle times — chart withheld.");
        setBadge("chart-badge", "error", "INVALID TIME");
        return;
      }
    }

    candleSeries.setData(actual.map(function (c) {
      return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
    }));
    volumeSeries.setData(actual.map(function (c) {
      return {
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? "rgba(52,211,153,0.42)" : "rgba(248,113,113,0.42)"
      };
    }));
    sma20Series.setData(simpleMovingAverage(actual, 20));
    sma50Series.setData(simpleMovingAverage(actual, 50));
    applyChartVisibility();

    var key = String(symbol) + "|" + String(interval);
    if (chartNeedsFit || chartViewportKey !== key) {
      chartInstance.timeScale().fitContent();
      chartViewportKey = key;
      chartNeedsFit = false;
    }
    note("chart-note", actual.length + " real " + interval + " candles · scroll/zoom/crosshair enabled · overlays are derived only from displayed candles.");
  }

  function fitInteractiveChart() {
    if (chartInstance) {
      chartInstance.timeScale().fitContent();
      chartNeedsFit = false;
    }
  }

  function renderAiCouncil() {
    setBadge("ai-badge", "loading");
    var symbol = readSymbol();
    if (!symbol) return Promise.resolve();

    return api("/api/ai/council/" + encodeURIComponent(symbol)).then(function (result) {
      var body = result.body;
      if (result.status === 200 && body && body.ok === true && body.data?.council) {
        var c = body.data.council;
        setBadge("ai-badge", "ok", "ANALYZED");

        $("ai-score-val").textContent = c.opportunityScore + " / 100";
        setBadge("ai-decision-badge", c.decision === "WAIT" ? "no-trade" : "ok", c.decision);
        $("ai-uncertainty-val").textContent = String(c.uncertainty).toUpperCase();

        var rolesContainer = $("ai-roles-list");
        clear(rolesContainer);

        (c.roles || []).forEach(function (r) {
          var item = el("div", "ai-role-item");
          item.appendChild(el("span", "ai-role-name", r.role));
          item.appendChild(el("span", "ai-role-score", r.score + "/100"));
          item.appendChild(el("span", "ai-role-reason", r.reason));
          rolesContainer.appendChild(item);
        });

        $("ai-explanation").textContent = c.explanation;
      } else {
        setBadge("ai-badge", "unavailable", "UNAVAILABLE");
      }
    }).catch(function () {
      setBadge("ai-badge", "unavailable", "OFFLINE");
    });
  }

  function renderPortfolio() {
    setBadge("portfolio-badge", "loading");
    setBusy("portfolio-values", true);
    return api("/api/portfolio").then(function (result) {
      var dl = $("portfolio-values");
      var wrap = $("portfolio-positions-wrap");
      var tbody = $("portfolio-positions-body");
      clear(dl);
      clear(tbody);
      wrap.hidden = true;
      var body = result.body;
      if (result.status === 200 && body && body.ok === true && body.data) {
        var d = body.data;
        setBadge("portfolio-badge", d.state === "empty" ? "empty" : "ok", d.state === "empty" ? "EMPTY" : "OK");
        if (d.portfolio) {
          var p = d.portfolio;
          row(dl, "Equity", "$" + fmtNum(p.equity));
          row(dl, "Cash", "$" + fmtNum(p.cash));
          row(dl, "Gross exposure", "$" + fmtNum(p.grossExposure));
          row(dl, "Daily P&L", "$" + fmtNum(p.dailyPnl));
          row(dl, "Drawdown", fmtPct(Number.isFinite(p.drawdown) ? p.drawdown * 100 : null));
          if (Array.isArray(p.positions) && p.positions.length > 0) {
            p.positions.forEach(function (pos) {
              var tr = el("tr");
              tr.appendChild(el("td", null, pos.symbol));
              tr.appendChild(el("td", null, fmtNum(pos.quantity, 6)));
              tr.appendChild(el("td", null, "$" + fmtNum(pos.markPrice)));
              tr.appendChild(el("td", null, "$" + fmtNum(pos.notional)));
              tbody.appendChild(tr);
            });
            wrap.hidden = false;
          }
        }
        note("portfolio-note", d.note);
      } else {
        var f = failureState(result);
        setBadge("portfolio-badge", f.state);
        note("portfolio-note", f.message);
      }
    }).catch(function (err) {
      setBadge("portfolio-badge", "unavailable");
      note("portfolio-note", err.message);
    }).finally(function () {
      setBusy("portfolio-values", false);
    });
  }

  function renderOrderHistory() {
    setBadge("orders-badge", "loading");
    return api("/api/orders").then(function (result) {
      var tbody = $("orders-history-body");
      clear(tbody);
      var body = result.body;
      if (result.status === 200 && body && body.ok === true && Array.isArray(body.data?.fills)) {
        var fills = body.data.fills;
        var totalOrders = Number.isSafeInteger(body.data.total) ? body.data.total : fills.length;
        setBadge("orders-badge", totalOrders ? "ok" : "empty", totalOrders ? "RECONCILED (" + totalOrders + ")" : "NO FILLS");
        fills.slice(0, 10).forEach(function (f) {
          var tr = el("tr");
          tr.appendChild(el("td", null, fmtTime(f.timestamp)));
          tr.appendChild(el("td", null, f.symbol));
          tr.appendChild(el("td", null, f.side));
          tr.appendChild(el("td", null, fmtNum(f.quantity, 6)));
          tr.appendChild(el("td", null, "$" + fmtNum(f.price)));
          tr.appendChild(el("td", null, f.status || "RECONCILED"));
          tbody.appendChild(tr);
        });
      } else {
        setBadge("orders-badge", "unavailable", "UNAVAILABLE");
      }
    }).catch(function () {
      setBadge("orders-badge", "unavailable", "OFFLINE");
    });
  }

  function renderStrategyLab() {
    setBadge("lab-badge", "loading");
    var symbol = readSymbol();
    if (!symbol) return Promise.resolve();

    return api("/api/strategy/lab?symbol=" + encodeURIComponent(symbol) + "&interval=1h&limit=100").then(function (result) {
      var tbody = $("lab-body");
      var dl = $("backtest-values");
      clear(tbody);
      clear(dl);
      var body = result.body;
      if (result.status === 200 && body && body.ok === true && Array.isArray(body.data?.strategies)) {
        setBadge("lab-badge", "ok", "SIMULATED");
        body.data.strategies.forEach(function (s) {
          var tr = el("tr");
          tr.appendChild(el("td", null, s.name));
          tr.appendChild(el("td", null, fmtPct(s.returnPct)));
          tr.appendChild(el("td", null, String(s.trades)));
          tr.appendChild(el("td", null, "$" + fmtNum(s.finalEquity)));
          tbody.appendChild(tr);
          row(dl, s.name + " Return", fmtPct(s.returnPct));
        });
      } else {
        setBadge("lab-badge", "unavailable", "UNAVAILABLE");
      }
    }).catch(function () {
      setBadge("lab-badge", "unavailable", "OFFLINE");
    });
  }

  function renderJournal() {
    setBadge("journal-badge", "loading");
    setBusy("journal-values", true);
    return api("/api/journal").then(function (result) {
      var dl = $("journal-values");
      var list = $("journal-entries");
      clear(dl);
      clear(list);
      var body = result.body;
      if (result.status === 200 && body && body.ok === true && body.data) {
        var d = body.data;
        var broken = d.integrity === "broken";
        setBadge("journal-badge", broken ? "error" : (d.state === "empty" ? "empty" : "ok"),
          broken ? "INTEGRITY BROKEN" : (d.state === "empty" ? "EMPTY" : "HASH CHAIN VERIFIED"));
        row(dl, "Total entries", String(d.total));
        row(dl, "Integrity", broken ? "FAILED — untrusted history" : "Verified sha256 chain");

        (d.entries || []).forEach(function (record) {
          if (!record || typeof record !== "object") return;
          var summary = JSON.stringify(record.entry === undefined ? record : record.entry);
          if (summary.length > 200) summary = summary.slice(0, 200) + "…";
          var li = el("li", null, "#" + String(record.index) + " " + summary);
          list.appendChild(li);
        });
        note("journal-note", d.note);
      } else {
        var f = failureState(result);
        setBadge("journal-badge", f.state);
        note("journal-note", f.message);
      }
    }).catch(function (err) {
      setBadge("journal-badge", "unavailable");
      note("journal-note", err.message);
    }).finally(function () {
      setBusy("journal-values", false);
    });
  }

  function renderRiskStatus() {
    setBadge("risk-badge", "loading");
    setBusy("risk-values", true);
    return api("/api/risk/status").then(function (result) {
      var dl = $("risk-values");
      var alertsContainer = $("risk-alerts-list");
      clear(dl);
      clear(alertsContainer);
      var body = result.body;
      if (result.status === 200 && body && body.ok === true && body.data) {
        var d = body.data;
        var breached = d.killSwitchActive;
        setBadge("risk-badge", breached ? "error" : "ok", breached ? "BREACH / NO-TRADE" : "GATE ACTIVE");
        setBadge("header-gate-badge", breached ? "error" : "ok", breached ? "RISK GATE BREACH" : "RISK GATE ACTIVE");

        row(dl, "Max Position Cap", "$" + fmtNum(d.riskConfig.maxPositionNotional));
        row(dl, "Max Gross Exposure", "$" + fmtNum(d.riskConfig.maxGrossExposure));
        row(dl, "Max Daily Loss Limit", "$" + fmtNum(d.riskConfig.maxDailyLoss));
        row(dl, "Max Drawdown Cap", d.riskConfig.maxDrawdownPct + "%");
        row(dl, "Kill Switch Status", d.killSwitchActive ? "ACTIVE (Trading Stopped)" : "NORMAL");

        (d.alerts || []).forEach(function (alt) {
          var item = el("div", "risk-alert-item " + alt.level.toLowerCase(), alt.level + ": " + alt.message);
          alertsContainer.appendChild(item);
        });
      } else {
        setBadge("risk-badge", "unavailable", "UNAVAILABLE");
      }
    }).catch(function () {
      setBadge("risk-badge", "unavailable", "OFFLINE");
    }).finally(function () {
      setBusy("risk-values", false);
    });
  }

  function renderHealth() {
    setBadge("health-badge", "loading");
    setBusy("health-values", true);
    return api("/api/health").then(function (result) {
      var dl = $("health-values");
      clear(dl);
      var body = result.body;
      if (result.status === 200 && body && body.ok === true && body.data) {
        var d = body.data;
        setBadge("health-badge", d.status === "ok" ? "ok" : "stale", d.status === "ok" ? "OK" : "DEGRADED");
        row(dl, "Engine status", d.status);
        row(dl, "Trading mode", d.tradingMode + " (fake money only)");
        row(dl, "Market data fresh", d.marketFresh ? "yes" : "no");
        row(dl, "Uptime", fmtAge(d.uptimeMs));
        note("health-note", d.note);
      } else {
        var f = failureState(result);
        setBadge("health-badge", f.state);
        note("health-note", f.message);
      }
    }).catch(function (err) {
      setBadge("health-badge", "unavailable");
      note("health-note", err.message);
    }).finally(function () {
      setBusy("health-values", false);
    });
  }

  // ------------------------------------------------------------- Controls & Submissions

  function readSymbol() {
    var input = $("symbol-input");
    var raw = input.value.trim().toUpperCase();
    if (!SYMBOL_RE.test(raw)) {
      input.setAttribute("aria-invalid", "true");
      $("live-status").textContent = "Invalid symbol — use 2–24 letters/digits (e.g. BTCUSDT).";
      input.focus();
      return null;
    }
    input.removeAttribute("aria-invalid");
    input.value = raw;
    if ($("order-symbol")) $("order-symbol").textContent = raw;
    return raw;
  }

  function makeIdempotencyKey() {
    if (!window.crypto) throw new Error("Secure order keys are unavailable in this browser");
    if (typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function sendPaperOrder(order) {
    return fetch("/api/paper/orders", {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(order)
    }).then(function (res) {
      return res.json()
        .catch(function () { return null; })
        .then(function (body) { return { status: res.status, body: body }; });
    }).catch(function () {
      throw new Error("Cannot reach the local API server. Retrying this order will reuse its idempotency key.");
    });
  }

  function submitPaperOrder(event) {
    event.preventDefault();
    if (orderSubmissionInProgress) return;
    var symbol = readSymbol();
    if (!symbol) return;

    var order = {
      symbol: symbol,
      side: $("order-side").value,
      type: $("order-type").value,
      quantity: Number($("order-quantity").value),
      price: Number($("order-price").value),
      reduceOnly: $("order-reduce-only").checked
    };

    var stopPriceVal = Number($("order-stop-price").value);
    if (Number.isFinite(stopPriceVal) && stopPriceVal > 0) {
      order.stopPrice = stopPriceVal;
    }

    if (!Number.isFinite(order.quantity) || order.quantity <= 0 ||
        !Number.isFinite(order.price) || order.price <= 0) {
      setBadge("order-badge", "error", "INVALID INPUT");
      note("order-note", "Enter a positive quantity and paper execution price.");
      return;
    }

    var fingerprint = JSON.stringify([order.symbol, order.side, order.type, order.quantity, order.price, order.reduceOnly]);
    if (orderOutcomeUncertain && fingerprint !== pendingOrderFingerprint) {
      setBadge("order-badge", "unavailable", "NOT CONFIRMED");
      note("order-note", "The previous order outcome is unconfirmed. Check the portfolio, then retry the unchanged order in this tab to reuse its idempotency key.");
      return;
    }
    if (fingerprint !== pendingOrderFingerprint || !pendingOrderKey) {
      try {
        pendingOrderKey = makeIdempotencyKey();
        pendingOrderFingerprint = fingerprint;
      } catch (err) {
        setBadge("order-badge", "error", "BLOCKED");
        note("order-note", err.message);
        return;
      }
    }
    order.idempotencyKey = pendingOrderKey;

    var form = $("order-form");
    orderSubmissionInProgress = true;
    form.setAttribute("aria-busy", "true");
    var disabledControls = Array.prototype.map.call(form.querySelectorAll("input, select, button"), function (control) {
      var wasDisabled = control.disabled;
      control.disabled = true;
      return {control: control, wasDisabled: wasDisabled};
    });

    setBadge("order-badge", "loading", "CHECKING GATE");
    note("order-note", "Submitting to the paper simulator…");

    return sendPaperOrder(order).then(function (result) {
      var body = result.body;
      if (result.status >= 200 && result.status < 300 && body && body.ok === true && body.data) {
        var data = body.data;
        var fill = data.fill || {};
        var replayed = data.state === "replayed" || (data.verdict && data.verdict.replayed);
        setBadge("order-badge", "ok", replayed ? "REPLAYED FILL" : "GATE ALLOW");
        note("order-note", (replayed ? "Previously confirmed fill" : "Paper fill") + ": " +
          [fill.symbol, fill.side, fmtNum(fill.quantity, 6) + " @ $" + fmtNum(fill.price), fill.status]
            .filter(Boolean).join(" · ") + ". Real money OFF.");
        pendingOrderFingerprint = null;
        pendingOrderKey = null;
        orderOutcomeUncertain = false;
        renderPortfolio();
        renderOrderHistory();
        return;
      }

      var failure = failureState(result);
      var verdict = body && body.verdict;
      var noTrade = verdict && verdict.decision === "NO_TRADE";
      var uncertain = result.status === 409 || result.status >= 500 || (result.status >= 200 && result.status < 300);
      orderOutcomeUncertain = uncertain;
      if (!uncertain) {
        pendingOrderFingerprint = null;
        pendingOrderKey = null;
      }
      setBadge("order-badge", noTrade ? "no-trade" : (uncertain ? "unavailable" : "error"),
        noTrade ? "NO TRADE" : (uncertain ? "NOT CONFIRMED" : "BLOCKED"));
      var reasons = verdict && Array.isArray(verdict.reasons) ? verdict.reasons.join(", ") : "";
      var outcome = noTrade ? "No order was placed." : uncertain
        ? "Order outcome is unconfirmed. Check the portfolio before retrying; an unchanged retry in this tab reuses the same idempotency key."
        : "Request rejected; no order was placed.";
      note("order-note", [failure.message, reasons ? "Risk Gate: " + reasons : "", outcome].filter(Boolean).join(" · "));
    }).catch(function (err) {
      orderOutcomeUncertain = true;
      setBadge("order-badge", "unavailable", "NOT CONFIRMED");
      note("order-note", err.message + " Do not change this order before its outcome is confirmed.");
    }).finally(function () {
      orderSubmissionInProgress = false;
      form.setAttribute("aria-busy", "false");
      disabledControls.forEach(function (entry) {
        entry.control.disabled = entry.wasDisabled;
      });
    });
  }

  var tutorHistory = [];
  var tutorBusy = false;

  function addTutorMessage(role, text) {
    var messages = $("tutor-messages");
    if (!messages) return;
    var node = el("p", "tutor-message " + (role === "model" ? "tutor-assistant" : "tutor-user"), text);
    messages.appendChild(node);
    while (messages.children.length > 30) messages.removeChild(messages.firstChild);
    messages.scrollTop = messages.scrollHeight;
  }

  function submitTutorMessage(event) {
    event.preventDefault();
    if (tutorBusy) return;
    var input = $("tutor-input");
    var message = input.value.trim();
    if (!message || message.length > 2000) return;
    var symbol = readSymbol() || "BTCUSDT";
    var priorHistory = tutorHistory.slice(-8);
    tutorBusy = true;
    $("tutor-send-btn").disabled = true;
    input.disabled = true;
    setBadge("tutor-badge", "loading", "THINKING…");
    note("tutor-note", "Tutor jawab tayyar kar raha hai…");
    addTutorMessage("user", message);
    input.value = "";
    return api("/api/tutor/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message, history: priorHistory, symbol: symbol })
    }).then(function (result) {
      if (result.status === 200 && result.body && result.body.ok === true && result.body.data) {
        var answer = result.body.data.answer;
        addTutorMessage("model", answer);
        tutorHistory.push({ role: "user", text: message }, { role: "model", text: answer });
        tutorHistory = tutorHistory.slice(-8);
        setBadge("tutor-badge", "ok", "PAPER ONLY");
        note("tutor-note", result.body.data.note || "AI educational advice only. No order was submitted.");
      } else {
        var failure = result.body && result.body.error;
        var messageText = failure && typeof failure.message === "string" ? failure.message : "Tutor filhal available nahi. Thori dair baad dobara try karein.";
        addTutorMessage("model", messageText);
        setBadge("tutor-badge", "unavailable", "UNAVAILABLE");
        note("tutor-note", "Koi order place nahi hua. " + messageText);
      }
    }).catch(function () {
      addTutorMessage("model", "Tutor server tak pohanch nahi saka. Server status check karke dobara try karein.");
      setBadge("tutor-badge", "unavailable", "OFFLINE");
      note("tutor-note", "Network ya local server error. Koi order place nahi hua.");
    }).finally(function () {
      tutorBusy = false;
      $("tutor-send-btn").disabled = false;
      input.disabled = false;
      input.focus();
    });
  }

  function submitJournalEntry(event) {
    event.preventDefault();
    var title = $("journal-title-input").value.trim();
    var text = $("journal-text-input").value.trim();
    var type = $("journal-type-select").value;
    var symbol = readSymbol() || "GENERAL";

    if (!title || !text) return;

    return api("/api/journal/entry", {
      method: "POST",
      body: JSON.stringify({ title: title, text: text, type: type, symbol: symbol }),
      headers: { "Content-Type": "application/json" }
    }).then(function (result) {
      if (result.status === 200 && result.body && result.body.ok === true) {
        $("journal-title-input").value = "";
        $("journal-text-input").value = "";
        renderJournal();
      }
    });
  }

  function refreshAll() {
    var symbol = readSymbol();
    if (!symbol) return Promise.resolve();
    $("live-status").textContent = "Refreshing terminal…";
    var stamp = new Date().toLocaleTimeString();

    return Promise.all([
      renderWatchlist(),
      renderMarket(),
      renderChartAndIndicators(),
      renderAiCouncil(),
      renderPortfolio(),
      renderOrderHistory(),
      renderStrategyLab(),
      renderJournal(),
      renderRiskStatus(),
      renderHealth()
    ]).then(function () {
      $("live-status").textContent = "Updated " + stamp + " · Paper/shadow workspace — Real money OFF.";
    });
  }

  function configureLogout() {
    var button = $("logout-btn");
    if (!button) return;
    api("/api/auth/status").then(function (result) {
      var enabled = result.status === 200 && result.body && result.body.ok === true
        && result.body.data && result.body.data.privateAccessEnabled === true;
      button.hidden = !enabled;
    }).catch(function () {
      button.hidden = true;
    });
    button.addEventListener("click", function () {
      button.disabled = true;
      api("/api/auth/logout", {method: "POST"}).then(function () {
        window.location.reload();
      }).catch(function () {
        button.disabled = false;
      });
    });
  }

  function boot() {
    $("controls").addEventListener("submit", function (event) {
      event.preventDefault();
      refreshAll();
    });
    $("symbol-input").addEventListener("input", function () {
      $("order-symbol").textContent = this.value.trim().toUpperCase() || "—";
      $("order-price").value = "";
      delete $("order-price").dataset.edited;
    });
    $("order-price").addEventListener("input", function () {
      this.dataset.edited = "true";
    });
    $("order-form").addEventListener("submit", submitPaperOrder);
    $("chart-sma20").addEventListener("change", applyChartVisibility);
    $("chart-sma50").addEventListener("change", applyChartVisibility);
    $("chart-volume").addEventListener("change", applyChartVisibility);
    $("chart-fit-button").addEventListener("click", fitInteractiveChart);

    $("journal-form").addEventListener("submit", submitJournalEntry);
    $("tutor-form").addEventListener("submit", submitTutorMessage);
    configureLogout();

    setInterval(function () {
      if (!document.hidden && $("auto-input").checked) refreshAll();
    }, AUTO_REFRESH_MS);

    refreshAll();
  }

  window.TRADING_NOVA_UI = {
    setState: function (map) {
      if (!map || typeof map !== "object") return;
      Object.keys(map).forEach(function (key) {
        var node = $(key);
        if (node) node.textContent = String(map[key]);
      });
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
