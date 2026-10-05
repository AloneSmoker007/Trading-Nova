# Trading Nova — Current Execution Task

Authoritative roadmap: [docs/TRADING-NOVA-MASTER-ROADMAP.md](docs/TRADING-NOVA-MASTER-ROADMAP.md).

## Task 3 — Phase 2: Portfolio State + Deterministic Risk Gate
- [x] Portfolio state / positions / exposure
- [x] Max position, gross exposure, daily loss, drawdown, leverage and concentration checks
- [x] Stale-data stop and emergency kill switch
- [x] Versioned/hash-bound risk configuration
- [x] Fail-closed deterministic decision
- [x] Defense-in-depth via independent validation and execution/reconciliation boundaries

## Task 4 — Phase 3: Paper Execution
- [x] Deterministic paper execution
- [x] No exchange SDK / no live-money path

## Task 5 — Phase 4: Reconciliation + Journal + Memory foundation
- [x] Reconciliation contract
- [x] Hash-chained append-only journal
- [x] Thesis/evidence ordering remains before order eligibility

## Task 6 — Phase 5: Backtesting + Statistical Validation foundation
- [x] Deterministic replay/backtest primitive
- [x] Calibrated probability is unavailable until minimum sample threshold
- [x] Score and probability remain separate

## Task 7 — Phase 6: AI Research Brain foundation
- [x] Evidence-aware opportunity scoring
- [x] Uncertainty and WAIT are first-class

## Task 8 — Phase 7: Lifecycle/Governance/Validation
- [x] Strategy lifecycle and certificate-gated promotion
- [x] Explicit promotion states

## Task 9 — Phase 8: Reliability/Reality-gap foundation
- [x] Circuit breaker
- [x] Reconciliation boundary

## Task 10 — Phase 10: Advanced Intelligence foundation
- [x] Deterministic market-regime classifier

## Acceptance
- [x] Tests cover success and failure paths
- [x] No live execution path
- [x] No exchange SDK
- [x] Safety controls remain deterministic and human-configurable
- [x] CI-compatible Node-only implementation

## Next
Deepening tasks: production-grade persistence, real market connectors, richer backtesting/statistical validation, AI model integration, UI, observability, and human-controlled promotion gates.