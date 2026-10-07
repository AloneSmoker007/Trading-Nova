// server/app.js — thin localhost HTTP server for the Trading-Nova dashboard.
//
// node:http only, no framework, no new dependencies. Bound to 127.0.0.1 by
// server/index.js (loopback only — this is a personal, read-only app).
//
// Surface:
//   GET  /api/health                  engine + server health (honest degraded states)
//   GET  /api/market/:symbol          real ticker from src/market-data (fresh/stale/unavailable)
//   GET  /api/indicators/:symbol      real indicators from src/indicators over real candles
//   GET  /api/portfolio               paper portfolio from the state snapshot (read-only)
//   GET  /api/journal                 hash-chained journal + verifyJournal integrity
//   GET  /api/backtest                real backtest (src/backtest/engine-v2) summary
//   POST /api/paper/orders            STUB -> 501 (order submission NOT wired; see api.js)
//   GET  /*                          whitelisted static dashboard files
//
// Safety properties enforced here:
//   - every response carries strict security headers (CSP, nosniff, no framing)
//   - API responses are Cache-Control: no-store
//   - JSON errors are generic; nothing from the environment, stack traces or
//     filesystem ever reaches the wire
//   - GET/HEAD only (plus the 501 POST stub); other methods -> 405 with Allow

import {createServer} from "node:http";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createMarketService} from "./market.js";
import {createApi} from "./api.js";
import {readStatic} from "./static.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_URL_LENGTH = 2048;

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin"
});

function sendJson(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    ...extra
  });
  res.end(payload);
}

// Route matcher for /api/* -> handler name + captured path params.
function matchApi(pathname) {
  if (pathname === "/api/health") return {name: "health", params: {}};
  let m = /^\/api\/market\/([^/]+)$/.exec(pathname);
  if (m) return {name: "marketData", params: {symbol: m[1]}};
  m = /^\/api\/indicators\/([^/]+)$/.exec(pathname);
  if (m) return {name: "indicators", params: {symbol: m[1]}};
  if (pathname === "/api/portfolio") return {name: "portfolio", params: {}};
  if (pathname === "/api/journal") return {name: "journal", params: {}};
  if (pathname === "/api/backtest") return {name: "backtest", params: {}};
  if (pathname === "/api/paper/orders") return {name: "paperOrdersStub", params: {}};
  return null;
}

export function createNovaServer({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  stateFile = join(REPO_ROOT, "db", "paper-state.json"),
  webRoot = join(REPO_ROOT, "web"),
  tradingMode = "paper",
  log = null
} = {}) {
  const market = createMarketService({fetchImpl, now});
  const startedAt = now();
  const api = createApi({market, stateFile, now, tradingMode, startedAt});

  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    try {
      if (typeof req.url !== "string" || req.url.length === 0 || req.url.length > MAX_URL_LENGTH) {
        sendJson(res, 400, {ok: false, state: "error", error: {code: "bad-request", message: "malformed request target"}});
        return;
      }
      let url;
      try {
        url = new URL(req.url, "http://127.0.0.1");
      } catch {
        sendJson(res, 400, {ok: false, state: "error", error: {code: "bad-request", message: "malformed request target"}});
        return;
      }
      const pathname = url.pathname;

      if (pathname.startsWith("/api/")) {
        const route = matchApi(pathname);
        if (!route) {
          sendJson(res, 404, {ok: false, state: "error", error: {code: "not-found", message: "unknown API route"}});
          return;
        }
        // Methods: GET/HEAD everywhere; POST only on the marked stub (which 501s).
        const allowed = route.name === "paperOrdersStub" ? ["POST"] : ["GET", "HEAD"];
        if (!allowed.includes(method)) {
          sendJson(res, 405, {ok: false, state: "error", error: {code: "method-not-allowed", message: "method not allowed"}}, {Allow: allowed.join(", ")});
          return;
        }
        if (method === "HEAD") {
          sendJson(res, 200, {ok: true, data: {note: "HEAD — use GET for the full payload"}});
          return;
        }
        let out;
        if (route.name === "marketData" || route.name === "indicators") {
          out = await api[route.name](url.searchParams, route.params.symbol);
        } else {
          out = await api[route.name](url.searchParams);
        }
        sendJson(res, out.status, out.body);
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, {ok: false, state: "error", error: {code: "method-not-allowed", message: "method not allowed"}}, {Allow: "GET, HEAD"});
        return;
      }
      const file = await readStatic(webRoot, pathname);
      res.writeHead(file.status, {
        ...SECURITY_HEADERS,
        "Content-Type": file.type,
        "Cache-Control": "no-cache",
        "Content-Length": Buffer.byteLength(file.body)
      });
      res.end(method === "HEAD" ? undefined : file.body);
    } catch (err) {
      // Generic error only: no stack, no paths, no environment values on the wire.
      if (log) log("request-error", {message: err && err.message ? String(err.message) : "unknown"});
      if (!res.headersSent) {
        sendJson(res, 500, {ok: false, state: "error", error: {code: "internal-error", message: "internal error"}});
      } else {
        res.end();
      }
    }
  });

  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return server;
}

export {SECURITY_HEADERS, REPO_ROOT, matchApi};
