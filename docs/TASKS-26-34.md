# Tasks 26–34 — Production Completion Layer

These tasks add the production-facing application boundaries without pretending that external infrastructure has been deployed.

## 26 Market Data
- sequence-aware stream supervisor
- stale-data trade gate
- reconnect backoff
- source health/trust assessment
- existing Binance public connector remains credential-free

## 27 Persistent Paper Trading
- PostgreSQL-backed idempotent paper fills
- reconciled fill state
- durable order result boundary

## 28 AI Research Brain
- evidence council integration
- counter-evidence extraction
- opportunity score kept separate from probability
- probability remains unavailable until sample/calibration requirements are met
- Roman Urdu explanation primitive

## 29 Backtesting 2.0
- transaction fees and slippage
- in-sample/out-of-sample split
- sensitivity grid
- deterministic/reproducible output
- OOS validation gate

## 30 Shadow Trading
- paper-vs-observed comparison boundary
- unknown/unreconciled observations block promotion

## 31 Production UI
- safety-first dashboard shell in `web/index.html`
- market/opportunity/risk/execution state surfaces
- no UI action can enable live trading

## 32 Security & Operations
- token bucket rate limiting
- secret redaction
- readiness gate requiring database, market, risk, backup and rollback controls
- audit-event primitive

## 33 Venue Conformance
- explicit required adapter surface: submit/status/cancel/fills/user-data stream
- missing capability prevents conformance

## 34 Controlled Promotion
- sequential promotion only
- certificate + validation + independent safety + rollback + human approval
- venue conformance required for limited-live/live
- emergency disable primitive

## Remaining external evidence
The code cannot honestly claim completion of external operational evidence without an actual PostgreSQL service, backup/restore drill, venue account, signed API conformance tests, monitoring/alerting deployment, and human approval. Live-money execution remains disabled.
