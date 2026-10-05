# Trading Nova

Risk-first personal AI trading research, teaching, paper-execution and journaling workspace.

## Build status
Tasks 1–11 core foundations are implemented. This is **not** a claim of production live-trading readiness. Live money remains disabled until explicit promotion, reconciliation, security and human-approval requirements are satisfied.

## Safety architecture
WORLD DATA → DATA QUALITY → REGIME → RESEARCH/AI → EVIDENCE → STATISTICAL VALIDATION → STRATEGY/SIGNAL → PORTFOLIO → RISK LIMITS → DETERMINISTIC RISK GATE → PAPER/SHADOW → RECONCILIATION → JOURNAL/LEARNING → REVALIDATION.

Task 11 adds an integrity-checked persistence boundary, idempotency, human-approved risk-config records, a reconciliation state machine, and recovery checkpoints.

## Current limits
No exchange SDK, broker credentials, autonomous live execution, leverage escalation, or AI write access to safety controls is included.