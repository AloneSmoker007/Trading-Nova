#!/usr/bin/env node
// server/index.js — entry point for the local Trading-Nova dashboard server.
//
// Loopback ONLY (127.0.0.1), read-only, paper/shadow only — real money OFF.
// Port: NOVA_PORT or PORT env var, default 7411 (0 = ephemeral).
//
//   npm run serve          # start the server
//   open http://127.0.0.1:7411/
//
// The server exposes the dashboard, read API and Risk-Gate-protected paper orders.

import {readConfig} from "../src/config.js";
import {createPostgresStore} from "../src/persistence/postgres.js";
import {createNovaServer} from "./app.js";
import {validatePrivateAccessConfig} from "./access-guard.js";

function parsePort(raw) {
  if (raw === undefined || raw === "") return 7411;
  const text = String(raw);
  if (!/^\d{1,5}$/.test(text)) {
    console.error("Invalid port:", text);
    process.exit(2);
  }
  const port = Number(text);
  if (port > 65535) {
    console.error("Invalid port:", text);
    process.exit(2);
  }
  return port;
}

const production = process.env.NODE_ENV === "production";
if (production) {
  try {
    validatePrivateAccessConfig({password: process.env.NOVA_ACCESS_PASSWORD, secret: process.env.NOVA_SESSION_SECRET});
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (!process.env.POSTGRES_URL) {
    console.error("POSTGRES_URL is required in hosted production; local-file persistence is disabled.");
    process.exit(1);
  }
}
const config = readConfig();
const port = parsePort(process.env.NOVA_PORT ?? process.env.PORT);
const host = production ? "0.0.0.0" : "127.0.0.1";

let store;
let startupFailed = false;
try {
  if (process.env.POSTGRES_URL !== undefined) {
    store = await createPostgresStore({
      connectionString: process.env.POSTGRES_URL,
      schema: process.env.TRADING_NOVA_DB_SCHEMA
    });
    if (!(await store.health())) throw new Error("database health check failed");
    await store.assertReady();
  }
} catch {
  await store?.pool.end().catch(() => {});
  console.error("PostgreSQL persistence is unavailable or migrations are missing; server did not start.");
  process.exitCode = 1;
  startupFailed = true;
}

if (!startupFailed) {
  const server = createNovaServer({
    store,
    tradingMode: config.tradingMode,
    log: (event, details) => console.log(`[${event}]`, JSON.stringify(details))
  });

  server.listen(port, host, () => {
    const address = server.address();
    console.log("Trading Nova web — PAPER / SHADOW ONLY, real money OFF, read-only.");
    console.log(`Listening on http://${host}:${address.port}/ (tradingMode=${config.tradingMode}, persistence=${store ? "postgres" : "local"})`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.log(`\n${signal} — shutting down.`);
      server.close(async () => {
        await store?.pool.end().catch(() => {});
        process.exit(0);
      });
    });
  }
}
