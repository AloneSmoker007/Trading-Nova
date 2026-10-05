# Trading Nova V1 — Release & Evidence Checklist

## V1 definition
V1 is a production-quality paper/shadow trading research workspace. V1 does not include real-money execution. V2 starts only after V1 evidence is certified.

## Code gates
- [x] Node >=20 / ESM foundation
- [x] secure configuration and secret scanning
- [x] real ESLint quality gate
- [x] CI PostgreSQL 16 service
- [x] canonical PostgreSQL migration runner
- [x] PostgreSQL transaction/rollback/idempotency/audit integration tests
- [x] market-data validation, freshness, source trust and sequence/gap controls
- [x] deterministic Risk Gate
- [x] explicit reduce-only semantics
- [x] kill-switch and loss-limit protection
- [x] durable paper execution
- [x] reconciliation state machine
- [x] append-only journal
- [x] backtest V2 with fees/slippage and out-of-sample path
- [x] opportunity score separated from calibrated probability
- [x] AI research council and uncertainty/abstention controls
- [x] shadow/reality-gap primitives
- [x] capacity/stress admission primitives
- [x] material-change/revalidation gates
- [x] safety-first dashboard shell
- [x] production readiness/certification gates

## External evidence gates — not yet certified
- [ ] production PostgreSQL deployment
- [ ] real backup + isolated restore + data verification
- [ ] measured RTO/RPO
- [ ] production market-data soak/reconnect/gap evidence
- [ ] production observability and alert delivery
- [ ] independent security/threat-model evidence
- [ ] capacity/load evidence
- [ ] realistic paper/shadow run
- [ ] paper/shadow reconciliation evidence
- [ ] final human V1 release approval

## V1 safety boundary
Until every external evidence gate above is complete:
- real-money trading remains OFF
- exchange credentials are not required
- no autonomous live promotion is permitted
- Risk Gate remains deterministic and immutable by AI

## V1 exit certificate
V1 may be marked CERTIFIED only when all code gates are green, all external evidence gates are present, no unresolved critical/high blocker exists, and a human release approval is recorded.

A passing unit test is not treated as production evidence.