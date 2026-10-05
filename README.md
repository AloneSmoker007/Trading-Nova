# Trading Nova 🚀📈

**Personal AI trading copilot — built to be the most careful trading tool on GitHub.**

> Trade like the market is out to get you.

Trading Nova is a risk-first personal AI trading research and paper-execution workspace.

## Current status

**Task 1 — Foundation & Architecture Contracts** is implemented on branch `feat/task-1-foundation`.

The authoritative build plan is [docs/TRADING-NOVA-MASTER-ROADMAP.md](docs/TRADING-NOVA-MASTER-ROADMAP.md).

This stage deliberately contains **no exchange SDK, no live-money execution path, and no broad AI trading engine**. The default execution mode is paper.

## Core principles

1. **Risk before returns.**
2. **Paper before real.**
3. **Every order has a thesis and evidence.**
4. **Opportunity Score is not probability.**
5. **Costs, uncertainty and failure states are explicit.**
6. **No secrets in git.**
7. **AI never bypasses deterministic safety controls.**

## Safety & disclaimer

**NOT FINANCIAL ADVICE.** Nothing in this repository is investment advice. Trading involves substantial risk of loss.

- Default mode is **paper trading**.
- No feature will withdraw, transfer or convert funds.
- Live trading is not implemented in Task 1.

## Repo map

```
Trading-Nova/
├── README.md
├── TASK.md
├── SECURITY.md
├── docs/
│   ├── TRADING-NOVA-MASTER-ROADMAP.md
│   └── PRO-TIPS.md
├── src/
│   ├── config.js
│   ├── logger.js
│   ├── contracts/
│   └── security/
├── scripts/
├── tests/
└── .github/workflows/ci.yml
```
