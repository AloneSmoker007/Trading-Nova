# Trading-Nova continuation — 30 October 2026 PKT

Repository: AloneSmoker007/Trading-Nova. This project is separate from Nova-AI.

## Latest active coding task — persisted editable watchlist

Starting main: `863be3e37ad5eebd31a8d8c0d0b435bc311770df`; PR #85 tutor setup/research mode is merged with green main CI (`40949485921`) and Chromium (`40949486087`). The user explicitly asked to code immediately rather than wait for the hourly worker. Scheduled continuation is temporarily paused during this active implementation to prevent overlapping writers; restore the enabled background handoff once this task completes.

Branch: `feat/persisted-watchlist-20261030`. Scope: add/remove/reorder up to 20 unique USDT market symbols, preserve an intentionally empty list, persist locally or in PostgreSQL, and keep unavailable/stale symbols visible without invented prices. Markets in other quote currencies are excluded from this watchlist slice; displayed price/quote-volume units are USDT, and base volume is not presented as dollar quote volume.

Storage and conflict rules:
- A dedicated local `.watchlist.json` snapshot is separate from paper portfolio/journal/execution files. Atomic same-directory replacement and a per-process queue prevent partial reads/lost concurrent edits in one Node process. This is not cross-process or power-loss certification; hosted production already requires PostgreSQL.
- PostgreSQL uses the existing `trading_state` schema and a transaction advisory lock for revision-checked saves. A stale revision returns 409; neither corrupt file data nor a failed configured database silently resets to defaults/local storage.
- GET/HEAD and bounded, rate-limited PUT share the existing private access guard. Edits do not submit orders or call Gemini/market providers. The market overview separately reads quotes, preserves list order and accounts for snapshot age while slower requests complete.
- The browser edits the acknowledged saved list, supports native keyboard controls, refresh/reload, conflict recovery and unconfirmed network-save messages. Coin selection updates the active order-symbol label and clears the previous reference-price input.

Acceptance coverage includes actual local server recreation, invalid/duplicate/over-limit symbols, maximum boundary, empty state, local concurrent revisions, corrupt storage, no database fallback, unavailable/stale prices, read/write authorization, body/rate limits, a real PostgreSQL reconnection/concurrent-edit test and Chromium add/remove/reorder/reload/conflict/offline flows. Read the matching PR for final test counts, exact head, CI and merge proof. Do not claim a live production deployment from fixtures or CI.

Local suite for this slice: 592 total, 585 pass, 0 fail, 7 skip (including the new real-PostgreSQL case when no local database is configured). Lint, sequential secret scan, syntax and diff checks passed; actual PostgreSQL and browser results must come from CI.

## Completed task — Tutor setup and sources-required research

Starting main: `f1b4ab0a15c4c1df79f379e5aab596b7a3c782f3`. PR #84 is merged and its main CI/browser checks passed; do not duplicate the council-freshness fix recorded below.

The current user again requested active coding, with real AI and internet research as core requirements. The implementation keeps the existing Gemini adapter and adds:
- An authenticated `GET/HEAD /api/tutor/status` configuration projection with no provider/market requests, credentials or configured model values. `connection: not-checked` prevents a configured key being described as a proven live connection.
- A browser setup check and retry control. Asking is disabled until configuration is available; current answer/research state is separate from setup status.
- Explicit `researchMode: required-sources` alongside the backward-compatible `auto` mode. Disabled web research fails before provider/optional market work. A successful provider answer without usable grounding links is withheld in required-sources mode; ordinary educational answers retain their existing no-citations state.
- Browser and HTTP success/failure/privacy/authentication regression coverage. This records implementation intent; read the matching PR for final head, CI and merge evidence.

Local validation for this increment: 583 total tests, 577 pass, 0 fail, 6 skip; lint, JavaScript syntax and diff checks passed. The secret scan is run sequentially after tests, because test temporary-directory cleanup can race a simultaneous tree scan. Grounding links containing embedded username/password fields are rejected. Final Chromium and GitHub CI remain required before merge.

Source links are retrieval evidence, not proof that every statement is supported, timely or correct. Structured news/fundamental/sentiment feeds connected to council scoring, publication timestamps, source trust and a live configured Gemini/runtime check remain separate unfinished work. No live provider call, deployment, credentials change or spend is claimed by these tests.

Completed as PR #85, merged at `863be3e37ad5eebd31a8d8c0d0b435bc311770df`. Main CI `40949485921` and Chromium `40949486087` passed. Keep the authorized continuation task aligned with the latest checkpoint.

## Autonomous continuation authorized — 30 October 2026 PKT

The user explicitly authorized continued Trading-Nova bug fixing and development while away, with implementation choices made autonomously. Preserve the existing product: a professional TradingView-like terminal, source-backed live/near-live markets, realistic fake-money paper execution, Roman Urdu Gemini teaching, safe internet research, multi-role evidence/uncertainty/WAIT, journal/thesis/outcome learning, backtesting and server-authoritative risk. Merge bounded fixes only after exact-head CI is green and the diff has been reviewed. No repeated permission is needed for these authorized code tasks.

An hourly background continuation task was created and confirmed enabled. This is scheduled work, not a nonstop worker or a guarantee of completion while the user sleeps. Prevent overlapping implementations; inspect open PRs and resume the existing task before starting another. Budget remains zero incremental spend; real-money execution stays OFF.

### Completed bounded bug: AI Council snapshot freshness

After PR #83 merged, main was verified at `d7b55c5ce1e69f754ab5420e82aa815ae72e7d5f`, with all enabled CI and browser jobs green. Quality suite: 554 pass / 0 fail / 6 skip. Production feed soak remained skipped.

The HTTP AI Council discarded ticker/candle envelope freshness and always returned `state: ok`, including when providers returned stale cached data or no usable inputs. The UI labelled cached analysis ANALYZED and retained old scores/roles after a later request failed.

Acceptance and implementation:
- Return 503 with no council when the quote is absent/invalid or candle history has fewer than 20 rows.
- Expose quote/candle fetch-cache ages and the 10-second freshness threshold. These ages describe snapshot retrieval; they do not certify exchange event timestamps, candle continuity, source trust or a production feed soak.
- Either stale envelope, a stale flag, unknown/negative age or an age over 10 seconds forces WAIT, high uncertainty and a null current opportunity score. Historical role details are clearly reference-only.
- Display STALE SNAPSHOT and N/A in the browser; clear old scores, decisions and roles while loading or after unavailable/offline results. Ignore superseded council requests.
- New API/HTTP regressions reproduced the old behavior: 0/15 passing before the fix. Focused freshness/legacy council/terminal suite: 24/24 passing after the fix. Real Chromium stale/unavailable/offline checks were added; final CI remains authoritative for the complete candidate.
- An additional injected-clock regression reproduced a quote aging during the candle read (15/16 freshness cases passed before that adjustment). Snapshot ages now include elapsed work before analysis. Final local suite: 576 total, 570 pass, 0 fail, 6 skip; lint, sequential secret scan, browser-script/asset syntax and diff checks passed. Final remote CI/browser results and merge state must be read from the matching PR.

Completed as PR #84, merged at `f1b4ab0a15c4c1df79f379e5aab596b7a3c782f3`. Merged-main CI run `40946013332` and Chromium run `40946013143` passed; local main also passed 570 tests with 6 skips. Re-verify remaining gaps before selecting the next bounded task. No unsupported feature or external certification claim is authorized by a green unit test.

## Recovered and verified state

- Starting main: `0369a39dbde4ee4b68c1c185abf263af94a8a702`.
- PR #46 terminal and PR #34 PostgreSQL persistence are merged. PR #24 is closed without merge. No older task was restarted.
- No open pull requests were found before this continuation created PR #83.
- Main's CI run `38382472399` was red while Browser E2E was green. The recovery job failed before checkout because the ECR PostgreSQL mirror returned `Data limit exceeded`.
- Targeted retry, attempt 2, reproduced the same registry failure. The other existing CI jobs remained successful; the optional market-data soak was skipped, not passed.

## Bounded fix: PR #83

1. Use `postgres:16` for the audit and recovery service containers, matching the existing operational-evidence workflow.
2. The first candidate passed container startup and audit integration, but the actual restore exposed another compatibility failure: `SET transaction_timeout = 0` was rejected by PostgreSQL 16. The runner-selected backup tools were incompatible with the restore target.
3. Pin the recovery runner to `ubuntu-24.04`, select `/usr/lib/postgresql/16/bin` for both `pg_dump` and `pg_restore`, install `postgresql-client-16` only if these executables are missing, and print their versions before the drill. The intervening `ubuntu-latest` candidate landed on Ubuntu 26.04, whose configured repositories did not provide `postgresql-client-16`; do not rely on a moving runner default for this version-sensitive drill. Keep the existing restore, integrity, audit-chain, migration and sentinel assertions intact.

PostgreSQL documents that newer dump output is not guaranteed to restore into an older server: https://www.postgresql.org/docs/16/app-pgdump.html.

## PR #83 original validation record (before final CI)

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
