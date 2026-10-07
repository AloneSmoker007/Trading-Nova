// tests/ws-d-ui.test.js — WS-D web foundation: dashboard safety and honesty.
//
// Regression guards for the UI contract:
//   * XSS-safe by construction: rendering uses DOM APIs (textContent), never
//     markup-string sinks
//   * paper-only banner and risk-honest copy are always visible
//   * a11y basics present: lang, viewport, aria-live regions, focus styles
//   * the canonical dashboard is single-sourced (ui/ forwards to web/)

import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(REPO_ROOT, p), "utf8");

const XSS_SINK_RES = [
  /\.innerHTML\s*[=(]/,
  /insertAdjacentHTML/,
  /document\.write\s*\(/,
  /\beval\s*\(/,
  /\.outerHTML\s*=[^(]/,
  /new Function\s*\(/
];

test("web/app.js renders with DOM APIs only — no markup-string sinks", () => {
  const app = read("web/app.js");
  for (const sink of XSS_SINK_RES) {
    assert.ok(!sink.test(app), `forbidden sink pattern ${sink} found in web/app.js`);
  }
  assert.match(app, /textContent/, "values must be written via textContent");
  assert.match(app, /TRADING_NOVA_UI/, "legacy state hook kept for compatibility");
  // Data fetched from the API must never become markup structure.
  assert.match(app, /createElement/);
});

test("web/index.html is the honest, accessible dashboard shell", () => {
  const html = read("web/index.html");
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="viewport"/);
  // Golden safety rule must be visible on the page itself.
  assert.match(html, /PAPER \/ SHADOW ONLY/);
  assert.match(html, /real money OFF/i);
  assert.match(html, /No live-money capability/i);
  // a11y: live regions for updates, labelled controls, skip link.
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-busy=/);
  assert.match(html, /<label for="symbol-input">/);
  assert.match(html, /skip-link/);
  // Panels for every API surface.
  for (const id of ["health-values", "market-values", "indicators-values", "portfolio-values", "journal-values", "backtest-values"]) {
    assert.ok(html.includes(`id="${id}"`), `panel ${id} present`);
  }
  // Strict CSP means no inline script/style may exist in the page.
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), "no inline scripts (CSP: script-src 'self')");
  assert.ok(!/<style[\s>]/.test(html), "no inline styles (CSP: style-src 'self')");
  assert.ok(!/\son[a-z]+\s*=/.test(html), "no inline event handlers");
});

test("web/style.css provides responsive layout and visible focus", () => {
  const css = read("web/style.css");
  assert.match(css, /:focus-visible/);
  assert.match(css, /grid-template-columns:\s*repeat\(auto-fit/);
  assert.match(css, /@media/);
});

test("ui/dashboard.html forwards to the single canonical dashboard", () => {
  const html = read("ui/dashboard.html");
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /web\/index\.html/);
  assert.match(html, /PAPER \/ SHADOW ONLY|real money OFF/i);
});

test("server ships the safety envelope: CSP headers + loopback bind + stub marker", () => {
  const app = read("server/app.js");
  assert.match(app, /Content-Security-Policy/);
  assert.match(app, /default-src 'none'/);
  assert.match(app, /X-Content-Type-Options.*nosniff|nosniff/);
  assert.match(app, /Cache-Control.*no-store|no-store/);

  const entry = read("server/index.js");
  assert.match(entry, /127\.0\.0\.1/, "server binds loopback only");
  assert.match(entry, /PAPER \/ SHADOW ONLY/);

  const api = read("server/api.js");
  assert.match(api, /order-submission-not-wired/);
  assert.match(api, /Risk Gate/);
  assert.match(api, /STUB/);
});
