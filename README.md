# Trading Nova

Risk-first personal AI trading research, teaching, paper-execution and journaling workspace.

## Build status

Tasks 1–34 production code foundations are implemented; Tasks 24 and 25 are merged and the 26–34 completion layer is ready for CI review. External operational evidence is still required before live-money promotion.

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

## Tasks 26–34
See docs/TASKS-26-34.md. The repository now contains the production-facing market-data supervision, persistent paper boundary, research brain, backtesting v2, shadow runner, dashboard shell, security/operations controls, venue conformance contract and controlled promotion gate.

**Important:** code completion is not the same as live-money certification. No exchange credentials or autonomous live execution were added.


## Phase 10 — Advanced Intelligence
The code foundation now supports multi-agent research, microstructure, derivatives, cross-asset intelligence, external evidence, constrained optimization, input representativeness, probability calibration, revalidation and reconstructable research traces.

These intelligence layers can improve research but **cannot bypass the deterministic Risk Gate**. External provider deployments and production data subscriptions remain separate operational concerns.
