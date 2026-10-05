# Trading Nova — Current Execution Task

Authoritative roadmap: [docs/TRADING-NOVA-MASTER-ROADMAP.md](docs/TRADING-NOVA-MASTER-ROADMAP.md).

## Task 2 — Phase 1: Market Data & Truth Layer

- [x] Market-data canonical schemas
- [x] Source identity and trust score
- [x] Freshness/staleness checks
- [x] OHLC/quote validation
- [x] Gap detection
- [x] Data Quality Gate
- [x] Point-in-time/as-of replay primitive
- [x] Success/failure tests
- [x] No execution/exchange SDK introduced

### Acceptance
- [x] Invalid market data is rejected
- [x] Stale/gapped/untrusted data cannot pass the quality gate
- [x] As-of snapshots are deterministic
- [x] CI remains green
- [x] No live execution path

## Next
Task 3 — Phase 2: Portfolio State + Deterministic Risk Gate.
