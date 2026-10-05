# Trading Nova — Current Execution Task

Authoritative roadmap: docs/TRADING-NOVA-MASTER-ROADMAP.md.

## Tasks 1–23
Complete and merged.

## Task 24 — Final Production Audit / Release Gate

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