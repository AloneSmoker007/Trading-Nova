# Security Policy — Trading Nova

## Posture (read this first)

Trading Nova is a **research and paper-execution workspace**. It is **not
live-money ready** and makes no claim otherwise: there is no exchange
connectivity, no live order path, and every safety gate below defaults to
"no trade" / "blocked" when its inputs are missing, stale, or invalid.
Certification-style documents under `docs/` describe milestones and gates, not
a production trading authorization.

## Key handling (non-negotiable)

- Exchange API keys are **trade-only**. Withdrawal/transfer permissions must be disabled at the exchange.
- Keys are stored **encrypted at rest** (or in an OS keychain / env file outside the repo), never in git.
- CI runs secret scanning; a leaked key is rotated immediately and the history is scrubbed.
- No feature will ever withdraw, transfer, or convert funds.

## Secret scanning (CI gate: `npm run security:secrets`)

`scripts/secret-scan.js` is the credential gate for the working tree. It was
hardened in 2026-10 to close documented blind spots:

- **File coverage.** All text-ish files are scanned, including the previously
  skipped credential-bearing types: `.example` (e.g. committed `*.env.example`
  templates), `.pem` / `.key` / `.crt` / `.p8` / `.p12` / `.pfx`, `.sh` / `.bash`
  / `.zsh`, `.properties`, `.log`, `.ts`, plus every extension-less file.
- **Pattern coverage.** Vendor-shaped credentials (OpenAI, GitHub, AWS, Google,
  Slack tokens and webhooks, Stripe live keys, JWTs, Telegram bot tokens, PEM
  private keys, credentialed `postgres://` and `http(s)://` URLs, Binance
  assignments) **plus generic credential assignments**: `API_KEY=`, `SECRET=`,
  `TOKEN=`, `PASSWORD=`, `PRIVATE_KEY=`, `client_secret=`, including prefixed
  names such as `MY_API_KEY=` / `DB_PASSWORD=`. Values shorter than 16
  characters or placeholder-shaped (`YOUR_*`, `*-MARKER-*`, `EXAMPLE`,
  `PLACEHOLDER`, `DUMMY`, `<INSERT_...>`, `${...}` references) are ignored so
  docs and test fixtures stay quiet without opening a hole for realistic values.
- **Allowlist scope.** The GitHub Actions throwaway database credentials
  (`postgres:postgres@localhost` / `127.0.0.1`, `trading_nova_*` databases) are
  stripped **only inside `.github/workflows/`**. The same connection string
  anywhere else is reported as a finding — a real localhost credential must
  never be silently whitelisted.
- **Output hygiene.** The scan prints only the pattern name and the file path,
  never the matched secret.
- **Known scope limits.** The scan covers the working tree, not git history and
  not binary blobs. Per the key-handling policy above, a leaked secret is
  rotated and the history is scrubbed — the scanner is a tripwire, not the only
  control.

## Outbound request hardening (timeouts)

"No outbound call may hang the engine or a job" (audit finding H-sec-1).
Every network call made from `scripts/` goes through
`scripts/lib/http.js`:

- `fetchWithTimeout` wraps each request in `AbortSignal.timeout(ms)` and turns
  aborts into a typed timeout error; the per-request timeout is additionally
  clamped to the run's overall deadline.
- `fetchWithRetry` adds **deadline-aware retries**: only network failures,
  timeouts, HTTP 429 and 5xx are retried, backoff never sleeps past the
  deadline, and no request is started after it.
- `scripts/load-test.js`, `scripts/market-soak.js`,
  `scripts/observability-smoke.js` use these wrappers (env knobs:
  `LOAD_TEST_REQUEST_TIMEOUT_MS`, `MARKET_REQUEST_TIMEOUT_MS`,
  `OBSERVABILITY_REQUEST_TIMEOUT_MS`, `OBSERVABILITY_RETRIES`,
  `OBSERVABILITY_SMOKE_DEADLINE_MS`).
- `scripts/migrate.js` bounds DB work two ways: transaction-local
  `statement_timeout` / `lock_timeout` on the database side, and an overall
  `withDeadline` (`scripts/lib/deadline.js`) on the client side that tears the
  pool down and exits non-zero (`MIGRATE_STATEMENT_TIMEOUT_MS`,
  `MIGRATE_LOCK_TIMEOUT_MS`, `MIGRATE_DEADLINE_MS`).
- The market-data client layer (`src/market-data/*`) carries the matching
  timeout/retry hardening (same audit finding, companion change).
- `scripts/evidence-schema.js` is pure validation with no I/O — nothing to
  time out.

## Safety invariants (2026-10 fix wave)

- **The Risk Gate is enforced on the order path.** Order submission requires an
  `evaluateRiskGate` **ALLOW artifact** (order hash + config hash) and refuses
  any order without one — the gate is no longer a convention but a hard code
  path between strategy and execution (`src/execution/`, `src/risk/gate.js`).
  Drawdown is computed from **peak** equity; position/concentration caps are
  checked against **resulting exposure** across split orders; restored
  checkpoints are fully hash-verified; kill switch and stale-data checks fail
  closed to "no trade".
- **The AI council fails closed.** Evidence scores are strictly validated
  (finite, in `[0,100]`); `NaN` / `null` / `""` / out-of-range input is
  rejected and forces `decision:"WAIT"` with `uncertainty:"High"` — garbage
  evidence can never produce `RESEARCH`, and `null` never counts as `0`.
  AI/model output is treated strictly as untrusted input (labelled data vs
  assumption vs interpretation) and cannot approve its own promotion, change
  the Risk Gate, raise limits, or enable live trading.
- **Everything else defaults to deny.** Readiness, disaster-recovery,
  production-certification and cost/performance gates default to
  `failClosed` / `liveMoneyBlocked`; market-data normalisers reject whole
  payloads on any malformed field.

## Threat model (short)

- **Repo leak** → keys must be useless (trade-only + encrypted + scoped IP where possible); secret scan trips before commit/CI merge.
- **Bug in strategy code** → Risk Gate caps size/loss; kill switch stops all trading.
- **Crash mid-order** → idempotent order handling + outbox pattern prevents duplicates.
- **Hung or hostile upstream** → every outbound request has a timeout and a deadline; staleness gates fail closed to "no trade"; jobs fail loudly instead of wedging.
- **Model/AI misjudgment** → AI output passes the same Risk Gate as human orders; invalid evidence fails closed to WAIT; every decision journaled and explainable.
- **Self-deception** → append-only, hash-chained journal; history cannot be quietly edited.

## Residual risks (known, tracked)

- The npm lockfile resolves from a third-party mirror (`registry.npmmirror.com`)
  with `sha512` integrity hashes; provenance concentration is accepted for now.
- The `pg` connection pool has no driver-level `connectionTimeoutMillis`
  (tracked limitation); ops scripts are deadline-bounded at the script level.
- Git history and binary blobs are outside the secret scan's scope (see above).

## Reporting

Found a security issue? Open a private security advisory on this repository.
