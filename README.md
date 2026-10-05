# Trading Nova

Risk-first personal AI trading research, teaching, paper-execution and journaling workspace.

## Build status

Tasks 1–25 are implemented in the repository; Task 24 is merged and Task 25 adds the production PostgreSQL persistence boundary. Real backup/restore and crash-recovery drills still require an actual database service.

This repository is not a claim of live-money production readiness. The current system is paper/shadow-first. Real-money execution remains disabled until the roadmap Phase 9 requirements are independently evidenced and explicitly human-approved.

## Safety architecture

WORLD DATA → DATA QUALITY / SOURCE TRUST → MARKET REGIME → RESEARCH / AI COUNCIL → EVIDENCE → STATISTICAL VALIDATION → STRATEGY / SIGNAL → PORTFOLIO → DETERMINISTIC RISK GATE → PAPER / SHADOW → RECONCILIATION → JOURNAL / LEARNING → REVALIDATION / PROMOTION.

Golden rule: AI can discover an opportunity. Statistics can validate it. Portfolio logic can size it. Only the deterministic Risk Gate can permit an order.

## Completed foundations

- Tasks 1–10: contracts, portfolio/risk, paper execution, reconciliation, journal, backtest, opportunity scoring, lifecycle, reliability and regime foundations.
- Tasks 11–20: durability boundary, human-approved risk config, recovery checkpoints, public market-data connector, PostgreSQL adapter contract, statistical validation, strategy/evidence/opportunity/loss-learning foundations, dashboard/observability/capacity foundations.
- Tasks 21–23: reality-gap/shadow analysis, stress/common-mode controls, capacity admission, material-change governance, operator authorization and independent safety controls.
- Task 24: final audit, regression, recovery, safety-boundary and release-gate verification.

## Current hard limits

- No exchange/broker credentials.
- No autonomous live-money execution.
- No withdrawal/transfer capability.
- AI cannot modify risk limits, enable live mode, or remove safety controls.
- PostgreSQL is currently an adapter contract/foundation; production deployment still requires a real database driver, migrations, credentials and restore drill.
- Market-data integration is public-data research infrastructure, not a promise of exchange-grade execution or uptime.

See docs/TRADING-NOVA-MASTER-ROADMAP.md for the authoritative architecture and promotion sequence.