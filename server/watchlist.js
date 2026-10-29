import {readFile, writeFile, rename, mkdir, unlink} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {randomUUID} from "node:crypto";

export const DEFAULT_WATCHLIST = Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "ADAUSDT"]);
export const MAX_WATCHLIST_SYMBOLS = 20;
const fileQueues = new Map();
const fail = code => Object.assign(new Error(code), {code});

function normalizeSymbols(symbols) {
  if (!Array.isArray(symbols) || symbols.length > MAX_WATCHLIST_SYMBOLS) throw fail("invalid-watchlist");
  const normalized = symbols.map(symbol => typeof symbol === "string" ? symbol.trim().toUpperCase() : "");
  if (normalized.some(symbol => !/^[A-Z0-9]{1,20}USDT$/.test(symbol))
      || new Set(normalized).size !== normalized.length) throw fail("invalid-watchlist");
  return normalized;
}

function decode(value) {
  if (value === undefined) return {symbols: [...DEFAULT_WATCHLIST], revision: 0, updatedAt: null, isDefault: true};
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) throw fail("watchlist-unavailable");
  let symbols;
  try { symbols = normalizeSymbols(value.symbols); } catch { throw fail("watchlist-unavailable"); }
  return {symbols, revision: value.revision, updatedAt: value.updatedAt, isDefault: false};
}

function serializeFileOperation(path, work) {
  const previous = fileQueues.get(path) || Promise.resolve();
  const result = previous.then(work, work);
  const tail = result.then(() => {}, () => {});
  fileQueues.set(path, tail);
  void tail.then(() => {if (fileQueues.get(path) === tail) fileQueues.delete(path);});
  return result;
}

// The application is single-owner. PostgreSQL transactions serialize edits
// across app instances; local-file mode serializes one Node process and uses
// atomic replacement so readers see a complete old or new snapshot.
export function createWatchlistService({file, store, now = () => Date.now()}) {
  const path = typeof file === "string" ? resolve(file) : null;
  async function read(client) {
    if (store) return decode((await store.get("paper-watchlist", "main", client)) ?? undefined);
    if (!path) return decode(undefined);
    let text;
    try { text = await readFile(path, "utf8"); }
    catch (error) {if (error.code === "ENOENT") return decode(undefined); throw fail("watchlist-unavailable");}
    try { return decode(JSON.parse(text)); } catch { throw fail("watchlist-unavailable"); }
  }

  async function save(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || !Number.isSafeInteger(input.revision) || input.revision < 0) throw fail("invalid-watchlist");
    const symbols = normalizeSymbols(input.symbols);
    async function update(client) {
      const current = await read(client);
      if (current.revision !== input.revision) throw fail("watchlist-conflict");
      const revision = current.revision + 1;
      const updatedAt = now();
      if (!Number.isSafeInteger(revision) || !Number.isFinite(updatedAt) || updatedAt < 0) throw fail("watchlist-unavailable");
      const snapshot = {version: 1, symbols, revision, updatedAt};
      if (store) await store.put("paper-watchlist", "main", snapshot, client);
      else {
        if (!path) throw fail("watchlist-unavailable");
        await mkdir(dirname(path), {recursive: true});
        const temporary = path + ".tmp-" + randomUUID();
        try {
          await writeFile(temporary, JSON.stringify(snapshot) + "\n", {flag: "wx", mode: 0o600});
          await rename(temporary, path);
        } finally { await unlink(temporary).catch(() => {}); }
      }
      return decode(snapshot);
    }
    if (store) return store.withTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", ["trading_nova:watchlist:main"]);
      return update(client);
    });
    if (!path) throw fail("watchlist-unavailable");
    return serializeFileOperation(path, () => update());
  }
  return {read, save};
}
