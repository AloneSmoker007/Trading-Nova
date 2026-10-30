# Task 25 — PostgreSQL Backup/Restore & Crash-Recovery Drill Evidence

**Date:** 2026-10-30
**Environment:** local drill host (Debian 13, PostgreSQL 17.11), isolated databases `nova_source` / `nova_restore` / `nova_ci`
**Operator:** Shogo agent session
**Status:** drill PASSED — **not** a production certification artifact. Production rerun with the real deployment, real backup window and measured RTO/RPO is still required (see `docs/V1-EXTERNAL-EVIDENCE-RUNBOOK.md` §1–§2).

## Environment

| Item | Value |
| --- | --- |
| Server version | PostgreSQL 17.11 (Debian 17.11-0+deb13u1) |
| Canonical migrations applied from clean DB | `001_initial.sql`, `002_constraints.sql` (legacy `001_core.sql` ignored by design) |
| Migration run result | `{"ok":true,"migrations":2,...}` via `npm run db:migrate` |

## 1. Backup / restore drill — `npm run recovery:drill`

```
node scripts/seed-recovery-drill.js      # writes sentinel state + audit entry
node scripts/backup-restore-drill.js     # pg_dump -> manifest hash -> pg_restore -> verify -> measure RTO/RPO -> emit evidence
{"passed":false,"result":"BLOCKED","artifactSha256":"15e5e3ce…","restoreVerified":true,"rtoMs":78,"rpoMs":89,"environment":"local","evidence":"evidence/backup-restore-rto-rpo.json"}
```

Verified after restore into the isolated database: health probe, hash-chained
audit verification, migration state present, sentinel state row present.

### Measured RTO / RPO

The drill now measures both numbers itself instead of leaving them to hand
timing, and writes them to `evidence/backup-restore-rto-rpo.json`
(`EVIDENCE_OUT` overrides the path) in the `evidence-schema.js` record shape.

- **RTO** — `restore` phase (create target DB + `pg_restore`) plus `verify`
  phase (health, audit chain, migration state, sentinel), measured from the
  first restore step to service-ready. Per-phase durations are recorded.
- **RPO** — a heartbeat row is committed to `trading_state` before `pg_dump`
  takes its snapshot and kept current during the dump. The newest heartbeat
  present in the *restored* copy is the last committed write the backup
  captured; `rpoMs` is the gap from that write to backup completion, i.e. the
  confirmed data-loss window a real restore would suffer.
- **Fail closed** — if no heartbeat survives into the backup, or the recovery
  point precedes the last durable write, the drill throws instead of reporting
  a number. It will not invent a measurement.

### Environment labelling

`productionEligible` is derived from the connection string's host, never from an
env var: `localhost`, loopback and `*.local` hosts are `local`. A local or CI run
completes normally and prints `result: BLOCKED` with
`blockedReason: "drill ran against a non-production PostgreSQL host"`, so the
artifact can never be miscounted as V1 certification evidence. Setting
`EVIDENCE_REQUIRE_PRODUCTION=1` turns an ineligible host into a hard failure:
the run still writes its evidence artifact, but marked `BLOCKED` with
`blockedReason: "production evidence requested but the drill host is local"`
and exits 2 — use that in the production run.

Local run above is a mechanics check only. It is **not** production evidence:
the production rerun must supply `EVIDENCE_OPERATOR`, the real deployment's
`POSTGRES_URL`/`POSTGRES_RESTORE_URL`, and `EVIDENCE_REQUIRE_PRODUCTION=1`.

## 2. Crash-recovery drill — `npm run recovery:crash`

New reproducible drill: `scripts/crash-recovery-drill.js`.

```
POSTGRES_URL=postgresql://...@127.0.0.1:5432/nova_source \
PG_CRASH_CMD="pg_ctlcluster 17 main restart -m immediate" \
node scripts/crash-recovery-drill.js
```

```
{"passed":true,
 "database":{"version":"17.11"},
 "committedWriteSurvived":true,
 "abortedWriteRolledBack":true,
 "serverCrash":{"command":"pg_ctlcluster 17 main restart -m immediate",
                "measuredRecoveryMs":12,"totalDowntimeMs":2296},
 "committedWriteSurvivedServerCrash":true}
```

Phases:

1. **Committed write** — state row + audit entry committed, then a hard server restart.
2. **Aborted write** — a client is SIGKILLed with an open transaction after writing state; the row must not exist and the audit chain must still verify (no partial audit record).
3. **Server crash** — `-m immediate` restart (no graceful shutdown); after recovery the committed sentinel, migration state and audit chain are all intact from a fresh connection.

## 3. Real-service persistence suite

```
POSTGRES_URL=.../nova_ci TRADING_NOVA_REAL_DB_TEST=1 node --test tests/postgres.integration.test.js
```

8/8 passed against the real service: paper-sequence concurrency, health/persistence/migration
state, watchlist reconnection + revision fencing, journal across new connections, durable
rollback, execute-once idempotency, audit hash chain + tamper detection, paper-order
restart/replay idempotency.

## Defect found and fixed by this drill

`PostgresStore` attached no `error` listener to its `pg` pool. A PostgreSQL restart,
failover or dropped backend emits an idle-client `error` on the pool, which Node raises as
an unhandled event — the process (the trading server) died instead of reconnecting. Fixed in
`src/persistence/postgres.js`: the store now listens and records `lastPoolError` (error code
only; raw messages are dropped so connection details cannot leak). Regression test:
`tests/task-25-postgres.test.js` — "PostgresStore survives an idle pool error instead of
crashing".

## Full suite after the change

`NODE_ENV=test npm test` → 690 tests, 682 pass, 0 fail, 8 skipped (53s). `npm run lint` clean.

## Still open (not satisfiable from this environment)

- Production backup/restore with measured RTO/RPO against the real deployment.
- Production database version/topology evidence, access control review, backup retention policy test.
- Sustained market-data, observability, security, capacity and paper/shadow evidence (§3–§7 of the runbook).
- Human V1 release approval.

Real-money trading remains blocked.
