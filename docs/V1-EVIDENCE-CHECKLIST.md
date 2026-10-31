# V1 Evidence Checklist

One page, nine gates. A gate is closed only when its record in `evidence/` has
`result: "PASS"` **and** every field below. Hand-typed PASS is rejected by
`npm run evidence:validate`.

| # | Gate id | Record these exact fields | Artifact to store |
|---|---|---|---|
| 1 | `postgres-production` | `serverVersion`, `restoreVerified: true` | migration log + `SHOW server_version` |
| 2 | `backup-restore-rto-rpo` | `rtoMs`, `rpoMs` (measured, > 0) | `npm run recovery:drill` output + backup digest |
| 3 | `market-data-soak` | `soakDurationMs`, `maxGapMs` | soak log with reconnect + gap timeline |
| 4 | `observability` | `scrapeIntervalMs`, `alertDeliveryVerified: true` | dashboard export + delivered alert receipt |
| 5 | `security-assurance` | `reportSha256` | independent assessment report |
| 6 | `capacity-load` | `peakRps`, `p95Ms` | load-test summary with percentile table |
| 7 | `paper-shadow` | `tradingDays`, `fillCount` | paper/shadow account statement |
| 8 | `master-traceability` | `capabilityCount` | capability → test → gate mapping |
| 9 | `human-approval` | `approver`, `approvalDate` | signed approval note |

Every PASS additionally needs `environment`, `timestamp`, `operator` (not the
tool name), `artifact`, and `artifactSha256` — the lowercase 64-hex digest of
the stored artifact.

## Check the pack

```
npm run evidence:validate -- --allow-incomplete   # exit 0, prints what is still missing
npm run evidence:validate                          # exit 1 until all nine PASS
```

## Rules

- A non-production host cannot certify. Set `EVIDENCE_REQUIRE_PRODUCTION=1`.
- BLOCKED is allowed and must carry `blockedReason`.
- Never record simulated, mocked, or rehearsed results as production evidence.
- Any measured number must come from the run that produced the artifact, not from a plan.
