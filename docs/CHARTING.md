# Trading Nova charting dependency

- **Library:** TradingView Lightweight Charts **4.2.3**, pinned exactly in `package.json` and `package-lock.json`.
- **License:** Apache-2.0. The upstream LICENSE and NOTICE are retained under `licenses/lightweight-charts-4.2.3/`.
- **Local/offline asset:** npm install runs `scripts/copy-chart-asset.js`, which copies the exact standalone production bundle to the ignored `web/vendor/` path. The fixed static route `/vendor/lightweight-charts.js` serves only that file. No CDN or browser-time dependency fetch is used.
- **Rebuild the asset:** run `npm run charts:vendor` after a clean install or when deliberately upgrading the pinned version.
- **Attribution:** the chart enables the upstream attribution logo and the dashboard links to TradingView. Keep both the upstream NOTICE and the visible link if upgrading or changing the chart renderer.
- **Data honesty:** chart candlesticks and volume come from the normalized API OHLCV payload. SMA20/SMA50 are computed only from those displayed candle closes. Invalid or duplicate timestamps fail closed; network/API errors clear the last chart so an old chart is not misrepresented as fresh.
- **Controls:** wheel/pinch/drag zoom, crosshair, time/price scales, SMA20/SMA50 toggles, volume toggle, and Fit view are supported by the local library.
- **Not implemented by this step:** WebSocket candle streaming, user-saved drawing tools, price alerts, or any live-money execution. Paper/shadow mode remains mandatory.

Upstream: https://github.com/tradingview/lightweight-charts
Documentation: https://tradingview.github.io/lightweight-charts/docs/4.2/
