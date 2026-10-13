# Private hosting: single-owner demo

Trading-Nova is paper-only. This deployment mode is intended for one owner, with every dashboard asset and API endpoint behind a password session.

## Required host environment

Set these in the hosting provider's **runtime environment settings**, not in source files:

- `NODE_ENV=production`
- `NOVA_ACCESS_PASSWORD`: a unique password of at least 12 characters. Use a password manager; do not commit it or paste it into chat.
- `NOVA_SESSION_SECRET`: at least 32 random bytes of secret material. Generate it with a trusted password manager or secret generator.
- `POSTGRES_URL`: the Neon PostgreSQL connection string, stored as a secret.
- `GEMINI_API_KEY`: the Gemini key stored as a secret in the hosting provider. A GitHub Actions repository secret is **not** automatically available to the deployed application.
- `GEMINI_MODEL`: optional; set to a model available to the key/account (the example defaults to `gemini-2.5-flash`).
- `GEMINI_WEB_RESEARCH`: optional; defaults to enabled. Set to `false` or `0` to disable Google Search grounding for tutor responses. The model may not return citations for every question, so answers without returned source links must not be represented as verified current research. Grounding requests are subject to the Google AI project’s applicable quota and billing rules.

The browser chart also connects directly to Binance's public read-only kline WebSocket for display-only live candle updates. This connection needs outbound `wss://stream.binance.com:9443` from the user's browser. Stream data never submits orders or bypasses the server-side quote freshness checks/Risk Gate; when the stream is blocked or unavailable the UI shows a reconnect/fallback state and REST snapshots remain available.

The server refuses production startup if the access password, session secret, or PostgreSQL URL is missing. In production it binds to `0.0.0.0` as required by common web hosts; local non-production use remains loopback-only.

## Access behavior

- There is one shared owner password and no public signup.
- Dashboard files and all `/api/*` endpoints require a valid signed, expiring session, except the login endpoint.
- Session cookie is HttpOnly, SameSite=Strict, and Secure in production.
- Password attempts are rate-limited per source IP.
- Rotating `NOVA_SESSION_SECRET` invalidates existing sessions.
- Use a private/secret URL only as obscurity, never as the security control.

## Before deploying

1. Run the full GitHub Actions suite on this branch and resolve failures.
2. Verify the Neon connection, migrations, and persistence across a restart using a non-production test account/data set.
3. With `POSTGRES_URL` configured, journal entries now use the PostgreSQL `paper-journal` state record and verify the hash chain before appending. Local non-database mode still uses the local state file. The suite includes a real-PostgreSQL recovery test that reconnects with a fresh store; confirm that test passes on the current PR before deployment. Do not treat this as a substitute for a production backup/restore drill.
4. Configure runtime secrets in the hosting dashboard; never add their values to GitHub files, issues, logs, or screenshots.
5. Confirm unauthenticated requests to both `/` and sensitive API routes are blocked before sharing the URL.

A password gate protects the app even though its hosting URL may be reachable from the internet. It does not make the URL network-private; use an identity-aware private network layer if you later require that stronger property.
