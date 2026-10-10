// server/static.js — static file serving for the dashboard.
//
// Files are served from a FIXED WHITELIST (never from user-controlled paths),
// so path traversal is structurally impossible: any pathname that is not an
// exact whitelist entry is a 404. The resolved path is additionally checked to
// stay inside the web root as defense in depth.

import {readFile} from "node:fs/promises";
import {join, resolve, sep} from "node:path";

// pathname -> {file, type}. `/ui/dashboard.html` is an alias of the canonical
// dashboard (web/index.html) so old links keep working — one dashboard, one source.
const STATIC_FILES = Object.freeze({
  "/": {file: "index.html", type: "text/html; charset=utf-8"},
  "/index.html": {file: "index.html", type: "text/html; charset=utf-8"},
  "/app.js": {file: "app.js", type: "text/javascript; charset=utf-8"},
  "/style.css": {file: "style.css", type: "text/css; charset=utf-8"},
  "/vendor/lightweight-charts.js": {file: "vendor/lightweight-charts.standalone.production.js", type: "text/javascript; charset=utf-8"},
  "/ui/dashboard.html": {file: "index.html", type: "text/html; charset=utf-8"}
});

export async function readStatic(webRoot, pathname) {
  const entry = Object.hasOwn(STATIC_FILES, pathname) ? STATIC_FILES[pathname] : null;
  if (!entry) return {status: 404, type: "text/plain; charset=utf-8", body: "not found"};
  const root = resolve(webRoot);
  const filePath = resolve(join(root, entry.file));
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return {status: 404, type: "text/plain; charset=utf-8", body: "not found"};
  }
  try {
    const body = await readFile(filePath);
    return {status: 200, type: entry.type, body};
  } catch {
    return {status: 404, type: "text/plain; charset=utf-8", body: "not found"};
  }
}

export {STATIC_FILES};
