# Trading Nova — Master Roadmap

**Status:** Architecture / roadmap only  
**Scope:** Personal AI trading copilot; not SaaS  
**Safety posture:** Paper-first, deterministic Risk Gate, explicit human live unlock  
**Cost target:** $0/month where realistically possible; provider-independent by design

## 1. Product definition

Trading Nova is a personal research, risk, execution, journal, and learning workspace for one person learning to trade. It is not an autonomous money machine and must never optimize for activity over safety.

Primary goals:
- observe and validate market evidence;
- explain opportunities and uncertainty;
- protect capital before seeking returns;
- learn from the user's own losses;
- remain portable, recoverable, and inexpensive;
- allow controlled live trading only after evidence-based promotion.

Non-goals:
- multi-tenant SaaS;
- withdrawals, transfers, or custody;
- AI-only authority over capital;
- strategy changes directly in live mode;
- dependence on one cloud, broker, data vendor, or model.

## 2. Golden architecture

```
World Data
  -> Data Quality / Source Trust Gate
  -> Market Regime
  -> Research & AI Council
  -> Evidence + Counter-evidence
  -> Statistical Validation
  -> Portfolio / Risk Engine
  -> Deterministic Risk Gate
  -> Paper / Shadow / Limited Live
  -> Execution + Reconciliation
  -> Append-only Journal
  -> Loss Autopsy / Drift / Learning
```

**Golden rule:** AI may discover or rank an opportunity. Statistics may validate it. Portfolio logic may size it. **Only the deterministic Risk Gate may permit a trade.**

Unknown execution state, critical stale/corrupt data, failed reconciliation, exceeded risk limits, or critical venue health failure means **STOP / NO TRADE**.

## 3. Core engines

### E1 — Foundation & Security
Config, secrets, permissions, CI, tests, dependency trust, auditability, kill switch, secure defaults, provenance and recovery.

### E2 — Market Data
Public/historical/live feeds, raw/normalized/canonical layers, timestamps, freshness, gaps, outliers, corrections, lineage, bitemporal history, replay, quarantine, storage tiers and vendor substitution.

### E3 — Quant Research & Backtesting
Cost-aware simulation, fees, spread, slippage, latency, market impact, walk-forward, OOS, Monte Carlo, sensitivity, multiple-testing controls, power/effect size, placebo/counterfactual tests, reproducibility and reality-gap measurement.

### E4 — Portfolio & Risk
Position sizing, portfolio heat, marginal risk, concentration, correlation/covariance stability, leverage, liquidity capacity, drawdown, stress, tail risk, capital reservation, turnover and deterministic Risk Gate.

### E5 — Execution
Paper execution first; venue abstraction; order lifecycle; partial fills; idempotency; outbox; unknown-state handling; routing; order-type semantics; protection verification; emergency flatten; realistic execution replay.

### E6 — Reconciliation
Broker/venue truth versus local truth; positions, orders, balances, fills, fees, settlement; mismatch history; automatic freeze; recovery verification.

### E7 — Journal & Trade Memory
Append-only/hash-chained records, thesis, evidence, counter-evidence, decision snapshots, MFE/MAE, loss autopsy, pre-order memory recall, strategy lifecycle and tamper-evident AI decisions.

### E8 — AI Research Brain
Technical, quantitative, orderflow, macro, news, derivatives, on-chain, sentiment, institutional flow, cross-asset, psychology and historical analogs; multi-agent debate and red-team challenge; calibrated uncertainty and abstention.

### E9 — Model Safety & Lifecycle
Model provenance, dependency graph, validation, shadow evaluation, champion/challenger, regime-conditioned trust, drift/decay, stability, freeze, rollback, retirement and independent validation.

### E10 — Market Intelligence
Macro, geopolitics, market structure, liquidity/funding stress, institutional flow, alternative data, prediction markets, psychology, energy/commodities and cross-asset networks.

### E11 — Reliability & Monitoring
Health states, telemetry completeness, silent failure, latency/backlog, early warning, alert state machines, SLO/error budgets, safe degradation, recovery drills, RTO/RPO and incident-to-test learning.

### E12 — Durability / Free-Safe-Permanent
Export everything, 3-2-1 backups, encrypted/offline copies, restore drills, Git mirrors, open formats, provider exit plans, cost ceilings and account-lockout recovery.

### E13 — Advanced Trading Intelligence
Options/Greeks/volatility, futures/funding/basis, microstructure, order book, smart money, on-chain, institutional research, prediction markets and advanced market structure.

### E14 — Governance & Human Safety
Compliance/time-aware rules, manipulation surveillance, privacy, human authorization, behavioral safeguards, restricted instruments/accounts, audit evidence and safe override policy.

## 4. Build phases

| Phase | Scope | Gate |
|---|---|---|
| 0 | Foundation, security, CI, contracts | secure deterministic baseline |
| 1 | Market-data foundation and quality | trusted/replayable data |
| 2 | Risk model + deterministic Risk Gate | no unsafe order path |
| 3 | Paper execution | realistic fills/costs |
| 4 | Reconciliation + journal | state can be proven |
| 5 | Backtesting + statistical validation | honest research certificate |
| 6 | AI Research Brain | explainable, bounded, abstaining AI |
| 7 | Model lifecycle + advanced intelligence | independent validation |
| 8 | Shadow trading | live-equivalent evidence |
| 9 | Controlled live unlock | explicit human approval + hard caps |
| 10 | Optimization | only after stable production evidence |

Live trading before Phase 9 is prohibited by roadmap design.

## 5. AI / probability contract

Never present an uncalibrated model score as a factual probability. A decision record should separate:
- opportunity score;
- calibrated probability, only when calibration evidence exists;
- uncertainty;
- sample size;
- evidence quality;
- data freshness;
- model disagreement;
- expected R:R;
- invalidation;
- dominant conflict.

**WAIT / REDUCE / NO TRADE are valid first-class outputs.**

## 6. Free, safe, durable design

Target $0/month, but never assume a provider will remain free.

Use local/open-source components where practical. Every external service gets:
- purpose;
- cost ceiling;
- dependency criticality;
- export path;
- replacement path;
- failure behavior.

Durability target:

```
Primary -> Local/Mirror -> Offsite -> Restore Verification
```

Backups are not considered complete until restore is periodically proven.

## 7. Promotion and safety gates

Paper -> validated -> shadow -> live request -> human approval -> limited live -> live.

Promotion requires evidence, not elapsed time.

Hard stops:
- unknown order state;
- reconciliation mismatch;
- critical data quality failure;
- stale critical input;
- risk-limit breach;
- venue/counterparty emergency;
- broken protection;
- security incident.

No withdrawals/transfers. Trade-only credentials wherever supported.

## 8. Research inventory policy

The prior research program contains approximately 1,900+ requirements/specifications. They are **not 1,900 software features**. They must be preserved as traceable research intent, consolidated into buildable capabilities, and assigned to an engine/phase/priority. Duplicates may be merged only when intent remains traceable.

Priority:
- **P0:** mandatory safety/foundation
- **P1:** required before paper
- **P2:** required before shadow/limited live
- **P3:** advanced intelligence
- **P4:** optional/future

The companion capability inventory is the source-of-truth appendix.

## 9. Definition of done for roadmap

The roadmap is complete when:
1. every recoverable research requirement has a traceable home;
2. no critical safety dependency is scheduled after the capability it protects;
3. live execution depends on paper, reconciliation and shadow evidence;
4. AI cannot bypass Risk Gate;
5. data and backups are portable;
6. external providers are replaceable;
7. future research is clearly separated from initial build scope;
8. implementation can proceed task-by-task without reopening architecture.

## 10. Next implementation order

After explicit approval:

1. Repository/Foundation
2. Data contracts/storage
3. Market-data quality
4. Risk model
5. Deterministic Risk Gate
6. Paper execution
7. Reconciliation
8. Journal/audit
9. Backtester
10. Portfolio engine
11. AI Research Brain
12. Model validation
13. Shadow trading
14. Controlled live

**No implementation should bypass this order without a documented dependency reason.**

> NOT FINANCIAL ADVICE. Trading involves substantial risk of loss.
