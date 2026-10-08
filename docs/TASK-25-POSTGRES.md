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
- runtime wiring for paper-order persistence through `POSTGRES_URL`
- regression tests with an injected pool; no external database is required for CI
- dedicated Neon GitHub Actions integration job using the `POSTGRES_URL` repository secret

## Safety
- The adapter never enables live trading.
- Idempotent operations are locked inside a database transaction.
- Migration checksums prevent silent migration drift.
- Audit verification fails closed on hash-chain corruption.
- Production use requires a real PostgreSQL instance and an exercised backup/restore procedure.

## Deployment
Set `POSTGRES_URL`, then run `npm run db:migrate` before `npm run serve`. When
`POSTGRES_URL` is set, the server checks database connectivity and required
migrations before listening; startup fails closed and never falls back to local
files. Without it, the existing local-file mode remains available.
A real production deployment must also complete backup, restore and crash-recovery drills before live promotion.

## Neon CI

Configure a GitHub Actions repository secret named `POSTGRES_URL` with a Neon
connection string reserved for CI use. The dedicated job creates a unique
per-run schema, applies migrations and runs the real PostgreSQL integration
suite there, verifies PostgreSQL-backed server startup/health, then removes
only that schema. The normal PostgreSQL-service CI job does not depend on this
secret. Integration writes are isolated by schema; the account needs permission
to create and remove the run-specific schema.
