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
node scripts/backup-restore-drill.js     # pg_dump -> manifest hash -> pg_restore -> verify
{"passed":true,"artifactSha256":"b3090ec645873b22c65186f4ed86ae1b5558fa740c80fc1f04d38054569d259c","restoreVerified":true}
```

Verified after restore into the isolated database: health probe, hash-chained
audit verification, migration state present, sentinel state row present.

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

`NODE_ENV=test npm test` → 683 tests, 675 pass, 0 fail, 8 skipped (52.6s). `npm run lint` clean.

## Still open (not satisfiable from this environment)

- Production backup/restore with measured RTO/RPO against the real deployment.
- Production database version/topology evidence, access control review, backup retention policy test.
- Sustained market-data, observability, security, capacity and paper/shadow evidence (§3–§7 of the runbook).
- Human V1 release approval.

Real-money trading remains blocked.
