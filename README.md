# Trading Nova 🚀📈

**Personal AI trading copilot — built to be the most careful trading tool on GitHub.**

> Trade like the market is out to get you.

Trading Nova is an AI-first trading research, risk, and execution workspace for **one person who wants to learn to trade properly** — with the discipline of a risk desk, not the vibes of a casino.

## Why another trading bot? (We scanned the best first)

Before writing a line here, the landscape was audited — freqtrade (55k⭐), Hummingbot (20k⭐), Jesse, OctoBot, Superalgos, OpenAlice (7k⭐), TradeMemory, CloddsBot, ATLAS, nof1.ai, and more. Two clear gaps:

1. **Most bots are execution engines.** They assume you already know *what* to trade and *why*. Beginners lose money feeding them.
2. **AI-trading agents are fast, but their guardrails are thin.** TradeMemory's finding stands: broker caps are fixed numbers; almost nothing looks at *your own* losing history before the next order.

Trading Nova's bet: **the risk engine ships before the strategy engine, and the journal is a first-class feature — not a log file.**

| Stolen with love (proven ideas) | From |
|---|---|
| Dry-run / paper mode as the default, live as an unlock | freqtrade |
| Backtesting + walk-forward validation + hyperparameter discipline | freqtrade, Jesse |
| Thesis-driven research workspaces ("what would prove this wrong?") | OpenAlice |
| Scheduled research issues (morning scan, weekly macro review) | OpenAlice |
| Decision audit trail + "show me my losses before the next order" | TradeMemory |
| An order brake that can refuse trades breaking your rules | TradeMemory |
| Exchange/venue abstraction, fees + slippage modeled in backtests | Hummingbot, freqtrade |
| Strategy as data/config, versioned in git | Superalgos, freqtrade |

## Core principles

1. **Risk before returns.** Position sizing, max daily loss, max drawdown kill-switch — configured before a single strategy exists.
2. **Paper before real.** Live trading is a feature you *earn* after the paper track record proves the rules.
3. **Every order has a reason.** No order without a thesis entry: thesis → signal → risk check → execution → outcome review.
4. **The bot must explain itself.** "Why did you buy?" must always have a human-readable answer.
5. **Memory of pain.** Losing patterns get recalled before new orders; size-tilting after losses is flagged automatically.
6. **Costs are real.** Fees, spread, and slippage are modeled everywhere — backtests that ignore them are fiction.
7. **Keys stay safe.** Exchange API keys: trade-only, withdrawal disabled, encrypted at rest, never in git. Ever.
8. **Boring ops.** Deterministic jobs, idempotent order handling, crash-safe state (outbox pattern), audited releases.

## Architecture (target)

```
 Market Data ──► Research/Thesis ──► Strategy Signals
      │                                    │
      ▼                                    ▼
  Data Quality ◄─────────────── Risk Gate (hard rules)
  (gaps/outliers)                     │
                                      ▼
                          Execution Router
                        (paper │ live[unlocked])
                                      │
                                      ▼
                     Journal + Trade Memory (append-only)
                                      │
                                      ▼
                     Review Loop (stats → thesis → rules)
```

## Safety & disclaimer

- **This is not financial advice.** Nothing in this repository is investment advice. Trading involves substantial risk of loss.
- Default mode is **paper trading**. Live mode requires explicit opt-in and hard risk limits.
- No feature will ever auto-withdraw, transfer, or convert funds.
- API keys are stored encrypted, scoped trade-only, and are never committed (enforced by secret scanning in CI).

## Repo map

```
Trading-Nova/
├── README.md          ← you are here
├── TASK.md            ← phased roadmap + acceptance criteria
├── SECURITY.md        ← key handling + threat model
├── docs/
│   └── PRO-TIPS.md    ← landscape scan: what the best do, what we do better
└── ... (code lands from TASK.md Phase 0)
```

## Status

🐣 Pre-build. Landscape scan complete (see `docs/PRO-TIPS.md`). Phase 0 scaffolding next — see `TASK.md`.
