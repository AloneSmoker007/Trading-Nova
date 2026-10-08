# Phase 7 — Paper/Shadow Certification

## Scope

Phase 7 certifies the existing paper execution path using deterministic automated evidence. It does not enable live trading, exchange credentials, withdrawals, transfers, or real-money execution.

## Certified evidence

The Phase 7 regression suite verifies:

1. A fresh market-data paper order can pass the deterministic Risk Gate and produce a RECONCILED paper fill.
2. Replaying the same idempotency key returns the original fill and does not create a second position.
3. Reusing an idempotency key with changed intent is rejected.
4. Stale critical market data fails closed with STALE_CRITICAL_DATA.
5. Position-notional limits reject an oversized paper order.
6. Paper order state survives a service restart and replays idempotently from durable state.

## Safety boundary

- Execution is paper-only.
- Risk Gate remains the only execution permit.
- Real market data is required to be fresh for a new order.
- Durable paper state is persisted atomically.
- Reconciliation is required for a successful paper fill.
- No exchange/broker credentials are used.
- No live-money activation is performed.

## Certification boundary

This is an automated paper/shadow certification, not a guarantee of profitable trading and not an independent third-party audit. A future live-trading gate would require separate external evidence and explicit human approval.

**Real money remains OFF.**
