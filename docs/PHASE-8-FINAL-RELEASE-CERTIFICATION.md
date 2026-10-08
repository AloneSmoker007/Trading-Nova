# Phase 8 — Final Release Certification

## Release decision

Trading-Nova is certified for its current **personal paper/shadow release only** after the Phase 1–7 evidence gates and the Phase 8 regression gate pass.

## Required gates

- Market-data truth/evidence: PASS
- Test & CI certification: PASS
- Recovery & backup drill: PASS
- Real market-data soak: PASS
- Stress & capacity evidence: PASS
- Security final gate: PASS
- Paper/shadow certification: PASS
- Phase 8 release regression: PASS

## Current release boundary

- Execution mode: paper only.
- Real-money execution: blocked.
- Broker/exchange credentials: not required and not enabled.
- Withdrawals/transfers: unavailable.
- Risk Gate: mandatory for paper execution.
- Fresh critical market data: required for new paper orders.
- Idempotency and durable paper state: required.
- Reconciliation: required for a successful paper fill.
- Security headers, route/method allowlists, request-size cap, secret scan and order rate limiting remain enabled.

## What this certification does NOT prove

It does not prove profitability, investment performance, production Internet exposure, or independent third-party penetration-test results. The security gate remains fail-closed for any future live-money activation until genuine external security evidence and explicit human approval exist.

## Final operational rule

Do not enable live trading merely because this release is certified. Any future live-trading work is a separate gated project requiring new external market/broker evidence, security review, risk review, and explicit human approval.

**Release status: PAPER/SHADOW READY. REAL MONEY OFF.**
