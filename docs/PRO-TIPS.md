# Trading Nova — Landscape Scan & Pro Tips (2026-10-04)

Scanned before building: what the best GitHub trading projects do, what they
lack, and the rules Trading Nova will follow to be better.

## The scanned lineup

| Project | Stars | What it does best | What it lacks |
|---|---|---|---|
| freqtrade/freqtrade | 55k | Dry-run mode, backtesting, hyperopt, protections, strategy interface, huge community | Execution-first; no thesis/journal layer; beginner can still bleed |
| hummingbot/hummingbot | 20k | Market making, connectors, venue abstraction, professional execution | Quant-desk orientation; assumes you know what you're doing |
| jesse-ai/jesse | 8.6k | Clean strategy API, backtesting, candles/indicators | Thin risk-memory; no order-brake concept |
| Drakkar-Software/OctoBot | 6.7k | Grid/DCA/TradingView automation, simple UI | Strategy depth limited; AI is bolted on |
| Superalgos/Superalgos | 5.7k | Visual strategy design, data-mining, multi-server | Heavy/complex; steep learning curve |
| TraderAlice/OpenAlice | 7.2k | **Thesis workspaces**, scheduled research issues, "what proves this wrong", multi-agent | Research-first; light on hard execution risk rails |
| mnemox-ai/tradememory-protocol | 1.4k | **Decision audit trail**, recall losses before orders, tamper-evident memory, order brake | Memory/brake only; no full trading stack |
| alsk1992/CloddsBot | 2.9k | Multi-market autonomous scanning, instant execution | Autonomy-first — the risk posture we will NOT copy |
| chrisworsey55/atlas-gic | 2.3k | Self-improving agent research loop | Research-heavy, opaque risk model |
| hummingbot/condor | 217 | Harness for managing AI trading agents | Harness only |

## The 10 pro rules extracted (and how Trading Nova applies them)

1. **Paper/dry-run must be the DEFAULT** (freqtrade lesson). → Trading Nova boots in paper mode; live is an unlockable with hard caps.
2. **Backtest honesty:** fees + slippage + funding modeled; walk-forward validation; no in-sample fairy tales (freqtrade/Jesse). → All backtests include costs; reports show in-sample vs out-of-sample split.
3. **Thesis before ticker** (OpenAlice). → Every trade must reference a thesis document with a falsification condition ("what proves this wrong").
4. **Scheduled research beats reactive trading** (OpenAlice Issues). → Morning scan / weekly macro review jobs; you act on plans, not on feelings.
5. **Remember your losses before the next order** (TradeMemory). → Trade memory store: recent losers, patterns (size-tilting after losses, revenge trades), recalled pre-order.
6. **An order brake that can say NO** (TradeMemory). → Risk Gate is a hard code path between strategy and execution — not a suggestion.
7. **Tamper-evident journal** (TradeMemory). → Append-only journal with hash chaining; you cannot quietly edit your own history to feel better.
8. **Costs modeled everywhere** (Hummingbot/freqtrade). → Backtest engine simulates maker/taker fees, spread, and slippage by liquidity assumption.
9. **Venue abstraction** (Hummingbot). → Exchange connectors behind one interface; strategies never touch raw exchange SDKs.
10. **Ops discipline** (all mature projects): idempotent order handling, crash-safe workers, secret hygiene, audited releases. → Outbox pattern for orders, kill switch, secret scanning in CI.

## What we will have that nobody else does

- **Beginner-native mode**: the product is designed for its founder, who does not trade yet. Everything is explained in plain language first, jargon second. A "learn view" alongside every action.
- **Risk-first onboarding**: you cannot place an order until risk limits are set. The first screen is the risk screen.
- **The Loss Autopsy**: weekly automated report — where *your* history loses money (TradeMemory's killer idea, made the centerpiece).
- **One-person scope**: no multi-tenant SaaS complexity. Simplicity is the feature.

## Anti-patterns we will NOT copy

- Autonomy-first execution with thin guardrails (CloddsBot posture).
- Backtests without costs.
- "Win rate" vanity stats without R-multiples and drawdown context.
- Hiding drawdowns behind smooth equity-curve screenshots.
- Storing exchange keys in plaintext or in repos.

## Tooling stack recommendations (from ecosystem norms)

- Python for research/backtest core (ecosystem standard), TypeScript for UI if needed later
- SQLite/Postgres for journal + market data; Parquet for candles
- ccxt (or equivalent) for venue abstraction
- GitHub Actions CI: lint + tests + secret scanning + backtest reproducibility check
- Deterministic job runner for scheduled scans; everything idempotent
