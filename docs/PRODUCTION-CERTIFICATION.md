# Production Certification

This is the evidence gate between code completion and any real-money promotion.

## Required evidence
- Database: real PostgreSQL deployment and transactional verification.
- Market data: production freshness, sequence/gap handling, and stop conditions.
- Risk Gate: approved, versioned, hashed, fail-closed configuration.
- Backup: integrity check, isolated restore, and restored-data verification.
- Rollback: tested checkpoint/rollback path.
- Observability: actionable monitoring for readiness, errors, risk blocks, reconciliation failures, and critical security events.
- Reconciliation: non-paper execution fully reconciled; unknown execution is STOP.

## Backup rule
A backup integrity check is not sufficient by itself. PostgreSQL documents that pg_verifybackup checks a base backup against its manifest, while also recommending test restores and verification of the resulting database.

## Venue rule
A live-capable venue must pass the adapter conformance contract and demonstrate order status, fills, cancellation, and authenticated user-data monitoring. Binance Spot currently exposes signed order-status, order-history, open-order, and trade-history operations and recommends user-data streams for continuous order monitoring.

## Promotion rule
No tier may be skipped. Every promotion requires validation evidence, independent safety evidence, rollback evidence, and human approval. limited-live/live also require venue conformance.

AI cannot approve its own promotion, change the Risk Gate, increase leverage, or remove safety controls.

## Certification status
These modules make the repository evidence-ready. They do not claim that production infrastructure, backup/restore drills, or exchange conformance have actually been executed. No exchange credentials are added by this task.
