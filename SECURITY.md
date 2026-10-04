# Security Policy — Trading Nova

## Key handling (non-negotiable)
- Exchange API keys are **trade-only**. Withdrawal/transfer permissions must be disabled at the exchange.
- Keys are stored **encrypted at rest** (or in an OS keychain / env file outside the repo), never in git.
- CI runs secret scanning; a leaked key is rotated immediately and the history is scrubbed.
- No feature will ever withdraw, transfer, or convert funds.

## Threat model (short)
- **Repo leak** → keys must be useless (trade-only + encrypted + scoped IP where possible).
- **Bug in strategy code** → Risk Gate caps size/loss; kill switch stops all trading.
- **Crash mid-order** → idempotent order handling + outbox pattern prevents duplicates.
- **Model/AI misjudgment** → AI output passes the same Risk Gate as human orders; every decision journaled and explainable.
- **Self-deception** → append-only, hash-chained journal; history cannot be quietly edited.

## Reporting
Found a security issue? Open a private security advisory on this repository.
