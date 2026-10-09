# Trading-Nova — Next Execution Roadmap (V1)

**Updated:** 2026-10-09  
**Purpose:** Continue the existing repository without restarting or redesigning it. This roadmap is the next execution queue, not a certification claim.

## Current checkpoint

- Open draft PRs: #51–#59.
- Latest check-run inspection found the required test, PostgreSQL integration, PostgreSQL audit integration, recovery drill, stress/capacity and Neon PostgreSQL jobs successful on the inspected heads.
- `market-data-evidence` is skipped by workflow design unless the opt-in soak evidence is requested; a skipped soak is **not** production market-data evidence.
- All nine PRs remain open/draft. Green CI does not mean reviewed, merged, deployed, or V1-certified.
- Keep real-money execution OFF. No exchange/broker live credentials, withdrawal/transfer path, or live order mode.
- PRs #53–#59 are stacked on #52; #52 is based on #51. Review the dependency chain before changing PR bases or merging. Do not bulk-merge.

## Execution order

### Gate 0 — Close the current code-review queue
1. Review #51–#59 diffs, tests, branch bases and current checks.
2. Confirm whether each PR has unresolved comments, conflicts, or missing acceptance tests.
3. Recommend a safe merge order and identify which checks are required versus opt-in.
4. Do not merge, change production settings, or mark certification complete without explicit approval.

**Exit:** a factual PR matrix; all required CI checks green on the final candidate commit; no unresolved critical/high finding; a reviewed merge order.

### Gate 1 — Locked product-contract gap audit
Audit `docs/TRADING-NOVA-MASTER-ROADMAP.md` §21 against the actual UI, HTTP routes, API handlers, data models, tests and docs. Classify every feature as **Implemented + tested**, **Partial**, **Missing**, or **External evidence required**. Include exact file/route/test evidence. Do not infer that a module existing means the user-facing feature works end-to-end.

Cover at least:
- market list, price/chart freshness and watchlists;
- portfolio, positions, orders, fills, P&L and history;
- paper order types and realistic fill behavior;
- indicators, fundamentals/regime and portfolio risk;
- source-tracked public news/sentiment/research;
- AI council, dissent/uncertainty/WAIT-NO-TRADE;
- journal, theses and durable learning memory;
- backtest/out-of-sample/walk-forward/benchmark/costs;
- strategy lab, shadow comparison and promotion/revalidation;
- responsive UX, backend-authoritative state and deterministic Risk Gate.

**Exit:** evidence-backed gap matrix, ranked P0/P1/P2 backlog, tests needed, and explicit separation of code gaps from real-world certification blockers.

### Gate 2 — First product vertical slice: Market Terminal
Only after Gate 1 is reviewed, select the smallest high-value incomplete slice. Preferred starting slice: a usable market overview with symbol selection, current price, chart/candle history, freshness/source state, and graceful stale/unavailable behavior. Reuse existing modules; do not replace architecture. If this slice is already complete, select the highest-priority missing feature shown by the audit instead.

**Exit:** user-visible end-to-end behavior, meaningful success and failure tests, safe loading/empty/error states, accessible responsive UI, no fabricated market values, CI green, draft PR and checkpoint.

### Gate 3 — Paper trading workflow completeness
Audit and close end-to-end gaps for paper order submission → deterministic Risk Gate → realistic paper fill/reject/partial fill → durable order/fill history → portfolio/P&L updates → restart recovery and reconciliation. Support only order types the engine can safely model. Test duplicate/idempotent requests, invalid/stale prices, limits, fees/slippage, partials, rejection and restart. Do not add live execution.

**Exit:** durable state reconciles; no duplicate fills after retry/restart; risk blocks are enforced server-side; all tests and required CI green; draft PR.

### Gate 4 — Research, learning and release evidence
Then close gaps for source-attributed public research/news freshness, AI council disagreement and uncertainty, WAIT/NO-TRADE, journal/thesis learning, backtest robustness, strategy comparison and promotion/revalidation. AI must never bypass the Risk Gate or treat untrusted web text as instructions.

In parallel, prepare (but do not fabricate) the external V1 evidence in `docs/V1-EXTERNAL-EVIDENCE-RUNBOOK.md`: real PostgreSQL deployment, isolated backup/restore and measured RTO/RPO, market-data soak, alert delivery, independent security review, representative load/cost, sustained paper/shadow reconciliation and human approval. These require real environment access/evidence; code mocks are not substitutes.

## Mimo prompt plan — 4 prompts, sequential

Use **one prompt at a time**. Wait for review/tests/CI and checkpoint before sending the next. Do not run more than two agents concurrently.

### Prompt 1 — PR/CI gate audit (read-only)
> In AloneSmoker007/Trading-Nova, inspect open PRs #51–#59 and their actual head/base SHAs, latest required GitHub Actions checks, diffs, review comments, and dependency order. Do not edit files, rebase, merge, deploy, or change secrets. Distinguish required checks from the opt-in market-data soak. Return a table with PR, purpose, base/head, latest check result, risks/comments, dependency, and recommended safe review/merge order. Never call a green CI run “production certified.”

### Prompt 2 — Locked feature gap audit (docs/tests only)
> Read docs/TRADING-NOVA-MASTER-ROADMAP.md §21 and inspect the actual UI, routes, API handlers, data models and tests in this repository. Create docs/V1-PRODUCT-GAP-AUDIT.md with one row per locked product capability: status (Implemented + tested / Partial / Missing / External evidence required), exact file/route/test evidence, risk, and acceptance test needed. Do not assume module existence proves end-to-end behavior. Do not change runtime code, weaken controls, fabricate evidence, or enable real-money trading. Run relevant validation and open a draft PR based on main.

### Prompt 3 — First audited UI/API slice
> Use the reviewed V1-PRODUCT-GAP-AUDIT.md. Implement only the single highest-priority missing user-visible vertical slice that can be completed safely without external production credentials. Prefer the market overview (symbol selection, real source-backed price/candles, freshness and stale/unavailable states) unless the audit proves another P0 is more urgent. Reuse current architecture; no redesign/rewrite. Add success, failure, stale-data and security tests; never invent prices or bypass server-side controls. Run tests, lint and secret scan; fix regressions; open a draft PR and report exact files, commands, results and remaining gaps. Do not merge or deploy.

### Prompt 4 — Paper order lifecycle hardening
> Audit the existing paper order flow end-to-end before editing. Close only the highest-priority gap in submission → deterministic Risk Gate → fill/reject/partial → durable history → portfolio/P&L → restart recovery/reconciliation. Add regression tests for duplicate retries, invalid/stale price, risk-limit rejection and restart/replay. Keep paper-only mode enforced; do not add live orders, exchange credentials, withdrawal/transfer paths, or autonomous risk increases. Run all relevant tests, lint and secret scan; open a separate draft PR based on the correct dependency branch; report CI and a checkpoint. Do not merge or deploy.

## Completion rules

For each task: **gap → spec → risk → implement → test → review → CI → draft PR → checkpoint**. Fix failed checks before starting another implementation prompt. No merge/deployment or production-secret change without explicit approval. No artifact means no external-evidence PASS. V1 remains uncertified until the external evidence runbook and human approval are complete.
