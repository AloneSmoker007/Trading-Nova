# V1 External Evidence Runbook

**Status:** Runbook only — no evidence is fabricated here.

V1 code-layer gates are merged. V1 certification still requires real operational evidence. Every item below must be backed by an artifact, timestamp, environment, operator, and reproducible result before it can be marked PASS.

## 1. PostgreSQL production evidence
- [ ] Hosted PostgreSQL instance identified and access controlled.
- [ ] Canonical migrations applied from a clean database.
- [ ] Migration checksums recorded.
- [ ] Persistence/idempotency/audit tests executed against the real service.
- [ ] Crash/restart recovery drill completed.
- [ ] Evidence artifact stored with database version, migration versions and result.

## 2. Backup / restore / RTO / RPO
- [ ] Production backup created.
- [ ] Backup integrity verified.
- [ ] Restore performed into an isolated environment.
- [ ] Critical rows/state verified after restore.
- [ ] Recovery replay verified.
- [ ] RTO measured from incident start to service-ready.
- [ ] RPO measured as maximum confirmed data loss window.
- [ ] Evidence includes commands/results; secrets must be redacted.

## 3. Production market-data soak
- [ ] Public market-data source connected.
- [ ] Freshness continuously measured.
- [ ] Sequence/order health observed.
- [ ] Reconnect exercised.
- [ ] Gap detection and recovery exercised.
- [ ] Latency distribution recorded (p50/p95/p99).
- [ ] Stale/corrupt critical data caused deterministic NO-TRADE.
- [ ] Soak duration and failure-injection results recorded.

## 4. Observability
- [ ] Structured logs retained.
- [ ] Metrics retained.
- [ ] Alerts verified for READINESS_FAILURE, RISK_BLOCK, RECONCILIATION_FAILURE, UNKNOWN_EXECUTION, MARKET_DATA_STALE, SECURITY_EVENT and BACKUP_FAILURE.
- [ ] Alert routing tested end-to-end.
- [ ] No secrets/credentials appear in telemetry.

## 5. Security assurance
- [ ] Dependency audit evidence.
- [ ] Secret-scan evidence.
- [ ] Authentication/authorization review where applicable.
- [ ] Threat model reviewed.
- [ ] Independent security testing completed.
- [ ] Findings classified with explicit remediation/acceptance.
- [ ] No unresolved critical/high blocker.

## 6. Capacity / performance
- [ ] Representative workload defined.
- [ ] Peak event/request rate measured.
- [ ] p95/p99 latency measured.
- [ ] Error rate measured.
- [ ] Memory/CPU/DB utilization measured.
- [ ] Capacity headroom recorded.
- [ ] Backpressure/failure behavior tested.
- [ ] Cost against the V1 operating budget recorded.

## 7. Paper / shadow certification
- [ ] Realistic paper workload executed for a sustained period.
- [ ] Shadow observations captured.
- [ ] Paper-vs-observed price/quantity/fee/latency comparison recorded.
- [ ] Unknown executions = 0 for certification window.
- [ ] Reconciliation mismatches = 0 or explicitly investigated/resolved.
- [ ] Reality-gap metrics recorded.
- [ ] Loss/mistake journal entries are reconstructable.

## 8. Final V1 release approval
Required before the V1 certificate:
- [ ] All code gates green.
- [ ] All external evidence above complete.
- [ ] Master capability traceability reviewed.
- [ ] Raw research requirements traceability reviewed.
- [ ] No unresolved critical/high blocker.
- [ ] Human release approval recorded.
- [ ] Real-money trading remains OFF unless separately certified through the V2 promotion chain.

## Evidence record format

`ID | Environment | Date/time | Operator | Artifact | Result | Notes`

Never record API keys, passwords, private keys, exchange secrets or other credentials in evidence artifacts.

## Certification rule

**No artifact = no PASS.**

A green unit test, simulated drill or mocked integration is not evidence of production operation.