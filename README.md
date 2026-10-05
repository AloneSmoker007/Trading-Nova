# Trading Nova 🚀📈

**Risk-first personal AI trading research and paper-execution workspace.**

## Current status
**Task 2 — Market Data & Truth Layer** is implemented on branch `feat/task-2-market-data`.

Authoritative build plan: [docs/TRADING-NOVA-MASTER-ROADMAP.md](docs/TRADING-NOVA-MASTER-ROADMAP.md).

Task 2 adds canonical market-data validation, source trust, freshness checks, gap detection, a deterministic Data Quality Gate, and point-in-time replay primitives. It still has **no exchange SDK and no live-money execution path**.

## Principles
- Risk before returns.
- Paper before real.
- Opportunity score is not probability.
- Stale, invalid, gapped or untrusted critical data must stop downstream decisions.
- AI never bypasses deterministic safety controls.

**NOT FINANCIAL ADVICE.** Trading involves substantial risk of loss.
