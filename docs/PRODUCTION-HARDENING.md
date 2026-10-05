# Production Hardening

This layer closes the code/CI gaps identified by the production audit.

## Completed in this branch

- Real ESLint 9 flat-config quality gate over source, scripts, tests and the ESLint config.
- CI installs dependencies and runs the real linter.
- CI runs a PostgreSQL 16 service and applies the canonical migration path.
- Real PostgreSQL integration tests cover health, persistence, transaction rollback, idempotency and audit-chain integrity/tamper detection.
- Secret scanning covers repository text files rather than only source/test directories, while skipping dependency/build metadata directories.
- Secret patterns include common OpenAI, GitHub, AWS, Google, Slack, private-key, credentialed-URL, PostgreSQL password-URI and Binance credential-assignment forms.
- 001_core.sql is explicitly classified as a legacy trading_nova.* schema and is not applied by the canonical migration runner. 001_initial.sql is the canonical schema for the current PostgresStore (trading_* tables).

## Still external / not certified here

A GitHub-hosted PostgreSQL service proves integration behavior in CI; it is not a production database deployment, backup/restore drill, HA failover test, venue conformance test, production alert deployment or human live-money approval.

Real-money trading remains blocked.
