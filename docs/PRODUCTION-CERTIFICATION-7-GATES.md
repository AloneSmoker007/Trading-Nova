# Production Certification — Seven Gates

1. PostgreSQL deployment: production environment contract and transactional verification.
2. Backup/restore: create, verify, isolated restore, and application-level data verification.
3. Market data: connectivity, freshness, sequence health, gap recovery, and latency.
4. Venue conformance: submit/status/cancel/fills/user-data and reconnect scenarios.
5. Paper/shadow evidence: explicit evidence is required before promotion.
6. Observability: readiness, risk blocks, reconciliation, unknown execution, stale data, security, and backup failures.
7. Promotion: final certification requires human approval; existing sequential promotion rules remain.

These are code-level gates. They do not falsely claim that external infrastructure has already been operated. No exchange credentials are stored or enabled.
