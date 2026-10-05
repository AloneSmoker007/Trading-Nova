# Trading Nova

Risk-first personal AI trading research, teaching, paper-execution and journaling workspace.

## Build status
Tasks 1–10 core foundation are implemented in the current build. This is **not** a claim of production live-trading readiness. Live money remains disabled until the explicit promotion, reconciliation, security and human-approval requirements are satisfied.

## Safety architecture
WORLD DATA → DATA QUALITY → REGIME → RESEARCH/AI → EVIDENCE → STATISTICAL VALIDATION → STRATEGY/SIGNAL → PORTFOLIO → RISK LIMITS → DETERMINISTIC RISK GATE → PAPER/SHADOW → RECONCILIATION → JOURNAL/LEARNING → REVALIDATION.

The Risk Gate fails closed on invalid portfolio state, stale critical data, emergency kill switch, invalid or changed risk configuration, and configured exposure/loss limits.

## Core modules
- Market data truth/quality and point-in-time replay
- Portfolio state and deterministic risk gate
- Paper execution and reconciliation
- Hash-chained journal
- Deterministic backtesting
- Evidence-aware opportunity scoring and calibrated-probability guard
- Strategy lifecycle/promotion certificate
- Circuit breaker
- Basic market-regime classification

## Current limits
No exchange SDK, broker credentials, autonomous live execution, leverage escalation, or AI write access to safety controls is included in this core build.

Authoritative roadmap: [docs/TRADING-NOVA-MASTER-ROADMAP.md](docs/TRADING-NOVA-MASTER-ROADMAP.md).
