# Phase 5 — Stress & Capacity

## Goal

Evidence that the local paper/shadow HTTP surface remains stable under bounded sustained load. This is a capacity test, not a live-trading test.

## Protocol

The stress harness:
- targets only an explicitly supplied HTTP URL;
- uses bounded concurrency and a target request rate;
- enforces per-request timeouts;
- records p50/p95/p99 latency, errors, achieved RPS and in-flight concurrency;
- records process RSS before and after the run to detect obvious memory growth;
- fails closed on excessive errors, p95 latency, or RSS growth.

Default certification profile:
- 30 seconds;
- 100 requests/second target;
- 20 concurrent requests;
- 5 second request timeout;
- <=1% errors;
- <=500ms p95;
- <=128MB RSS growth.

The profile is intentionally bounded so certification cannot accidentally become an unbounded denial-of-service generator.

## CI evidence

CI starts the loopback-only Trading-Nova server and runs three read-only profiles:
1. `/api/health`
2. `/api/portfolio`
3. `/api/journal`

No exchange credentials, broker credentials, order endpoint, external market-data load, or live-money capability is used.

A passing Phase 5 result is evidence for the tested host, build, workload and time window. It does not certify arbitrary production infrastructure, database capacity, or exchange-side limits.

## Certification boundary

Phase 5 PASS means the bounded local read-only surface has demonstrated the configured capacity target without violating the safety thresholds. It does **not** authorize live trading.

