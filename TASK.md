# Trading Nova — Task / Roadmap

## Objective
Build the most careful personal AI trading copilot on GitHub: research → thesis →
risk-gated execution → honest journal → review loop. Paper-first. The founder
does not trade yet, so the product must teach while it protects.

## Acceptance criteria

### Phase 0 — Foundation (current)
- [ ] Repo scaffold: config, logging, CI (lint + tests + secret scanning)
- [ ] Data layer: candle fetch (public API), storage, gap/outlier checks
- [ ] Risk limits model: max position size, max daily loss, max drawdown kill-switch — REQUIRED before any order path exists
- [ ] Paper trading engine skeleton (fills simulated with fees + slippage)
- [ ] Append-only journal (hash-chained entries) — every order/thesis/outcome recorded
- [ ] `NOT FINANCIAL ADVICE` disclaimer present in README and every report output

### Phase 1 — Learn & Prove
- [ ] Backtester with costs (fees/spread/slippage), in-sample vs out-of-sample reporting
- [ ] Walk-forward validation harness
- [ ] Thesis documents: create/link/falsify, linked to trades
- [ ] Scheduled research jobs (morning scan, weekly macro review)
- [ ] Loss Autopsy report: where MY history loses money (patterns: size-tilting, revenge trades, hold-time asymmetry)
- [ ] Pre-order memory recall (losses shown before new orders)

### Phase 2 — Risk-Gated Execution
- [ ] Risk Gate as hard code path (can refuse orders; rules in config, versioned)
- [ ] Venue abstraction (one exchange connector interface)
- [ ] Live mode unlock: explicit opt-in + hard caps + kill switch tested by drill
- [ ] Order idempotency + crash-safe outbox pattern
- [ ] Alerting (Telegram/notifications) for orders, refusals, kill-switch events

### Phase 3 — AI Layer (earned, not bolted on)
- [ ] AI research assistant over market data + journal (explainable outputs)
- [ ] "Why did you buy?" — every AI signal carries a plain-language rationale
- [ ] AI suggestions always pass through the same Risk Gate as human ones
- [ ] Tamper-evident audit of AI decisions (who/what/why/when)

## Workflow
1. Requirements + risk rules first (written before code).
2. Implement with meaningful tests (real logic, no assertion theatre).
3. Verify on paper track record before any live consideration.
4. Audited releases: green CI ≠ signed-off product.

## Notes for whoever picks this up next
- **Never** commit API keys. `.gitignore` + CI secret scanning enforce it.
- Strategy code must never call exchange SDKs directly — venue abstraction only.
- The Risk Gate must sit BETWEEN signal and execution in code structure, so it
  cannot be "accidentally" bypassed by a new strategy.
- Backtests that ignore fees/slippage will be rejected in review.
