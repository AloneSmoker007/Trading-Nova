# Trading Nova — Master Roadmap

**Status:** Reconciled architecture and build plan  
**Scope:** Personal web-based AI trading research, teaching, risk, paper-execution and learning workspace  
**Capability inventory:** 103 consolidated capabilities  
**Research traceability:** ~1,900+ raw research requirements; these are not 1,900 coding tasks.

## 1. Product Contract

Trading Nova is a risk-first personal trading copilot. It must provide fresh public market information with source quality and freshness; teach trading reasoning; explain decisions including in Roman Urdu; use opportunity scores only when evidence supports them; show calibrated probability only when statistically validated; expose uncertainty and conflicting evidence; treat WAIT / NO-TRADE as first-class; remember trades, mistakes, theses and outcomes; test new ideas through backtest, challenger and shadow modes; and never autonomously weaken risk controls, raise leverage/limits, enable live trading, or remove safety controls.

It remains paper-first and human-controlled for live trading and must never present output as guaranteed financial advice.

## 2. Golden Architecture

WORLD DATA
→ DATA QUALITY / SOURCE TRUST
→ MARKET REGIME
→ RESEARCH / AI COUNCIL
→ EVIDENCE + COUNTER-EVIDENCE
→ STATISTICAL VALIDATION
→ STRATEGY / SIGNAL CONTRACT
→ PORTFOLIO STATE
→ RISK LIMITS
→ DETERMINISTIC RISK GATE
→ PAPER / SHADOW / LIMITED LIVE
→ EXECUTION + RECONCILIATION
→ APPEND-ONLY JOURNAL
→ LOSS AUTOPSY / DRIFT / LEARNING
→ REVALIDATION / PROMOTION

**Golden rule:** AI can discover an opportunity. Statistics can validate it. Portfolio logic can size it. Only the deterministic Risk Gate can permit an order.

## 3. Non-Negotiable Dependency Rules

1. Portfolio State exists before Risk Limits and Risk Gate.
2. Journal, thesis and evidence exist before an order is eligible.
3. Strategy code never calls an exchange/broker SDK directly.
4. Reconciliation is mandatory for every non-paper execution tier.
5. Unknown execution state, stale/corrupt critical data, broken protection, unresolved reconciliation, or security emergency means STOP / NO-TRADE.
6. Risk and strategy safety configuration is human-approved, versioned, hashed and audited. AI and automated strategy components cannot write it.
7. Every material model/strategy/config change requires impact analysis and revalidation.
8. Testing and production execution are structurally separated.
9. A Promotion Certificate is required before moving to a higher execution tier.
10. Independent safety controls can stop trading even if the primary Risk Gate fails.

## 4. Core Engines

E1 Foundation & Security
E2 Market Data
E3 Quant & Simulation
E4 Portfolio & Risk
E5 Execution
E6 Reconciliation
E7 Journal & Learning
E8 AI Research
E9 Model / Strategy Lifecycle
E10 Market Intelligence
E11 Reliability
E12 Durability
E13 Advanced Intelligence
E14 Governance & Human Safety

## 5. Correct Build Phases

### Phase 0A — Secure Foundation
Repository/package structure, configuration and environment separation, structured logging, secret handling/scanning, dependency/provenance controls, CI, test harness, secure defaults and security boundaries.

**Exit:** reproducible install, CI green, tests executable, no committed secrets.

### Phase 0B — Contracts & Safety Boundaries
Define Strategy/Signal, Journal/Thesis/Evidence, Portfolio State, Risk Configuration, Execution/Order and Reconciliation contracts. Establish immutable/versioned safety configuration and module boundaries preventing direct exchange SDK use.

**Exit:** contracts documented, tested and dependency-correct.

### Phase 1 — Market Data & Truth Layer
Public market data, storage, source identity/trust, freshness, gaps/outliers, point-in-time/as-of correctness, deterministic replay, data-quality gate and survivorship-safe universe foundations.

### Phase 2 — Portfolio + Deterministic Risk
Order: **Portfolio State → Risk Limits → Risk Gate**.

Include positions/exposure, realized/unrealized PnL, max position, max daily loss, max drawdown, leverage/exposure, concentration, stale-data stop, emergency kill switch, independent defense-in-depth controls and control effectiveness measurement.

**Exit:** no order path can bypass deterministic safety.

### Phase 3 — Paper Execution
Venue abstraction, paper order lifecycle, realistic fees, spread/slippage, partial fills, rejects/cancels, idempotency, crash-safe outbox, execution state machine and circuit breakers.

No real-money trading.

### Phase 4 — Reconciliation + Journal + Memory
Broker/venue reconciliation, append-only hash-chained journal, thesis/evidence, trade rationale, pre-order memory recall, outcome tracking, Loss Autopsy and durable export/restore.

**Exit:** every paper trade is explainable and reconstructable.

### Phase 5 — Backtesting & Statistical Validation
Realistic transaction costs, point-in-time data, look-ahead prevention, survivorship-bias prevention, in/out-of-sample, walk-forward, benchmark/baseline, sensitivity, robustness/stress testing, deterministic replay, event-driven simulation parity and calibrated probability where evidence permits.

A backtest without realistic costs or valid temporal boundaries is rejected.

### Phase 6 — AI Research Brain
AI may research, summarize, compare evidence, generate hypotheses, challenge theses, explain setups, estimate opportunity scores and abstain.

AI may not bypass Risk Gate, modify safety configuration, enable live trading, increase limits/leverage or remove controls.

**Probability contract:** Opportunity Score is not probability. Calibrated Probability is shown only after statistical validation. Uncertainty and sample size are visible where applicable.

### Phase 7 — Lifecycle, Governance & Validation
Model/strategy registry, authorized operator matrix, Promotion Certificate, algorithm/version identity, venue-behavior conformance testing, material-change impact gate, ongoing validation/revalidation scheduler, control-effectiveness monitoring, independent challenge/separation of duties, correlated/common-mode AI failure tests, input representativeness/coverage checks, third-party/outsourcing exit controls and full automated-activity reconstruction.

### Phase 8 — Shadow, Reality Gap & Capacity
Paper→live reality-gap monitoring, shadow execution, latency/slippage drift, capacity and peak-stress admission gate, load/backpressure, liquidity stress, failure injection, recovery drills, position-protection audit and execution equivalence checks.

### Phase 9 — Human-Controlled Live Promotion
Promotion chain:

**Research → Backtest → Validation → Paper → Reconciliation → Shadow → Promotion Certificate → Human Approval → Limited Live → Controlled Live**

Limited live requires explicit position, daily-loss, drawdown and leverage caps, venue restrictions, kill switch, reconciliation and rollback/disable paths.

**No live money before Phase 9.**

### Phase 10 — Advanced Intelligence — CODE FOUNDATION COMPLETE
Broader market intelligence, multi-agent research, order-flow/microstructure, derivatives, on-chain, macro/news/OSINT, smart-money, cross-asset/intermarket, institutional-style research and advanced optimization.

Advanced intelligence never gets a Risk Gate bypass.

## 6. Promotion Certificate

A strategy/model moving upward must have immutable code/model/config hashes, data version and point-in-time boundary, in/out-of-sample results, walk-forward results, realistic costs, benchmark comparison, stress/capacity results, probability calibration where applicable, known failure modes, paper/shadow reconciliation, venue conformance, control-effectiveness evidence, independent validation and certificate expiry/revalidation date.

## 7. Hard STOP Conditions

STOP / NO-TRADE on unknown execution state, reconciliation mismatch, stale/corrupt critical data, exceeded risk limits, protection failure, venue/counterparty emergency, security incident, invalid/expired promotion evidence, unauthorized algorithm/operator/config, capacity or stress breach, or safety-control degradation.

## 8. 14-Day V1 Plan

Day 1–2: foundation, security, contracts, CI, tests  
Day 3–4: public/live market data, candles, freshness/quality, basic chart  
Day 5–6: Strategy/Signal, technical research, opportunity score, uncertainty, Roman Urdu explanation, WAIT/NO-TRADE  
Day 7–8: portfolio state, sizing, daily loss/drawdown, deterministic Risk Gate  
Day 9–10: paper execution, fees/slippage, lifecycle, reconciliation, thesis/journal  
Day 11: review, Loss Autopsy, benchmark, memory  
Day 12: responsive web dashboard  
Day 13: hard QA, security and failure-path tests  
Day 14: release audit, documentation, deployment, restore/checkpoint drill

Explicitly deferred from V1: production live-money trading, every exchange/venue, HFT-grade reconstruction, full institutional compliance, complete alternative-data universe and autonomous live optimization.

## 9. Capability Accounting

Current consolidated capability count: **103**.

The 13 newly reconciled capabilities are:

91. Model/Strategy Promotion Certificate
92. Defense-in-Depth Safety Controls
93. Control Calibration & Effectiveness Monitor
94. Control Conformance / Venue-Behavior Test Harness
95. Material-Change Impact Gate
96. Ongoing Validation & Revalidation Scheduler
97. Algorithm Registry + Authorized Operator Matrix
98. Third-Party / Outsourcing Control & Exit
99. Common-Mode / Correlated AI Failure Testing
100. AI Input Representativeness & Coverage Gate
101. Separation of Duties / Independent Challenge
102. Full Automated-Activity Reconstruction
103. Capacity & Peak-Stress Admission Gate

The raw research program remains approximately 1,900+ requirements. This is research traceability, not a claim of 1,900 software features.

## 10. Single Source of Truth

This file is the authoritative build roadmap.

README points here.

TASK.md contains only the current execution task and links here.

The capability inventory tracks capabilities and research coverage; it is not a competing build sequence.

## 11. Definition of Done

A phase is complete only when implementation exists, meaningful success/failure tests pass, security boundaries are verified, relevant replay/backtest/reconciliation evidence exists, CI is green, independent review has no unresolved critical/high blocker, documentation is updated, and rollback/restore is understood.

**Rule:** do not start the next task until the current task passes its acceptance criteria.

## 12. Immediate Next Task

**Task 1 = Phase 0A + Phase 0B foundation and architecture contracts.**

Do not implement live trading, broad AI, or advanced intelligence in Task 1.

The first objective is to make the system structurally safe to build on.


### Phase 10 implementation status
The Phase 10 code layer now includes:
- multi-agent research council with dissent/common-mode detection
- order-book microstructure and trade-flow features
- derivatives funding/open-interest/liquidation features
- cross-asset/intermarket regime analysis
- freshness-aware external/alternative evidence
- constrained optimization with revalidation trigger
- AI input coverage/representativeness gate
- probability calibration metrics (Brier score + bins)
- validation expiry/drift/revalidation decisions
- reconstructable research traces

Advanced intelligence remains downstream of evidence/data-quality and cannot bypass the deterministic Risk Gate.


## 13. Phases 11–20 Extension

### Phases 11–14 — Production Certification & Controlled Scale
Phase 11 validates real PostgreSQL, backup/restore, production market data, venue conformance, paper/shadow evidence, observability and human certification. Phase 12 adds testnet/limited-live controls with strict caps and rollback. Phase 13 validates challenger/calibration/revalidation/drift controls while keeping Risk Gate immutable. Phase 14 adds HA/DR/capacity/security/observability requirements.

These phases have code-level gates, but external infrastructure evidence must be produced before live-money promotion.

### Phase 15 — High Availability
Primary/replica readiness, explicit RTO/RPO targets and tested failover admission gate.

### Phase 16 — Disaster Recovery
Verified backup, isolated restore, recovery replay, rollback verification and incident-plan gate.

### Phase 17 — Security Assurance
Dependency, secret, authorization, threat-model and independent security-test evidence gate.

### Phase 18 — Cost & Performance
p95 latency, error-rate, monthly-cost and capacity-headroom admission controls.

### Phase 19 — Data Expansion
Coverage, freshness, source trust, point-in-time correctness and bias checks before expanded data can influence research.

### Phase 20 — Institutional Governance
Separation of duties, full automated-activity reconstruction, model inventory, material change control, independent validation and certificate expiry/revalidation.

**Phases 15–20 code foundation:** implemented with fail-closed tests. They do not fabricate external operational evidence.



## 21. LOCKED USER PRODUCT CONTRACT — 2026-10-08

This is the current user-facing target and takes precedence over stale execution wording elsewhere in this document.

### Product goal
Trading-Nova is a realistic, browser-based trading terminal for learning and paper trading. It uses **fake money** while following real market conditions as closely as the available data allows. Real-money execution remains OFF.

### Locked feature set
- Real-time/near-real-time market prices and charts.
- Watchlists, markets, portfolio, positions, orders, fills, P&L and trade history.
- Market, limit, stop, take-profit and other safe paper order types supported by the engine.
- Realistic paper fills: spread, fees, slippage, partial fills, rejects, latency and restart recovery.
- Technical indicators, fundamentals, market regime and portfolio analytics.
- Real-time public news, sentiment and internet research with source/evidence tracking and freshness.
- Multi-brain AI council: technical, fundamental, news, sentiment, strategy, risk and research roles.
- Human Brain: user preferences, journal, theses, mistakes, outcomes and durable personal learning memory.
- Internet Brain: fresh public information and research; untrusted web content never becomes an execution command.
- Market Brain: price/volume/order-flow/derivatives/intermarket context where data is available.
- Profit-oriented opportunity ranking based on evidence and **risk-adjusted expected value**, never guaranteed profit.
- Consensus, dissent, uncertainty, evidence quality and WAIT/NO-TRADE as first-class outputs.
- Backtesting, out-of-sample, walk-forward, robustness, benchmark and realistic-cost analysis.
- Famous-trader/known-strategy simulation and paper-only copy/signal experiments using documented public methodology; never fabricate private positions or trades.
- Strategy Lab, challenger strategies, shadow trading, performance comparison and promotion/revalidation.
- Advanced portfolio risk: exposure, concentration, correlation, volatility, liquidity, drawdown, daily/weekly loss limits and kill switch.
- AI trade explanations, journal review, loss autopsy, alerts and learning reports.
- Professional responsive web UI; backend remains authoritative for all trading state and risk decisions.
- Gemini API is an AI provider, server-side only. AI can research/explain/propose but cannot execute around the deterministic Risk Gate.

### Explicit exclusions for the current release
- No real-money orders.
- No withdrawals/transfers.
- No broker/exchange live credentials.
- No claim of guaranteed profitability.
- No autonomous increase of leverage, risk limits or safety settings.

### Future promotion path
Paper → Shadow → validated sandbox/testnet → explicit human approval → separately reviewed limited live → controlled live. Each higher tier requires new evidence and certification.

### Current implementation rule
Do not restart or redesign the repository. First close existing certification/infrastructure gaps, then implement the locked product capabilities in dependency order. Every task follows: gap → spec → risk → implement → test → review → CI → PR → merge only when green → checkpoint.

