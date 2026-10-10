# Trading-Nova V1 Product Gap Audit

**Audit type:** source-backed static product-contract review  
**Snapshot audited:** main at a281857a5d47ca6785e93d17f706c755ef1faab7  
**Scope:** locked Product Contract in docs/TRADING-NOVA-MASTER-ROADMAP.md, section 21 (lines 242–283), actual browser UI, HTTP routes, API handlers, engines, persistence, tests, and the external-evidence runbook.  
**Not a certification:** this document does not claim production deployment, profitability, or V1 release approval. Real-money execution must remain disabled.

## Executive finding

The repository has a substantial paper/shadow foundation: private access guard, bounded resource controls, public market-data integration, freshness/stale states, a deterministic Risk Gate, persistent idempotent paper fills, journal integrity, backtest primitives, an AI council, a Roman Urdu tutor, health surfaces, and CI integration checks.

The largest product-contract mismatch is the paper order lifecycle. The API accepts LIMIT, STOP_LOSS and TAKE_PROFIT, but the persistent execution engine immediately records a full fill at the supplied mark price, with fee zero, regardless of the requested order type. That silently tells the user a more realistic order workflow exists when the engine does not model it. The safe next implementation task is to either implement real paper order states and triggers or reject unsupported types explicitly; do not silently execute them as market orders.

A second major mismatch is research provenance: the AI council uses 24-hour price momentum, quote-volume and candle-volatility proxies rather than public news, company fundamentals or social sentiment. The UI and API now label each proxy basis and explicitly report those three external feeds as not connected. The missing feeds and their source/freshness/trust controls are still an open gap.

## Status definitions

- **Implemented + tested:** code path and relevant regression/integration tests are present. This is not the same as external production evidence.
- **Partial:** some code/UI exists, but the locked user-facing behavior or meaningful acceptance evidence is incomplete.
- **Missing:** the required behavior was not found in the inspected runtime/UI flow.
- **External evidence required:** code-level gates may exist, but the claim depends on a real environment, independent review, sustained operation, or explicit human approval.

Priorities: **P0** = correctness/safety mismatch to block before representing that capability as supported; **P1** = core V1 workflow gap; **P2** = important completeness/usability gap; **E** = external certification gate.

## Product capability matrix

| Capability | Status | Evidence inspected | Gap / next acceptance criterion | Priority |
|---|---|---|---|---|
| Public ticker and candle data | Partial | server/market.js; src/market-data/providers/crypto.js; routes in server/app.js; tests/market-data-fallback.test.js | Connector, cache limits, stale window, coalescing and fallback exist. Production soak, reconnect/gap behavior and measured freshness/latency are not evidenced. Add a repeatable feed-health/gap/reconnect acceptance scenario and preserve NO-TRADE on stale critical data. | P1 / E |
| Market overview | Partial | server/api.js markets(); web/index.html Watchlist & Market Overview; web/app.js /api/markets and /api/market calls | The market list is a hard-coded five-symbol array (BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, ADAUSDT), not an editable persisted watchlist. Add add/remove/reorder/save/load tests and clear empty/unavailable states. | P2 |
| User-editable watchlists | Missing | server/api.js markets(); web/index.html controls | No dedicated persisted watchlist API or UI workflow was found. Add schema/state contract, input validation, ownership boundaries, and reload/restart tests. | P2 |
| Price chart and technical indicators | Partial | web/index.html chart SVG; web/app.js market/indicator calls; server/indicators.js; src/indicators/* | Price/candle rendering and many indicator functions exist. Verified end-to-end browser assertions and explicit candle gap/staleness visualization for all error paths were not established by the inspected scripts. Add browser-level checks for symbol change, loading, stale, unavailable, and malformed candle data. | P1 |
| Portfolio, positions, exposure and P&L | Partial | server/api.js portfolio(); server/orders.js getPortfolio(); src/risk/portfolio.js; dashboard portfolio panel | Durable portfolio state and gross/net exposure, P&L and drawdown calculations exist. Realistic fees/slippage and completed fill lifecycle are not consistently reflected in paper results; daily/weekly and correlation/liquidity analytics are not fully evidenced at the user-facing contract level. Test fee-adjusted, restart-reconciled and risk-blocked scenarios end-to-end. | P1 |
| Market / limit / stop-loss / take-profit semantics | Missing | server/orders.js parseOrderRequest() accepts MARKET, LIMIT, STOP_LOSS, TAKE_PROFIT and stop/take-profit fields; src/execution/paper-persistent.js PersistentPaperEngine.submit() | The engine ignores order type and stop/take-profit trigger fields, then writes an immediate full fill at markPrice. This is a material semantic mismatch, not a cosmetic gap. Implement explicit PENDING/OPEN/TRIGGERED/FILLED/CANCELLED/REJECTED states and trigger rules, or reject unsupported types instead of silently treating them as market orders. Add per-type tests including non-triggered, triggered, cancellation and restart/replay. | P0 |
| Realistic paper fills | Missing | src/execution/paper-persistent.js; server/orders.js submit(); src/backtest/engine-v2.js | Persistent paper execution records fee: 0, fills the full requested quantity immediately, and does not model spread, execution slippage, partial fills, cancel/replace or latency. Backtest fee/slippage settings do not make the live paper order path realistic. Add deterministic fee/spread/slippage configuration, partial/reject/cancel lifecycle, and restart reconciliation tests. | P0 / P1 |
| Idempotency and durable paper state | Implemented + tested | src/execution/paper-persistent.js; src/persistence/store.js; src/persistence/postgres.js; tests/ws-a-gate-enforcement.test.js; tests/ws-d-orders.test.js; tests/ws-a-persistence-postgres.test.js | Durable idempotent transaction paths and regression tests exist. Keep them as prerequisites when extending lifecycle states; prove that every state transition is atomic and replay cannot produce a second fill. Production backup/restore evidence is separate and still missing. | P1 / E |
| Deterministic Risk Gate | Partial | src/risk/gate.js evaluateRiskGate(); server/orders.js submit(); tests/ws-a-gate-enforcement.test.js | Gate checks order validity, approved config hash, fresh critical data, exposure/position, daily loss, drawdown, leverage, concentration, reduce-only, and kill-switch conditions. The locked contract additionally asks for weekly loss, correlation, volatility and liquidity controls; full user-visible measurement/configuration of those controls was not verified. Add explicit contracts/tests for each declared control; unsupported controls must not be advertised as active. | P1 |
| Order and fill history | Partial | server/api.js orders(query); server/orders.js getOrders(); src/persistence/postgres.js listPage(); src/persistence/store.js listPage(); tests/ws-d-orders.test.js | API accepts limit/offset and reports hasMore, but web/app.js calls /api/orders without pagination controls and renders only fills.slice(0, 10). Add next/previous controls, stable page state, accessible loading/empty/error states and a test proving page navigation. | P1 |
| Multi-brain AI council | Partial | server/ai.js computeAiCouncil(); src/intelligence/multi-agent.js; web/app.js AI Council rendering; tests/terminal-v2.test.js; tests/ws-d-ui.test.js | Per-role basis/display labels now identify “Liquidity proxy”, “24h momentum proxy”, “Volatility-regime proxy”, and “Data sufficiency”. API dataCoverage marks companyFundamentals/publicNews/socialSentiment as not-connected; UI visibly discloses the same. Real source-attributed fundamental, public-news and social-sentiment feeds, source timestamps, trust/freshness checks and stale/unavailable states remain missing; never imply they are connected until verified end-to-end. | Partial / P1 |
| Public news, sentiment and internet research | Missing | server/app.js route inventory; server/ai.js; docs/TRADING-NOVA-MASTER-ROADMAP.md section 21 | No user-facing news/research endpoint or source-attributed article/sentiment feed was found in the inspected HTTP route set. Add source URLs, timestamps, provenance, trust/freshness, counter-evidence, and an untrusted-content boundary; stale/unavailable sources must not be disguised as current evidence. | P1 |
| Roman Urdu Gemini tutor | Partial | server/tutor.js; /api/tutor/chat; web/index.html tutor card; tests/tutor.test.js | Server-side provider key, validation, untrusted-history wrapping, sanitized errors, and a hard deadline covering fetch plus response.json() are present. Runtime explicitly says internet/news research is not enabled. Tutor does not demonstrably recall journal theses, mistakes and outcomes as personal long-term memory. Keep this limitation visible; add retrieval only after provenance, privacy and prompt-injection boundaries are tested. | P1 |
| Journal and learning memory | Partial | server/api.js journal()/addJournalEntry(); src/journal/journal.js; web/index.html Journal Memory card | Append-only hash-chained journal and persistence/read UI exist. A full learn-from-outcomes loop linking thesis → order → fill → result → mistake/loss autopsy → tutor recall/revalidation was not established end-to-end. Add an immutable linkage contract and restart/reconstruction tests before claiming durable personal learning. | P1 |
| Backtest and statistical validation | Partial | server/api.js backtest(query); src/backtest/engine-v2.js; server/strategies.js | Backtest supports fees/slippage, reproducible output, a split primitive and a sensitivity grid. The HTTP endpoint does not pass a walkForward split, so the default response has no out-of-sample result; the browser Strategy Lab calls /api/strategy/lab rather than exercising the backtest endpoint. Add configurable temporal split, benchmark/baseline, robustness outputs and UI-visible sample sizes/results. | P1 |
| Known-strategy simulation | Partial | server/strategies.js createStrategy(); Strategy Lab UI/API | Three deterministic strategies exist: SMA cross, momentum, and a documented Turtle-style breakout. This is narrower than the locked strategy/copy-signal experiments. Keep all such experiments paper-only, source public methodology and show exact rules; do not fabricate private trader positions. | P2 |
| Challenger, shadow and promotion workflow | Partial | docs/TASKS-26-34.md; src/* lifecycle/shadow/promotion modules; TASK.md certification section | Code-level governance, shadow and promotion primitives are documented, but a complete user-facing flow connecting challenger → shadow evidence → comparison → revalidation/certificate → human approval was not verified in the visible routes/UI. Add a traceable state machine and negative tests proving no UI/API path promotes or enables live money without evidence and approval. | P1 / E |
| Risk alerts, health and operations | Partial | server/api.js health()/riskStatus(); web/index.html health and alerts panels; package.json observability:smoke/recovery:drill/stress:test | Health, readiness and risk UI/script hooks exist. Production log/metric retention, end-to-end alert delivery and incident-response evidence are not present in the repository runbook as completed artifacts. Connect and test alert routing for readiness, risk block, reconciliation, stale data, security and backup failures. | P1 / E |
| Private access and bounded resource controls | Implemented + tested | server/access-guard.js; tests/access-guard.test.js; src/security/client-rate-limiters.js; tests/client-rate-limiters.test.js; server/market.js; tests/market-data-fallback.test.js | Fail-closed login-table saturation, bounded client limiters, bounded market cache/in-flight work, and regression tests are present. This is code/test evidence, not an independent security assessment. Preserve fail-closed login behavior and never evict active rate-limit state to make room. | Implemented / E |
| Responsive browser UX and accessibility | Partial | web/index.html; web/app.js; current package.json test command | Accessible labels, live/status regions, forms and a dashboard surface exist. No browser end-to-end test runner is configured in package.json; responsive breakpoints, keyboard-only flows and screen-reader announcements have not been evidenced by automated browser checks. Add automated smoke tests for core order/rejection, sign-in/out, refresh/stale-data and pagination flows. | P2 |
| Real-money and release safety boundary | Implemented + tested at code level; external approval required | server/app.js paper-only guard; server/orders.js tradingMode guard; docs/V1-RELEASE-CERTIFICATION.md; docs/V1-EXTERNAL-EVIDENCE-RUNBOOK.md | Runtime is paper-only and promotion is not certified. Do not switch on live orders, add venue credentials or weaken the Risk Gate as part of V1 gap closure. Final certification requires all external gates plus explicit human approval. | E |

## External evidence gates — not satisfied by green CI

| Evidence item | Status | Evidence required to close |
|---|---|---|
| Real production PostgreSQL deployment and migration/recovery | External evidence required | Named environment/version, clean canonical migration run, durable persistence/idempotency/audit tests, restart/crash recovery artifact. CI Postgres/Neon checks are useful code evidence, not proof that a production deployment exists. |
| Backup, isolated restore, data verification, RTO/RPO | External evidence required | Actual backup and isolated restore artifacts, verified critical rows/state, replay result, measured recovery-time and recovery-point objectives. |
| Production market-data soak | External evidence required | Sustained production-source soak with freshness, latency percentiles, reconnect, sequence/gap detection/recovery and stale-data NO-TRADE evidence. The opt-in market-data-evidence CI job being skipped is not a PASS. |
| Observability and alert routing | External evidence required | Retained logs/metrics, end-to-end routed alerts and incident test evidence for readiness failure, risk block, reconciliation failure, unknown execution, stale data, security event and backup failure. |
| Independent security assessment | External evidence required | Threat model, independent review, findings/remediation, authorization and dependency/secret evidence; no unresolved critical/high blocker. |
| Representative capacity/load and cost | External evidence required | Representative workload, p95/p99, errors, memory/CPU/DB, headroom/backpressure, measured operating cost. CI stress test alone is not sustained production capacity evidence. |
| Sustained paper/shadow evidence | External evidence required | Sustained run window, paper-vs-observed price/quantity/fee/latency, zero unknown executions or investigated mismatches, reconstructable journal and reality-gap metrics. |
| Historical raw research requirement traceability | Missing source / Evidence required | Recover the historical ~1,900+ raw rows or explicitly reattach the source; map without silent deletion, mark duplicates/N/A with rationale. docs/V1-CAPABILITY-TRACEABILITY.md explicitly says the verbatim historical rows are not currently present; do not invent row-level mappings. |
| Final human V1 release approval | External evidence required | Review all code and external-evidence gates, record explicit human approval. Until then V1 remains NOT CERTIFIED and real-money execution remains OFF. |

## Prioritized next-task queue

### P0 — Correct paper order semantics before extending the terminal
1. Choose and document the supported paper-order state machine. For each order type either implement its declared trigger/lifecycle faithfully or return a clear unsupported-type rejection. Never immediately fill a LIMIT/STOP_LOSS/TAKE_PROFIT order as if it were MARKET.
2. Add deterministic, configurable simulated spread, fees and slippage, and define how partial fills, cancel/reject, latency and restart replay are represented. Keep market-data freshness and Risk Gate approval mandatory at every eligible execution/trigger point.
3. Add tests covering non-triggered and triggered orders, invalid trigger prices, cancel/replay, restart recovery, fee-adjusted portfolio/P&L, duplicate submission and risk rejection.

### P1 — Complete truthful data/research and validation paths
4. Keep proxy labels and disconnected-feed status explicit. Connect source-attributed public news/research, company-fundamentals and sentiment only when real feed data, source timestamps, source trust, freshness, counter-evidence and failure/stale states are implemented and tested.
5. Expose configurable in-sample/out-of-sample and walk-forward/benchmark/robustness results in the actual browser workflow, with sample sizes and caveats.
6. Add frontend pagination for order history and prove the same API pagination/ordering works after PostgreSQL restart.
7. Link journal theses to paper orders, fills, outcomes and loss-autopsy records; add safe, provenance-aware tutor recall only after trust-boundary tests.
8. Complete user-facing shadow/challenger/promotion observability while keeping every higher execution tier fail-closed.

### P2 — Product completeness
9. Add persisted editable watchlists and a predictable market overview workflow.
10. Add browser-level functional, responsive, keyboard and accessibility checks for the key routes and terminal flows.

### E — Certification track, in parallel but never simulated
11. Produce the real external artifacts in docs/V1-EXTERNAL-EVIDENCE-RUNBOOK.md. Keep each item pending until the artifact, timestamp, environment, operator and reproducible result exist.
12. Recover/map the historical raw research list, then record explicit human V1 approval after every external gate passes.

## Existing test evidence to retain and extend

- tests/access-guard.test.js — private-hosting gate and login-throttle behavior.
- tests/client-rate-limiters.test.js — bounded client limiter behavior.
- tests/market-data-fallback.test.js — market caching, fallback, coalescing, and bounded concurrent work.
- tests/ws-a-gate-enforcement.test.js — risk gate/artifact identity and paper execution boundaries.
- tests/ws-d-orders.test.js — order submission, persistence/replay and paginated history.
- tests/ws-a-persistence-postgres.test.js — PostgreSQL adapter integration contracts, including paged listing.
- tests/tutor.test.js — tutor validation/provider failure and hard-deadline behavior.

## Audit exit conditions

- Every capability above is reviewed against the locked contract and its evidence is linked to an exact file/route/test.
- P0 paper order semantics are either implemented with tests or unsupported order types are safely rejected.
- No unresolved critical/high security or correctness issue remains.
- Required CI on the final candidate is green; opt-in market-data soak is recorded as NOT RUN until separately executed.
- External evidence remains clearly distinct from CI/unit/integration checks.
- Real-money execution remains disabled; no profitability guarantee is made.

**Rule:** code present is not automatically end-to-end complete; tests passing are not production certification; no real artifact means no external-evidence PASS.
