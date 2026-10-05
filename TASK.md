# Trading Nova — Current Execution Task

The authoritative roadmap is **[docs/TRADING-NOVA-MASTER-ROADMAP.md](docs/TRADING-NOVA-MASTER-ROADMAP.md)**.

## Task 1 — Phase 0A + Phase 0B: Foundation & Architecture Contracts

Goal: establish a reproducible, testable and security-conscious foundation before market data, strategies, execution or AI are added.

### Phase 0A
- [x] Node ESM package scaffold
- [x] Safe .gitignore and .env.example
- [x] Validated runtime configuration
- [x] Structured JSON logging
- [x] Secret-scanning baseline
- [x] CI for tests, syntax/lint and secret scan

### Phase 0B
- [x] Strategy/Signal contract
- [x] Thesis/Evidence contract
- [x] Portfolio State contract
- [x] Versioned Risk Configuration contract
- [x] Execution/Order contract
- [x] Reconciliation contract
- [x] Execution-tier enum and paper-first defaults

### Acceptance
- [x] Reproducible Node foundation
- [x] Success and failure boundaries have tests
- [x] No live trading path exists
- [x] No exchange SDK exists
- [x] Default mode is paper
- [x] CI definition exists
- [x] No secrets intentionally committed

## Next
Task 2 — Phase 1: Market Data & Truth Layer.

Do not implement live trading, broad AI, or advanced intelligence before the roadmap gates allow them.
