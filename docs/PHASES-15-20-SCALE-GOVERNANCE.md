# Trading Nova — Phases 15–20

## Phase 15 — High Availability
Adds a fail-closed admission gate for primary/replica readiness, tested failover, and explicit RTO/RPO targets.

## Phase 16 — Disaster Recovery
Requires verified backup, isolated restore, recovery replay, rollback verification, and an incident plan. A backup artifact alone is not recovery evidence.

## Phase 17 — Security Assurance
Requires dependency audit, secret scanning, authorization review, threat model, and independent penetration/security testing before certification.

## Phase 18 — Cost & Performance
Requires bounded p95 latency, error rate, monthly operating cost, and positive capacity headroom. A performance or cost breach blocks promotion.

## Phase 19 — Data Expansion
Requires coverage, freshness, source trust, point-in-time correctness, and bias checks before new alternative/institutional data can influence research.

## Phase 20 — Institutional Governance
Requires separation of duties, full automated-activity reconstruction, model inventory, change control, independent validation, and certificate expiry/revalidation.

These phases add code-level admission controls only. They do not fabricate cloud deployment, security-testing, recovery, venue, or human-approval evidence. Live money remains blocked until the complete promotion chain has real operational evidence.
