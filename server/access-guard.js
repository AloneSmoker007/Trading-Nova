// server/access-guard.js — single-owner password gate for private hosted deployments.
// The password and signing secret must come from the host's environment settings, never source control.
import {createHmac, timingSafeEqual, createHash} from "node:crypto";

const COOKIE = "nova_private_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const attempts = new Map();

function equalText(a, b) {
  const left = createHash("sha256").update(String(a)).digest();
  const right = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(left, right);
}
function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}
function hostMatchesOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients may omit Origin; cookie SameSite and session still apply.
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers
  });
  res.end(body);
}
const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trading-Nova · Private Login</title></head>
<body><main><h1>Trading-Nova</h1><p>Private access. Sign in to continue.</p>
<form method="post" action="/api/auth/login" autocomplete="on">
<label for="password">Access password</label><br>
<input id="password" name="password" type="password" autocomplete="current-password" required minlength="12" maxlength="256">
<button type="submit">Sign in</button></form></main></body></html>`;
const ERROR_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in failed</title></head><body><main><h1>Sign-in failed</h1><p>Check the password or wait before trying again.</p><a href="/">Try again</a></main></body></html>`;

export function validatePrivateAccessConfig({password, secret}) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new Error("NOVA_ACCESS_PASSWORD must be 12-256 characters in hosted mode");
  }
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
    throw new Error("NOVA_SESSION_SECRET must be at least 32 bytes in hosted mode");
  }
}

export function createAccessGuard({password, secret, production = false, now = () => Date.now()} = {}) {
  const enabled = typeof password === "string" && password.length > 0
    && typeof secret === "string" && Buffer.byteLength(secret) >= 32;
  if (production && !enabled) validatePrivateAccessConfig({password, secret});

  function authenticated(req) {
    if (!enabled) return !production;
    const header = req.headers.cookie || "";
    const match = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(COOKIE + "="));
    if (!match) return false;
    let token;
    try { token = decodeURIComponent(match.slice(COOKIE.length + 1)); } catch { return false; }
    const dot = token.lastIndexOf(".");
    if (dot < 1) return false;
    const payload = token.slice(0, dot);
    const supplied = token.slice(dot + 1);
    if (!equalText(supplied, sign(payload, secret))) return false;
    let session;
    try { session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return false; }
    return Number.isSafeInteger(session.exp) && session.exp > now();
  }

  async function handle(req, res, pathname, readBody) {
    if (!enabled) return false;
    const method = req.method || "GET";
    if (pathname === "/api/auth/login") {
      if (method !== "POST") {
        res.writeHead(405, {"Allow": "POST", "Cache-Control": "no-store"}); res.end(); return true;
      }
      if (!hostMatchesOrigin(req)) { send(res, 403, ERROR_PAGE); return true; }
      const ip = req.socket.remoteAddress || "unknown";
      const t = now();
      const state = attempts.get(ip);
      if (state && t - state.start < LOGIN_WINDOW_MS && state.count >= LOGIN_MAX_ATTEMPTS) {
        send(res, 429, ERROR_PAGE, {"Retry-After": String(Math.ceil((LOGIN_WINDOW_MS - (t - state.start)) / 1000))}); return true;
      }
      const request = await readBody(req);
      if (request.tooLarge) { send(res, 413, ERROR_PAGE); return true; }
      let supplied = "";
      try {
        const type = String(req.headers["content-type"] || "");
        supplied = type.includes("application/x-www-form-urlencoded")
          ? new URLSearchParams(request.body || "").get("password") || ""
          : JSON.parse(request.body || "{}").password || "";
      } catch { supplied = ""; }
      if (!equalText(supplied, password)) {
        const next = !state || t - state.start >= LOGIN_WINDOW_MS ? {start: t, count: 1} : {...state, count: state.count + 1};
        attempts.set(ip, next);
        send(res, 401, ERROR_PAGE); return true;
      }
      attempts.delete(ip);
      const payload = Buffer.from(JSON.stringify({exp: t + SESSION_MS})).toString("base64url");
      const token = payload + "." + sign(payload, secret);
      send(res, 303, "", {
        "Location": "/",
        "Set-Cookie": `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}${production ? "; Secure" : ""}`
      });
      return true;
    }
    if (pathname === "/api/auth/logout") {
      if (method !== "POST") { res.writeHead(405, {"Allow":"POST","Cache-Control":"no-store"}); res.end(); return true; }
      if (!hostMatchesOrigin(req) || !authenticated(req)) { send(res, 403, ERROR_PAGE); return true; }
      send(res, 303, "", {"Location": "/", "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${production ? "; Secure" : ""}`});
      return true;
    }
    if (authenticated(req)) return false;
    if (pathname.startsWith("/api/")) {
      res.writeHead(401, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
      res.end(JSON.stringify({ok:false,state:"error",error:{code:"authentication-required",message:"Sign in required"}}));
    } else {
      send(res, 200, LOGIN_PAGE);
    }
    return true;
  }

  return {enabled, authenticated, handle};
}
