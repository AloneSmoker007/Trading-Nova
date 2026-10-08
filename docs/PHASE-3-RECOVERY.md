# Phase 3 — Recovery & Backup

## Certification scope
- Create a PostgreSQL custom-format backup without embedding credentials.
- Hash the backup artifact and verify it before restore.
- Restore into a separate PostgreSQL database.
- Verify database health, migration state, durable sentinel state, and the audit hash chain after restore.
- Keep production/live-money execution out of the drill.

## Safety
The drill never targets a production database in CI. CI uses an ephemeral PostgreSQL service and a separate restore database. Operational restores are intentionally not automated against the configured Neon database.

## RTO/RPO evidence
The CI drill proves functional recoverability. It does not claim a numeric RTO/RPO because no production-sized backup/restore timing baseline has been established yet.