# Trading Nova — Current Execution Task

Authoritative roadmap: docs/TRADING-NOVA-MASTER-ROADMAP.md.

## Tasks 1–23
Complete and merged.

## Task 24 — Final Production Audit / Release Gate

Completed and merged. CI is green. Paper/shadow foundation certified only; live-money remains blocked.

## Task 25 — PostgreSQL Production Persistence

- [x] Transactional PostgreSQL adapter
- [x] Durable state and idempotency tables
- [x] Append-only hash-chained audit table
- [x] Risk-config/checkpoint persistence tables
- [x] Checksum-verified migration runner
- [x] PostgreSQL driver dependency/factory
- [x] CI-safe injected-pool regression tests
- [ ] Real deployment backup/restore drill
- [ ] Crash-recovery drill against a real PostgreSQL service

See docs/TASK-25-POSTGRES.md.


- [ ] Security boundary audit
- [ ] Full regression: tests, syntax/lint and secret scan
- [ ] Failure/recovery and journal-integrity verification
- [ ] Risk-config approval/hash verification
- [ ] Paper idempotency and invalid-order rejection verification
- [ ] Market-data validation/resilience verification
- [ ] Capacity/stress and common-mode fail-closed verification
- [ ] Deployment/readiness review
- [ ] PostgreSQL production-gap disclosure
- [ ] Human-controlled live-readiness review

### Release rule

Task 24 can certify the paper/shadow foundation only if CI is green and no critical/high safety blocker remains.

It must not certify live-money readiness merely because tests pass. Live promotion remains blocked until the roadmap Phase 9 evidence exists: real persistence, reconciliation, venue conformance, promotion certificate, independent validation, explicit human approval, capped limited-live controls, rollback/disable path and operational restore evidence.

## Tasks 26–34 — Production Completion Layer

Implemented in this branch:
- [x] 26 Market-data stream supervision/source health
- [x] 27 Persistent paper execution boundary
- [x] 28 AI research brain/evidence/counter-evidence
- [x] 29 Backtesting 2.0 with costs and OOS validation
- [x] 30 Shadow execution boundary
- [x] 31 Safety-first dashboard shell
- [x] 32 Security/operations primitives
- [x] 33 Venue conformance contract
- [x] 34 Controlled promotion/disable controls

External operational evidence remains required before any live-money promotion: real database deployment and restore drill, real venue conformance, production monitoring/alerts, and explicit human approval.
