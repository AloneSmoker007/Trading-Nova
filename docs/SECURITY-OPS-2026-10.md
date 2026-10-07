# Security & Ops Hardening — 2026-10 fix wave (WS-C)

Scope: secret-scanner blind spots (M2), outbound HTTP/DB timeouts for ops
tooling (H-sec-1, scripts half), and doc sync for the Risk-Gate enforcement and
AI-council fail-closed behaviour. Companion changes (owned by other workstreams in the 2026-10 fix wave):
Risk-Gate enforcement on the order path
(`src/execution/`, `src/risk/`), AI-council evidence validation
(`src/research/`, `src/intelligence/`), market-data client timeouts
(`src/market-data/`).

**Posture reminder:** Trading Nova is a research/paper-execution workspace and
is **not live-money ready**. Nothing in this wave changes that.

## 1. Secret scanner (`scripts/secret-scan.js`)

Closed blind spots documented in the 2026-10 security audit (M2):

| Gap | Before | After |
|---|---|---|
| File types | `.example`, `.pem`, `.key`, `.sh` (and friends) never read | Scanned: `.example .pem .key .crt .p8 .p12 .pfx .sh .bash .zsh .properties .log .ts` + all previously scanned types + extension-less files |
| Credential shapes | Vendor rules only (OpenAI/GitHub/AWS/Google/Slack/PEM/URLs/Binance) | + generic assignments: `API_KEY=`/`SECRET=`/`TOKEN=`/`PASSWORD=`/`PRIVATE_KEY=`/`client_secret=`, prefixed names included (`MY_API_KEY=`, `DB_PASSWORD=`) |
| Additional vendors | — | Stripe live keys, JWTs, Telegram bot tokens, Slack webhook URLs |
| CI placeholder allowlist | Applied to every file — a real `postgres:postgres@localhost/...` credential was silently whitelisted anywhere | Applied **only** to `.github/workflows/**`; the same string elsewhere is a finding |
| False-positive control | `YOUR_/CHANGE_/REPLACE_` (Binance rule only) | Placeholder-shaped values ignored across generic rules: `YOUR_*`, `EXAMPLE`, `PLACEHOLDER`, `SAMPLE`, `DUMMY`, `*-MARKER-*`, `<INSERT_...>`, `${...}` refs, values under 16 chars |

Unchanged on purpose: the scanner reports only pattern name + path (never the
secret), scans the working tree only (git history is covered by the
rotate-and-scrub policy in `SECURITY.md`), and is never weakened to make a run
pass.

## 2. Ops-script timeouts (H-sec-1)

New helpers:

- `scripts/lib/http.js` — `fetchWithTimeout` (per-request `AbortSignal.timeout()`,
  clamped to the run deadline, typed `RequestTimeoutError`) and `fetchWithRetry`
  (retries network failures/timeouts/429/5xx with exponential backoff that never
  sleeps past — or starts a request after — the deadline).
- `scripts/lib/deadline.js` — `withDeadline` races DB work against an overall
  deadline and rejects with `DeadlineExceededError`.

Wiring:

| Script | Hardening |
|---|---|
| `scripts/load-test.js` | per-request timeout (`LOAD_TEST_REQUEST_TIMEOUT_MS`, default 5s) + run deadline; a hung target can no longer stall the workers past the run window |
| `scripts/market-soak.js` | per-request timeout (`MARKET_REQUEST_TIMEOUT_MS`, default 5s) clamped to the soak window; hung quotes count as errors and trigger `noTradeRequired` |
| `scripts/observability-smoke.js` | deadline-aware retries (`OBSERVABILITY_RETRIES`, `OBSERVABILITY_SMOKE_DEADLINE_MS`, `OBSERVABILITY_REQUEST_TIMEOUT_MS`); per-event failures are reported, never hung |
| `scripts/migrate.js` | transaction-local `statement_timeout` / `lock_timeout` (DB side, via `set_config`) + overall `withDeadline` (`MIGRATE_DEADLINE_MS`, default 120s); on deadline the pool is torn down and the run exits 1 with an actionable message |
| `scripts/evidence-schema.js` | pure validation, no I/O — nothing to harden |

## 3. Behaviour contracts now documented in SECURITY.md

- **Risk Gate enforced on the order path** — submission requires an
  `evaluateRiskGate` ALLOW artifact (order hash + config hash) and refuses
  without it; drawdown measured from peak equity; caps checked on resulting
  exposure (split orders); checkpoints hash-verified on restore; kill switch and
  stale-data gates fail closed to "no trade".
- **AI council fails closed** — evidence scores validated (finite, `[0,100]`);
  invalid input forces `WAIT` + `uncertainty:"High"` and can never yield
  `RESEARCH`; `null` never counts as `0`; model output stays untrusted and
  cannot alter the gate, limits, or enable live trading.

## 4. Verification (this branch)

```
npm test              → 314 tests: 310 pass, 0 fail, 4 skipped (pre-existing)
npm run lint          → clean
npm run security:secrets → "Secret scan passed: no high-confidence credential patterns found."
```

New regression tests (`tests/ws-c-*.test.js`, 18 cases):

- `tests/ws-c-secret-scan.test.js` — generic `API_KEY=`/`SECRET=`/`TOKEN=`/
  `PASSWORD=`/`PRIVATE_KEY=` assignments caught; `.env.example`, `.pem` and
  `.sh` secrets caught end-to-end; clean files and placeholder values pass; the
  CI placeholder is allowed in workflow files but flagged elsewhere; the whole
  repository working tree stays clean under the hardened rules.
- `tests/ws-c-ops-timeout.test.js` — hung upstreams abort at the per-request
  timeout; retry loops stop at the deadline; 5xx retries are bounded
  (`retries+1` attempts); `withDeadline` bounds wedged work and validates input.

Test fixtures assemble fake credentials at runtime from short fragments so the
test sources themselves stay clean under `npm run security:secrets`.
