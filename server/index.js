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

import {readConfig, validateProductionConfig} from "../src/config.js";
import {createPostgresStore} from "../src/persistence/postgres.js";
import {createNovaServer} from "./app.js";
import {validatePrivateAccessConfig} from "./access-guard.js";

function parsePort(raw) {
  if (raw === undefined || raw === "") return 7411;
  const text = String(raw).trim();
  if (!/^\d{1,5}$/.test(text)) {
    console.error("Invalid port: expected an integer between 0 and 65535.");
    process.exit(2);
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("Invalid port: expected an integer between 0 and 65535.");
    process.exit(2);
  }
  return port;
}

const config = readConfig();
const production = config.nodeEnv === "production";

if (production) {
  try {
    validateProductionConfig(process.env);
    validatePrivateAccessConfig({
      password: process.env.NOVA_ACCESS_PASSWORD,
      secret: process.env.NOVA_SESSION_SECRET
    });
  } catch (error) {
    console.error("Production startup configuration failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (!process.env.POSTGRES_URL || !process.env.POSTGRES_URL.trim()) {
    console.error("POSTGRES_URL is required in hosted production; local-file persistence is disabled.");
    process.exit(1);
  }
}

const port = parsePort(process.env.NOVA_PORT ?? process.env.PORT ?? "7411");
const host = production ? "0.0.0.0" : "127.0.0.1";

let store;
let startupFailed = false;
try {
  if (process.env.POSTGRES_URL !== undefined && process.env.POSTGRES_URL.trim() !== "") {
    store = await createPostgresStore({
      connectionString: process.env.POSTGRES_URL,
      schema: process.env.TRADING_NOVA_DB_SCHEMA
    });
    if (!(await store.health())) throw new Error("database health check failed");
    await store.assertReady();
  }
} catch (error) {
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
