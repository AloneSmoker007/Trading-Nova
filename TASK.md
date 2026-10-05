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

## Tasks 26–34 — Production Completion Layer
Implemented and merged. External operational evidence remains required before live-money promotion.

## Phase 10 — Advanced Intelligence
Code foundation complete and merged. Advanced intelligence cannot bypass deterministic Risk Gate or safety controls.

## Phases 11–14 — Production Certification Gates
Code-level gates implemented and merged. Real infrastructure evidence, venue testing, observability deployment, paper/shadow evidence and explicit human approval remain external requirements.

## Phases 15–20 — Scale, Resilience, Security & Governance
Code foundation implemented on this branch:
- [x] Phase 15 — High availability admission/failover gate
- [x] Phase 16 — Disaster recovery/restore/replay gate
- [x] Phase 17 — Security assurance gate
- [x] Phase 18 — Cost/performance/capacity gate
- [x] Phase 19 — Data expansion quality/bias gate
- [x] Phase 20 — Institutional governance/independent validation gate

These gates fail closed and do not manufacture external evidence. Live money remains blocked until real operational evidence and human approval exist.

See docs/PHASES-15-20-SCALE-GOVERNANCE.md.


## V1 — Release Certification
The V1 code layer is complete. See docs/V1-RELEASE-CERTIFICATION.md.

Current V1 blockers are external evidence only: real PostgreSQL deployment/restore, measured RTO/RPO, production market-data soak, observability/alerts, independent security evidence, capacity evidence, and sustained paper/shadow evidence. Until those are recorded, V1 is NOT CERTIFIED and real-money trading remains blocked.


## Current Task — V1 External Evidence Preparation

Code-layer V1 is merged. The next work is evidence collection, not live-money enablement.

- [x] External-evidence runbook added: `docs/V1-EXTERNAL-EVIDENCE-RUNBOOK.md`
- [x] Capability/research traceability framework added: `docs/V1-CAPABILITY-TRACEABILITY.md`
- [ ] Real PostgreSQL deployment and recovery evidence
- [ ] Backup/restore + measured RTO/RPO
- [ ] Production market-data soak/reconnect/gap evidence
- [ ] Production observability and alert evidence
- [ ] Independent security evidence
- [ ] Capacity/load evidence
- [ ] Sustained paper/shadow evidence
- [ ] Historical 1,900+ raw research list recovered/mapped
- [ ] Human V1 release approval

**Safety:** real-money trading remains blocked. Do not record simulated/mocked results as production evidence.
