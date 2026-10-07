#!/usr/bin/env node
// server/index.js — entry point for the local Trading-Nova dashboard server.
//
// Loopback ONLY (127.0.0.1), read-only, paper/shadow only — real money OFF.
// Port: NOVA_PORT or PORT env var, default 7411 (0 = ephemeral).
//
//   npm run serve          # start the server
//   open http://127.0.0.1:7411/
//
// The server exposes the read-only JSON API (see server/app.js) plus the static
// dashboard in web/. Order submission is intentionally NOT wired (server/api.js).

import {readConfig} from "../src/config.js";
import {createNovaServer} from "./app.js";

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

const config = readConfig();
const port = parsePort(process.env.NOVA_PORT ?? process.env.PORT);
const host = "127.0.0.1"; // loopback only — never bind a public interface

const server = createNovaServer({
  tradingMode: config.tradingMode,
  log: (event, details) => console.log(`[${event}]`, JSON.stringify(details))
});

server.listen(port, host, () => {
  const address = server.address();
  console.log("Trading Nova web — PAPER / SHADOW ONLY, real money OFF, read-only.");
  console.log(`Listening on http://${host}:${address.port}/ (tradingMode=${config.tradingMode})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n${signal} — shutting down.`);
    server.close(() => process.exit(0));
  });
}
