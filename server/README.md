# server/ — Trading-Nova local web API (WS-D)

Thin, **localhost-only** (127.0.0.1) HTTP layer for the personal dashboard.
`node:http` only — no framework, no new dependencies. **Read-only. Paper/shadow
only — real money OFF.** No action through this API can place a real order.

```bash
npm run serve                 # http://127.0.0.1:7411/  (NOVA_PORT or PORT overrides; 0 = ephemeral)
```

## Endpoints (GET only, JSON)

| Route | Real engine source | Notes |
|---|---|---|
| `GET /api/health` | `src/observability/health.js` | honest `ok`/`degraded`; mode + wiring state |
| `GET /api/market/:symbol` | `src/market-data/providers/crypto.js` | real ticker; `stale` / `unavailable` honesty |
| `GET /api/indicators/:symbol?interval&limit` | `src/indicators/*` over real candles | `null` = not computable, never a guess |
| `GET /api/portfolio` | `src/risk/portfolio.js`, `src/risk/limits.js` | paper state snapshot, read-only |
| `GET /api/journal` | `src/journal/journal.js` (`verifyJournal`) | hash-chain integrity surfaced honestly |
| `GET /api/backtest?symbol&interval&limit&strategy` | `src/backtest/engine-v2.js` | history summary; not a prediction |
| `POST /api/paper/orders` | — | **STUB → 501** until Risk Gate enforcement (WS-A) lands |

Static dashboard: `web/index.html` (+ `app.js`, `style.css`) at `/`;
`/ui/dashboard.html` is an alias of the same page.

## Response envelope

- success: `{"ok": true, "data": {...}}` — `data.state` ∈ `ok` | `stale` | `empty`
- failure: `{"ok": false, "state": "error" | "unavailable" | "not-implemented", "error": {code, message, reason?}}`
- `stale` = cached value served past its freshness window (clearly marked + aged)
- `unavailable` = HTTP 503, upstream/state genuinely cannot provide data
- errors are generic: no stacks, no paths, no environment values on the wire

## Input validation

Symbols (`[A-Z0-9]{2,24}`), intervals, limits and strategies are whitelisted in
`server/validate.js` before touching any engine code. Static files are served
from a fixed whitelist (`server/static.js`) — traversal is structurally impossible.

## Paper-state snapshot contract (read-only here)

`server/state.js` optionally reads `db/paper-state.json` by default (a different
path can be passed as the `stateFile` option to `createNovaServer`). The
snapshot is written later by the paper-execution path (WS-A / milestone M3):

```json
{
  "version": 1,
  "updatedAt": 1700000000000,
  "portfolio": {"cash": 10000, "startingEquity": 10000,
                "positions": [{"symbol": "BTCUSDT", "quantity": 0.1, "markPrice": 42000}]},
  "limits": {
    "daily":   {"realizedPnl": 0, "startingEquity": 10000, "dailyLossLimitPct": 2},
    "weekly":  {"realizedPnl": 0, "startingEquity": 10000, "weeklyLossLimitPct": 5},
    "drawdown": {"peakEquity": 10000, "currentEquity": 10000, "maxDrawdownPct": 10}
  },
  "journal": [{"index": 0, "previousHash": "GENESIS", "entry": {}, "hash": "…"}]
}
```

No snapshot → honest `empty` state (there is genuinely no paper state yet).
Corrupt snapshot → `500 error` state, never "assumed fine".

## Security posture

- loopback bind only (set in `server/index.js`)
- strict CSP (`default-src 'none'; script-src 'self'; style-src 'self'; …`),
  `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, `Cache-Control: no-store` on API
- dashboard renders exclusively via DOM APIs (`textContent`) — untrusted upstream
  text can never become markup (regression-tested in `tests/ws-d-ui.test.js`)
- responses are scanned for secrets in `tests/ws-d-server.test.js`

## Order submission (future — NOT wired)

`POST /api/paper/orders` will land **only** together with Risk Gate enforcement:
`contracts.validateOrder` → `risk/gate.evaluateRiskGate` (fail-closed, ALLOW
artifact with order hash + config hash) → `execution/paper-persistent`
(mandatory idempotency key) → reconciliation. Paper/shadow tiers only.
