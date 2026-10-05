# Trading Nova — Capability Inventory

This document is the traceability appendix for the Trading Nova Master Roadmap.

## Important accounting rule

The historical research program was described as approximately **1,900+ individual research specifications** across multiple ecosystem scans. The repository did not contain a machine-readable copy of those raw 1,900+ lines at the time this inventory was reconstructed. Therefore this document **does not fabricate an exact 1,900+ count**.

Instead, it preserves every research capability that was recoverable from the existing project/roadmap research record, grouped into implementation capabilities. The raw research should be restored into this inventory if/when its source artifact becomes available.

A consolidated capability is allowed to cover many research points; it must not erase their intent.

## Traceability fields

Each row uses:

**ID | Capability | Engine | Phase | Priority | Safety**

### Foundation / Security
- FND-01 | secure configuration and secret isolation | E1 | 0 | P0 | Yes
- FND-02 | capability/permission model | E1 | 0 | P0 | Yes
- FND-03 | CI lint/test/secret scanning | E1 | 0 | P0 | Yes
- FND-04 | dependency trust, lockfile and provenance | E1 | 0 | P0 | Yes
- FND-05 | artifact/build isolation and reproducibility | E1 | 0 | P1 | Yes
- FND-06 | egress/DNS/tool capability controls | E1 | 0 | P1 | Yes
- FND-07 | audit trail and immutable safety events | E1 | 0 | P0 | Yes
- FND-08 | break-glass, kill switch and recovery controls | E1 | 0 | P0 | Yes

### Market Data
- DAT-01 | source registry and trust weighting | E2 | 1 | P0 | Yes
- DAT-02 | raw/normalized/canonical data layers | E2 | 1 | P0 | Yes
- DAT-03 | freshness/timestamp/clock confidence | E2 | 1 | P0 | Yes
- DAT-04 | gap/outlier/corruption detection | E2 | 1 | P0 | Yes
- DAT-05 | lineage and bitemporal history | E2 | 1 | P1 | No
- DAT-06 | correction/revision replay and blast radius | E2 | 1 | P1 | Yes
- DAT-07 | quarantine and source substitution | E2 | 1 | P0 | Yes
- DAT-08 | deterministic replay/time-machine data | E2 | 1 | P1 | No
- DAT-09 | vendor disagreement/consensus | E2 | 1 | P1 | No
- DAT-10 | backpressure/storage tiers/cost-aware routing | E2 | 1 | P2 | No

### Quant / Backtesting
- QNT-01 | realistic fees/spread/slippage | E3 | 5 | P1 | Yes
- QNT-02 | latency/fill/impact uncertainty | E3 | 5 | P1 | Yes
- QNT-03 | event-ordering and deterministic replay | E3 | 5 | P1 | Yes
- QNT-04 | in-sample/out-of-sample validation | E3 | 5 | P1 | No
- QNT-05 | walk-forward testing | E3 | 5 | P1 | No
- QNT-06 | Monte Carlo/sensitivity/stress | E3 | 5 | P1 | No
- QNT-07 | multiple-testing/FWER/FDR controls | E3 | 5 | P1 | No
- QNT-08 | effect size/MDE/power/confidence intervals | E3 | 5 | P1 | No
- QNT-09 | placebo/counterfactual/negative evidence | E3 | 5 | P1 | No
- QNT-10 | synthetic/adversarial/rare-event simulation | E3 | 5 | P2 | Yes
- QNT-11 | backtest-to-live equivalence certificate | E3 | 5 | P2 | Yes
- QNT-12 | reality-gap and paper/live divergence | E3 | 8 | P2 | Yes

### Portfolio / Risk
- RSK-01 | position sizing | E4 | 2 | P0 | Yes
- RSK-02 | portfolio heat and marginal risk | E4 | 2 | P0 | Yes
- RSK-03 | daily loss/drawdown kill switch | E4 | 2 | P0 | Yes
- RSK-04 | concentration/correlation risk | E4 | 2 | P1 | Yes
- RSK-05 | covariance/factor stability | E4 | 2 | P1 | No
- RSK-06 | liquidity/capacity/impact limits | E4 | 2 | P1 | Yes
- RSK-07 | leverage/margin/collateral stress | E4 | 2 | P1 | Yes
- RSK-08 | tail/stress/contagion risk | E4 | 2 | P2 | Yes
- RSK-09 | capital reservation and signal conflict | E4 | 2 | P2 | No
- RSK-10 | deterministic Risk Gate | E4 | 2 | P0 | Yes

### Execution / Reconciliation
- EXE-01 | venue abstraction/capability contract | E5 | 3 | P1 | Yes
- EXE-02 | paper fills and realistic execution costs | E5 | 3 | P1 | Yes
- EXE-03 | order lifecycle and idempotency | E5 | 3 | P0 | Yes
- EXE-04 | unknown-state/no-blind-retry handling | E5 | 3 | P0 | Yes
- EXE-05 | partial-fill/protection semantics | E5 | 3 | P1 | Yes
- EXE-06 | routing/health/circuit breaker | E5 | 3 | P2 | Yes
- EXE-07 | emergency flatten/freeze | E5 | 3 | P0 | Yes
- REC-01 | broker-vs-local truth reconciliation | E6 | 4 | P0 | Yes
- REC-02 | position/order/balance/fill/fee reconciliation | E6 | 4 | P0 | Yes
- REC-03 | mismatch history and recovery verification | E6 | 4 | P1 | Yes
- REC-04 | automatic trading freeze on unresolved mismatch | E6 | 4 | P0 | Yes

### Journal / Memory
- MEM-01 | append-only journal | E7 | 4 | P0 | Yes
- MEM-02 | hash-chain/tamper evidence | E7 | 4 | P0 | Yes
- MEM-03 | thesis/falsification/evidence ledger | E7 | 4 | P1 | No
- MEM-04 | counter-evidence and decision snapshot | E7 | 4 | P1 | No
- MEM-05 | loss autopsy and behavioral pattern detection | E7 | 4 | P1 | Yes
- MEM-06 | pre-order loss recall | E7 | 4 | P1 | Yes
- MEM-07 | strategy lifecycle/learning ledger | E7 | 5 | P2 | No

### AI / Model Safety
- AI-01 | multi-domain research council | E8 | 6 | P2 | No
- AI-02 | evidence/counter-evidence synthesis | E8 | 6 | P2 | No
- AI-03 | debate/red-team challenge | E8 | 6 | P2 | Yes
- AI-04 | source independence and evidence fusion | E8 | 6 | P2 | Yes
- AI-05 | calibrated probability and uncertainty | E8 | 6 | P2 | Yes
- AI-06 | abstention/WAIT/NO-TRADE | E8 | 6 | P1 | Yes
- AI-07 | model provenance/versioning | E9 | 7 | P2 | Yes
- AI-08 | champion/challenger/shadow evaluation | E9 | 7 | P3 | No
- AI-09 | drift/decay/regime-conditioned trust | E9 | 7 | P2 | Yes
- AI-10 | model freeze/rollback/retirement | E9 | 7 | P1 | Yes
- AI-11 | agent identity/capability isolation | E9 | 6 | P1 | Yes
- AI-12 | tool-output quarantine/taint tracking | E9 | 6 | P2 | Yes

### Market Intelligence
- INT-01 | regime/state/transition detection | E10 | 6 | P2 | No
- INT-02 | macro surprise/revision/policy path | E10 | 6 | P2 | No
- INT-03 | news event fingerprint/novelty/half-life | E10 | 6 | P2 | No
- INT-04 | social attention/bot/coordinated activity | E10 | 6 | P3 | Yes
- INT-05 | institutional flow/parent-order intelligence | E10 | 6 | P3 | No
- INT-06 | derivatives/volatility positioning | E13 | 7 | P3 | No
- INT-07 | on-chain/entity/whale intelligence | E13 | 7 | P3 | Yes
- INT-08 | prediction-market probability intelligence | E13 | 7 | P3 | No
- INT-09 | cross-asset connectedness/contagion | E10 | 7 | P2 | Yes
- INT-10 | market psychology/herding/cascade detection | E10 | 7 | P3 | Yes
- INT-11 | manipulation/adversarial market behavior | E10 | 7 | P2 | Yes
- INT-12 | liquidity/funding/leverage stress | E10 | 7 | P2 | Yes
- INT-13 | geopolitical/supply-chain shock graph | E10 | 7 | P3 | Yes
- INT-14 | energy/commodity physical confirmation | E10 | 7 | P3 | No

### Reliability / Durability
- REL-01 | health state machine and heartbeats | E11 | 0 | P0 | Yes
- REL-02 | silent failure/telemetry completeness | E11 | 0 | P0 | Yes
- REL-03 | queue/backpressure/drop monitoring | E11 | 0 | P1 | Yes
- REL-04 | recovery drills/RTO/RPO | E11 | 0 | P1 | Yes
- REL-05 | incident timeline and incident-to-test learning | E11 | 0 | P2 | No
- DUR-01 | one-command export everything | E12 | 0 | P1 | Yes
- DUR-02 | encrypted 3-2-1 backups | E12 | 0 | P0 | Yes
- DUR-03 | restore verification | E12 | 0 | P0 | Yes
- DUR-04 | Git mirror/provider exit plan | E12 | 0 | P1 | Yes
- DUR-05 | open-format migration | E12 | 0 | P1 | No
- DUR-06 | cost ceilings/billing protection | E12 | 0 | P1 | Yes
- DUR-07 | offline recovery material | E12 | 0 | P1 | Yes

### Governance / Human Safety
- GOV-01 | time-aware compliance/rule state | E14 | 10 | P3 | Yes
- GOV-02 | manipulation surveillance | E14 | 7 | P2 | Yes
- GOV-03 | human authorization and override audit | E14 | 9 | P0 | Yes
- GOV-04 | behavioral safety/cooldowns | E14 | 9 | P1 | Yes
- GOV-05 | privacy/data retention/access | E14 | 0 | P1 | Yes
- GOV-06 | AI decision record and change impact | E14 | 6 | P1 | Yes

## Research-domain coverage map

The historical scans are preserved by domain rather than discarded:

1. Quant/trading engines
2. Market-data infrastructure
3. Exchanges/brokers/execution APIs
4. HFT/microstructure
5. Options/futures/derivatives
6. On-chain/whale/smart money
7. News/macro/social/OSINT
8. AI agents/multi-agent/MCP
9. Quant research/statistics
10. Portfolio/allocation/risk
11. Observability/DevOps/reliability
12. Security/adversarial infrastructure/supply chain
13. Data providers/vendors
14. Alternative data/fundamentals/filings/corporate intelligence
15. Trading psychology/human-in-loop
16. Broker/exchange ecosystem
17. Backtesting/simulation/reality gap
18. Compliance/regulation/audit/tax/legal
19. Security research/OSINT/threat intelligence
20. Market structure/auction/price formation
21. Institutional/smart-money/flow intelligence
22. Prediction markets/alternative probability
23. Institutional research/sell-side
24. Alternative sentiment/attention/search
25. Macro/economic regime
26. Market psychology/behavioral finance
27. Market manipulation/adversarial behavior
28. Cross-asset/intermarket intelligence
29. Geopolitical/conflict/sovereign risk
30. Liquidity/funding/leverage stress
31. AI trading model risk/lifecycle
32. Real-time monitoring/early warning
33. Counterparty/credit/default
34. Energy/commodities/physical supply

### Consolidation rule

These domain inventories are **research coverage**, not separate products. Multiple research points can map to one capability. No capability may bypass the Risk Gate, reconciliation, security, or durability controls.

## Current status

**Research/roadmap only. No implementation implied by this inventory.**
