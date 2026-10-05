# Trading-Nova — Phases 11–14

## Phase 11 — Production Validation
Requires real external evidence for PostgreSQL, backup/restore, production market data, venue conformance, paper/shadow evidence, observability, and explicit human approval.

Code gates cannot manufacture that evidence.

## Phase 12 — Controlled Live
Requires Phase 11 certification, testnet evidence, capped limited-live sizing, reconciliation, rollback/disable capability, and human approval. No autonomous live enablement.

## Phase 13 — Advanced AI
Requires calibrated evaluation, challenger/shadow validation, revalidation, drift controls, and an immutable deterministic Risk Gate. AI may research and recommend, but cannot weaken safety controls.

## Phase 14 — Scale
Requires high-availability evidence, disaster recovery, capacity evidence, security audit, and production observability.

## Final rule
Passing automated tests is not equivalent to production certification. Unknown execution, stale critical data, broken protection, unresolved reconciliation, or security emergency remains STOP / NO-TRADE.

## External verification
PostgreSQL backup integrity verification must be followed by an actual test restore and data verification; pg_verifybackup alone is not sufficient.

For authenticated Binance execution, order state and user-data streams must be tested against the exact venue and market used.
