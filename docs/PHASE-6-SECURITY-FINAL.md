# Phase 6 — Security Final Gate

## Scope

Phase 6 hardens the current **paper-only localhost server** and adds regression evidence for the security boundary. It does not enable live trading, exchange connectivity, withdrawals, transfers, or credentials.

## Controls verified

- Server construction rejects `shadow`, `limited-live`, and `live` modes. The web execution surface is explicitly paper-only.
- The API always constructs its execution service in `paper` mode.
- Paper-order POST requests have a bounded per-client token bucket: 30 burst requests, refilling at 0.5 requests/second.
- Rate limiting occurs before request-body parsing, reducing abuse against the order endpoint.
- Existing 16 KiB request-body cap remains enforced.
- Existing strict security headers, no-store API responses, route/method allowlists, generic error responses, static path allowlisting, secret-free responses, Risk Gate enforcement, idempotency, and loopback binding remain in force.
- Existing repository secret scanning remains a CI gate.
- Existing fail-closed Risk Gate and AI trust controls remain unchanged.

## Automated acceptance

`npm test` must pass, `npm run lint` must pass, and `npm run security:secrets` must pass.

The new `tests/ws-e-security-final.test.js` covers:

1. Non-paper server modes are rejected.
2. Paper-order abuse is rate-limited.
3. The limiter recovers after refill.
4. Read-only health traffic is unaffected.

## Certification boundary

This phase provides **automated security hardening evidence**. It does **not** claim an independent penetration test or third-party security assessment. Therefore the repository's existing `securityAuditGate` must continue to fail closed until genuine penetration-test evidence is supplied.

**Live money remains blocked.**