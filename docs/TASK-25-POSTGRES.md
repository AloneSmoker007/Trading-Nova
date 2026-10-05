# Task 25 — PostgreSQL Production Persistence

## Scope
Replace the in-memory durability boundary with a production PostgreSQL adapter while keeping the domain code provider-neutral.

Implemented:
- transactional PostgreSQL store with commit/rollback
- durable key/value state
- database-backed idempotency
- append-only hash-chained audit records
- risk-config/checkpoint tables
- ordered, checksum-verified migrations
- PostgreSQL driver dependency and `POSTGRES_URL` factory
- health probe
- regression tests with an injected pool; no external database is required for CI

## Safety
- The adapter never enables live trading.
- Idempotent operations are locked inside a database transaction.
- Migration checksums prevent silent migration drift.
- Audit verification fails closed on hash-chain corruption.
- Production use requires a real PostgreSQL instance and an exercised backup/restore procedure.

## Deployment
Set `POSTGRES_URL`, then run `npm run db:migrate`.
A real production deployment must also complete backup, restore and crash-recovery drills before live promotion.
