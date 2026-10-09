import test from "node:test";
import assert from "node:assert/strict";
import {getBoundedTokenBucket} from "../src/security/client-rate-limiters.js";

test("bounded client limiter evicts the least-recently-used key at capacity", () => {
  let time = 1_000;
  const map = new Map();
  const options = {now: () => time, capacity: 2, refillPerSecond: 1, maxEntries: 2, idleMs: 60_000};
  const first = getBoundedTokenBucket(map, "client-a", options);
  getBoundedTokenBucket(map, "client-b", options);
  assert.equal(getBoundedTokenBucket(map, "client-a", options), first);
  getBoundedTokenBucket(map, "client-c", options);
  assert.equal(map.size, 2);
  assert.equal(map.has("client-a"), true);
  assert.equal(map.has("client-b"), false);
  assert.equal(map.has("client-c"), true);
});

test("bounded client limiter prunes idle entries before evicting active ones", () => {
  let time = 1_000;
  const map = new Map();
  const options = {now: () => time, capacity: 2, refillPerSecond: 1, maxEntries: 2, idleMs: 1_000};
  const active = getBoundedTokenBucket(map, "active", options);
  time += 100;
  getBoundedTokenBucket(map, "idle", options);
  time += 700;
  active.consume();
  time += 900;
  const next = getBoundedTokenBucket(map, "next", options);
  assert.equal(map.size, 2);
  assert.equal(map.has("idle"), false);
  assert.equal(map.get("active"), active);
  assert.equal(map.get("next"), next);
});

test("bounded client limiter rejects invalid keys and capacity", () => {
  const map = new Map();
  assert.throws(() => getBoundedTokenBucket(map, "", {maxEntries: 2}), /key/);
  assert.throws(() => getBoundedTokenBucket(map, "client", {maxEntries: 0}), /maxEntries/);
});
