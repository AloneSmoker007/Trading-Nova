import {TokenBucket} from "./rate-limit.js";

export const MAX_CLIENT_RATE_LIMITERS = 10_000;
export const CLIENT_RATE_LIMITER_IDLE_MS = 15 * 60 * 1000;

/**
 * Get a per-client token bucket without allowing attacker-controlled client keys
 * to grow the process memory indefinitely.
 */
export function getBoundedTokenBucket(map, key, {
  now = () => Date.now(),
  capacity,
  refillPerSecond,
  maxEntries = MAX_CLIENT_RATE_LIMITERS,
  idleMs = CLIENT_RATE_LIMITER_IDLE_MS
} = {}) {
  if (!(map instanceof Map)) throw new TypeError("map must be a Map");
  if (typeof key !== "string" || key.length === 0) throw new TypeError("key must be a non-empty string");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive safe integer");
  if (!Number.isFinite(idleMs) || idleMs < 0) throw new RangeError("idleMs must be a non-negative number");

  const timestamp = now();
  const existing = map.get(key);
  if (existing) {
    map.delete(key);
    map.set(key, existing);
    return existing;
  }

  if (map.size >= maxEntries) {
    for (const [clientKey, limiter] of map) {
      if (timestamp - limiter.last >= idleMs) map.delete(clientKey);
    }
  }

  // Map insertion order acts as LRU: existing keys are moved to the end above.
  while (map.size >= maxEntries) map.delete(map.keys().next().value);

  const limiter = new TokenBucket({capacity, refillPerSecond, now});
  map.set(key, limiter);
  return limiter;
}
