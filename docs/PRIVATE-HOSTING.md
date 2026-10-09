# Private hosting: single-owner demo

Trading-Nova is paper-only. This deployment mode is intended for one owner, with every dashboard asset and API endpoint behind a password session.

## Required host environment

Set these in the hosting provider's **runtime environment settings**, not in source files:

- `NODE_ENV=production`
- `NOVA_ACCESS_PASSWORD`: a unique password of at least 12 characters. Use a password manager; do not commit it or paste it into chat.
- `NOVA_SESSION_SECRET`: at least 32 random bytes of secret material. Generate it with a trusted password manager or secret generator.
- `POSTGRES_URL`: the Neon PostgreSQL connection string, stored as a secret.
- `GEMINI_API_KEY`: the Gemini key stored as a secret in the hosting provider. A GitHub Actions repository secret is **not** automatically available to the deployed application.
- `GEMINI_MODEL`: optional; set to a model available to the key/account.

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
3. Audit every persisted feature. The current journal snapshot code still uses the local state file, so journal persistence across a free host restart is **not yet certified** even though paper-order storage can use PostgreSQL. Do not claim all data is durable until that path is migrated and tested.
4. Configure runtime secrets in the hosting dashboard; never add their values to GitHub files, issues, logs, or screenshots.
5. Confirm unauthenticated requests to both `/` and sensitive API routes are blocked before sharing the URL.

A password gate protects the app even though its hosting URL may be reachable from the internet. It does not make the URL network-private; use an identity-aware private network layer if you later require that stronger property.
