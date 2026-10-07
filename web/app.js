// Trading Nova dashboard — vanilla JS, no build step.
//
// Rendering policy (security): ALL dynamic values are written with
// createTextNode / textContent via the DOM API helpers below. No markup
// strings are ever assembled from data, so untrusted upstream text cannot
// become markup. Values are data, never structure.

(function () {
  "use strict";

  var SYMBOL_RE = /^[A-Za-z0-9]{2,24}$/;
  var AUTO_REFRESH_MS = 30000;

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
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
    dl.appendChild(el("dt", null, label));
    dl.appendChild(el("dd", null, value === null || value === undefined ? "—" : String(value)));
  }

  function note(id, text) {
    var node = $(id);
    if (node) node.textContent = text || "";
  }

  // Fetch one JSON endpoint. Throws Error with a human-readable, non-sensitive
  // message on network/protocol problems (no URLs echoed back with query data).
  function api(path) {
    return fetch(path, {cache: "no-store", headers: {Accept: "application/json"}})
      .then(function (res) {
        return res.json()
          .catch(function () { return null; })
          .then(function (body) { return {status: res.status, body: body}; });
      })
      .catch(function () {
        throw new Error("Cannot reach the local API server (is npm run serve running?)");
      });
  }

  // Map a failed envelope to an honest badge state + message.
  function failureState(result) {
    var body = result.body;
    if (!body || typeof body !== "object") {
      return {state: result.status >= 500 ? "unavailable" : "error", message: "HTTP " + result.status};
    }
    var state = typeof body.state === "string" ? body.state : "error";
    if (state === "not-implemented") state = "error";
    var message = body.error && body.error.message ? String(body.error.message) : "Request failed";
    if (body.error && body.error.reason) message += " (" + String(body.error.reason) + ")";
    return {state: state, message: message};
  }

  // ---------------------------------------------------------------- panels

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
        row(dl, "Trading mode", d.tradingMode + (d.paperOnly ? " (paper only)" : ""));
        row(dl, "Market data", d.marketFresh ? "fresh" : "no fresh data");
        row(dl, "Read-only", d.readOnly ? "yes" : "no");
        row(dl, "Order submission", d.orderSubmission);
        row(dl, "Uptime", fmtAge(d.uptimeMs));
        row(dl, "Checked at", fmtTime(d.checkedAt));
        if (d.dependencies && typeof d.dependencies === "object") {
          Object.keys(d.dependencies).forEach(function (key) {
            row(dl, "Dependency · " + key, String(d.dependencies[key]));
          });
        }
        note("health-note", d.note);
        return;
      }
      var f = failureState(result);
      setBadge("health-badge", f.state);
      note("health-note", f.message);
    }).catch(function (err) {
      setBadge("health-badge", "unavailable");
      note("health-note", err.message);
    }).finally(function () {
      setBusy("health-values", false);
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
        setBadge("market-badge", d.state === "stale" ? "stale" : "ok",
          d.state === "stale" ? "STALE · " + fmtAge(d.ageMs) : "OK");
        row(dl, "Symbol", d.symbol);
        row(dl, "Last", fmtNum(t.last));
        row(dl, "Bid", fmtNum(t.bid));
        row(dl, "Ask", fmtNum(t.ask));
        row(dl, "24h high", fmtNum(t.high24h));
        row(dl, "24h low", fmtNum(t.low24h));
        row(dl, "24h volume", fmtNum(t.volume24h, 0));
        row(dl, "24h change", fmtPct(t.changePct24h));
        if (d.freshness) {
          row(dl, "Data age", fmtAge(d.freshness.ageMs));
          row(dl, "Freshness", d.freshness.status);
        }
        note("market-note", d.note);
        return;
      }
      var f = failureState(result);
      setBadge("market-badge", f.state);
      note("market-note", f.message);
    }).catch(function (err) {
      setBadge("market-badge", "unavailable");
      note("market-note", err.message);
    }).finally(function () {
      setBusy("market-values", false);
    });
  }

  function renderIndicators() {
    setBadge("indicators-badge", "loading");
    setBusy("indicators-values", true);
    var symbol = $("symbol-input").value.trim().toUpperCase();
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
        setBadge("indicators-badge", d.state === "stale" ? "stale" : "ok",
          d.state === "stale" ? "STALE · " + fmtAge(d.ageMs) : "OK");
        row(dl, "Candles used", d.candleCount + " × " + d.interval);
        var trend = ind.trend || {};
        row(dl, "Trend · SMA(20)", fmtNum(trend.sma20));
        row(dl, "Trend · SMA(50)", fmtNum(trend.sma50));
        row(dl, "Trend · EMA(12)", fmtNum(trend.ema12));
        row(dl, "Trend · EMA(26)", fmtNum(trend.ema26));
        row(dl, "Trend · VWAP", fmtNum(trend.vwap));
        row(dl, "Trend · MACD", fmtNum(trend.macd, 4) + " (sig " + fmtNum(trend.macdSignal, 4) + ")");
        row(dl, "Trend · Bollinger(20,2)", fmtNum(trend.bollingerLower) + " / " + fmtNum(trend.bollingerMiddle) + " / " + fmtNum(trend.bollingerUpper));
        row(dl, "Trend · direction", trend.trendDirection);
        var mom = ind.momentum || {};
        row(dl, "Momentum · RSI(14)", fmtNum(mom.rsi14));
        row(dl, "Momentum · Stoch %K/%D", fmtNum(mom.stochasticK) + " / " + fmtNum(mom.stochasticD));
        row(dl, "Momentum · ATR(14)", fmtNum(mom.atr14));
        row(dl, "Momentum · ADX(14)", fmtNum(mom.adx14));
        row(dl, "Momentum · OBV", fmtNum(mom.obv, 0));
        var vol = ind.volatility || {};
        row(dl, "Volatility · regime", vol.regime);
        row(dl, "Volatility · HV(20)", fmtPct(vol.historicalVolatility20));
        row(dl, "Volatility · Keltner", fmtNum(vol.keltnerLower) + " / " + fmtNum(vol.keltnerMiddle) + " / " + fmtNum(vol.keltnerUpper));
        row(dl, "Volatility · Donchian", fmtNum(vol.donchianLower) + " / " + fmtNum(vol.donchianUpper));
        var st = ind.structure || {};
        row(dl, "Structure · support", fmtNum(st.support));
        row(dl, "Structure · resistance", fmtNum(st.resistance));
        row(dl, "Structure · breakout", st.breakout && st.breakout.ok ? st.breakout.direction + " @ " + fmtNum(st.breakout.level) : "none");
        row(dl, "Structure · swings", String(st.swingCount));
        note("indicators-note", d.note);
        return;
      }
      var f = failureState(result);
      setBadge("indicators-badge", f.state);
      note("indicators-note", f.message);
    }).catch(function (err) {
      setBadge("indicators-badge", "unavailable");
      note("indicators-note", err.message);
    }).finally(function () {
      setBusy("indicators-values", false);
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
        setBadge("portfolio-badge", d.state === "empty" ? "empty" : "ok",
          d.state === "empty" ? "EMPTY" : "OK");
        if (d.portfolio) {
          var p = d.portfolio;
          row(dl, "Equity", fmtNum(p.equity));
          row(dl, "Cash", fmtNum(p.cash));
          row(dl, "Gross exposure", fmtNum(p.grossExposure));
          row(dl, "Net exposure", fmtNum(p.netExposure));
          row(dl, "Daily P&L", fmtNum(p.dailyPnl));
          row(dl, "Drawdown", fmtPct(Number.isFinite(p.drawdown) ? p.drawdown * 100 : null));
          if (Array.isArray(p.positions) && p.positions.length > 0) {
            p.positions.forEach(function (pos) {
              var tr = el("tr");
              tr.appendChild(el("td", null, pos.symbol));
              tr.appendChild(el("td", null, fmtNum(pos.quantity, 6)));
              tr.appendChild(el("td", null, fmtNum(pos.markPrice)));
              tr.appendChild(el("td", null, fmtNum(pos.notional)));
              tbody.appendChild(tr);
            });
            wrap.hidden = false;
          }
        }
        if (d.limits) {
          row(dl, "Risk limits verdict", d.limits.ok ? "all limits respected" : "BLOCKED: " + (d.limits.reasons || []).join(", "));
        }
        row(dl, "Last update", fmtTime(d.updatedAt) + (Number.isFinite(d.ageMs) ? " (" + fmtAge(d.ageMs) + " ago)" : ""));
        note("portfolio-note", d.note);
        return;
      }
      var f = failureState(result);
      setBadge("portfolio-badge", f.state);
      note("portfolio-note", f.message);
    }).catch(function (err) {
      setBadge("portfolio-badge", "unavailable");
      note("portfolio-note", err.message);
    }).finally(function () {
      setBusy("portfolio-values", false);
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
          broken ? "INTEGRITY BROKEN" : (d.state === "empty" ? "EMPTY" : "VERIFIED"));
        row(dl, "Entries", String(d.total));
        row(dl, "Showing", String(d.returned));
        row(dl, "Hash chain", broken ? "DOES NOT VERIFY — treat history as untrusted" : "verified (verifyJournal)");
        row(dl, "Last update", fmtTime(d.updatedAt));
        (d.entries || []).forEach(function (record) {
          if (!record || typeof record !== "object") return;
          var summary = JSON.stringify(record.entry === undefined ? record : record.entry);
          if (summary.length > 220) summary = summary.slice(0, 220) + "…";
          var li = el("li", null, "#" + String(record.index) + " " + summary +
            (typeof record.hash === "string" ? " · h:" + record.hash.slice(0, 12) : ""));
          list.appendChild(li);
        });
        note("journal-note", d.note);
        return;
      }
      var f = failureState(result);
      setBadge("journal-badge", f.state);
      note("journal-note", f.message);
    }).catch(function (err) {
      setBadge("journal-badge", "unavailable");
      note("journal-note", err.message);
    }).finally(function () {
      setBusy("journal-values", false);
    });
  }

  function renderBacktest() {
    setBadge("backtest-badge", "loading");
    setBusy("backtest-values", true);
    var symbol = $("symbol-input").value.trim().toUpperCase();
    var interval = $("interval-input").value;
    var limit = $("limit-input").value;
    var path = "/api/backtest?symbol=" + encodeURIComponent(symbol) +
      "&interval=" + encodeURIComponent(interval) + "&limit=" + encodeURIComponent(limit) +
      "&strategy=sma-cross";
    return api(path).then(function (result) {
      var dl = $("backtest-values");
      clear(dl);
      var body = result.body;
      if (result.status === 200 && body && body.ok === true && body.data) {
        var d = body.data;
        var s = d.inSample || {};
        setBadge("backtest-badge", d.state === "stale" ? "stale" : "ok",
          d.state === "stale" ? "STALE · " + fmtAge(d.ageMs) : "OK");
        row(dl, "Strategy", d.strategy ? d.strategy.name : "—");
        row(dl, "Window", d.candleCount + " × " + d.interval + " (" + d.symbol + ")");
        row(dl, "Starting cash", fmtNum(d.startingCash));
        row(dl, "Final equity (in-sample)", fmtNum(s.equity));
        row(dl, "Return", fmtPct(Number.isFinite(s.returnPct) ? s.returnPct * 100 : null));
        row(dl, "Trades", String(s.trades));
        row(dl, "Fees / slippage", (d.parameters ? fmtNum(d.parameters.feeRate * 100) + "% / " + d.parameters.slippageBps + " bps" : "—"));
        row(dl, "Reproducible", d.reproducible ? "yes" : "no");
        note("backtest-note", d.note);
        return;
      }
      var f = failureState(result);
      setBadge("backtest-badge", f.state);
      note("backtest-note", f.message);
    }).catch(function (err) {
      setBadge("backtest-badge", "unavailable");
      note("backtest-note", err.message);
    }).finally(function () {
      setBusy("backtest-values", false);
    });
  }

  // ------------------------------------------------------------- controls

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
    return raw;
  }

  function refreshAll() {
    if (!readSymbol()) return Promise.resolve();
    $("live-status").textContent = "Refreshing…";
    var stamp = new Date().toLocaleTimeString();
    return Promise.all([
      renderHealth(), renderMarket(), renderIndicators(),
      renderPortfolio(), renderJournal(), renderBacktest()
    ]).then(function () {
      $("live-status").textContent = "Updated " + stamp + " · paper/shadow only — real money OFF.";
    });
  }

  function boot() {
    $("controls").addEventListener("submit", function (event) {
      event.preventDefault();
      refreshAll();
    });
    setInterval(function () {
      if (!document.hidden && $("auto-input").checked) refreshAll();
    }, AUTO_REFRESH_MS);
    refreshAll();
  }

  // Legacy seam kept for compatibility with the old static shell: sets values
  // by element id, via textContent only (safe by construction).
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
