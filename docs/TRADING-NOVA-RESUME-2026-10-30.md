# Trading-Nova continuation — 30 October 2026 PKT

Repository: AloneSmoker007/Trading-Nova. This project is separate from Nova-AI.

## Recovered and verified state

- Starting main: `0369a39dbde4ee4b68c1c185abf263af94a8a702`.
- PR #46 terminal and PR #34 PostgreSQL persistence are merged. PR #24 is closed without merge. No older task was restarted.
- No open pull requests were found before this continuation created PR #83.
- Main's CI run `38382472399` was red while Browser E2E was green. The recovery job failed before checkout because the ECR PostgreSQL mirror returned `Data limit exceeded`.
- Targeted retry, attempt 2, reproduced the same registry failure. The other existing CI jobs remained successful; the optional market-data soak was skipped, not passed.

## Bounded fix: PR #83

1. Use `postgres:16` for the audit and recovery service containers, matching the existing operational-evidence workflow.
2. The first candidate passed container startup and audit integration, but the actual restore exposed another compatibility failure: `SET transaction_timeout = 0` was rejected by PostgreSQL 16. The runner-selected backup tools were incompatible with the restore target.
3. Select `/usr/lib/postgresql/16/bin` for both `pg_dump` and `pg_restore`; install `postgresql-client-16` only if these executables are missing, and print their versions before the drill. Keep the existing restore, integrity, audit-chain, migration and sentinel assertions intact.

PostgreSQL documents that newer dump output is not guaranteed to restore into an older server: https://www.postgresql.org/docs/16/app-pgdump.html.

## Validation and continuation rules

- Clean `npm ci` succeeded under local Node v24.22.1.
- Full unchanged application suite: 560 tests, 554 passed, 0 failed, 6 skipped. Local external PostgreSQL cases were unavailable; these skips are not database evidence.
- Lint and credential-pattern secret scan passed.
- Workflow YAML parse, added Bash syntax and `git diff --check` passed.
- At this checkpoint, the final client-selection candidate still requires GitHub CI. Inspect PR #83's exact head, all CI and Browser E2E outcomes before merging; earlier candidate failures are historical evidence, not final results.
- PR #83 and its CI runs preserve the final outcome. Do not infer that it merged from this file alone.

## Remaining product/release work

Use `docs/V1-PRODUCT-GAP-AUDIT.md` against current code before selecting the next task; some backlog prose is stale (for example, the current backtest API already implements an automatic temporal split).

Remaining categories include persisted editable watchlists, structured source-backed research feeds, journal-to-trade/outcome learning, fuller paper-fill realism, and external operational certification. Re-verify each gap before editing.

Production deployment/restore, measured RTO/RPO, sustained market-feed and paper/shadow evidence, alerts, independent security review and human V1 approval remain separate gates. CI restore success alone cannot certify those.

Real-money execution remains OFF. No broker credentials, live orders, deployment or runtime-secret changes were part of this task.
