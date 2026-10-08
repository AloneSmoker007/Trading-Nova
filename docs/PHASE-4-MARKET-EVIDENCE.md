# Phase 4 — Real Market-Data Evidence

## Scope

This phase validates the existing read-only market-data path against the public Binance REST API. It does not use exchange credentials and cannot place orders.

The opt-in soak checks, repeatedly:
- public BTCUSDT quote retrieval;
- recent 1-minute candle retrieval;
- bounded request timeout/retry/deadline behavior through the existing provider;
- candle continuity gaps;
- candle freshness;
- request latency;
- aggregate error rate.

## Certification command

Run locally or from the manual GitHub Actions workflow:

    MARKET_SOAK_DURATION_MS=120000 npm run market:soak

GitHub Actions exposes this as an opt-in workflow_dispatch input named run_market_soak.

## Fail-closed thresholds

Default evidence thresholds are:
- duration: 120 seconds;
- poll interval: 5 seconds;
- maximum error rate: 5%;
- maximum request latency: 2 seconds;
- maximum candle age: 120 seconds.

Any gap, stale candle, excessive latency, excessive error rate, or absence of a successful sample fails the evidence run.

## Safety

The probe uses public read-only market-data endpoints only. It does not require API keys, broker credentials, exchange credentials, order endpoints, or live-trading flags. noTradeRequired is always reported as true.

A passing run is evidence for the observed window only; it is not a permanent guarantee of exchange availability. Longer soak and multi-source evidence remain part of the later certification gates.