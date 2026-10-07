import { createHash } from "node:crypto";
import { appendJournalEntry, verifyJournal } from "../journal/journal.js";

// Canonical (key-order stable) serialization used for checkpoint integrity.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Date) return { __date: value.toISOString() };
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

// Root hash over the trading state (state entries + idempotency cache).
function stateRoot(stateMap, idempotencyMap) {
  const payload = JSON.stringify(stable({
    state: Object.fromEntries(stateMap),
    idempotency: Object.fromEntries(idempotencyMap)
  }));
  return createHash("sha256").update(payload).digest("hex");
}

const CHECKPOINT_ENTRY_TYPE = "CHECKPOINT";

export class DurableStore {
  constructor() {
    this.state = new Map();
    this.idempotency = new Map();
    this.journal = [];
    // Serializes transactional operations so that staged writes can never
    // interleave between concurrent async operations.
    this._queue = Promise.resolve();
    this._activeTx = null;
  }

  put(namespace, id, value) {
    if (!namespace || !id) throw new Error("namespace and id required");
    const key = namespace + ":" + id;
    const staged = clone(value);
    // Writes issued while a transactional operation is executing join that
    // transaction's staging area: they either all commit or all disappear.
    if (this._activeTx) this._activeTx.writes.set(key, staged);
    else this.state.set(key, staged);
    return clone(staged);
  }

  get(namespace, id) {
    const key = namespace + ":" + id;
    const value = this._activeTx?.writes.has(key) ? this._activeTx.writes.get(key) : this.state.get(key);
    return value === undefined ? null : clone(value);
  }

  /**
   * Run `operation` exactly once per key, atomically.
   *
   * - Supports async operations: the operation's return value is awaited, so a
   *   Promise is never fed to structuredClone (the historical DataCloneError).
   * - All-or-nothing: every write issued during the operation (via `tx.put` or
   *   `store.put`) is staged and only committed — together with the idempotency
   *   record — after the operation has resolved and its result is clonable. A
   *   failure discards every staged write.
   * - The operation receives a transaction handle `tx` with `put`/`get` that
   *   reads its own writes and participates in the atomic commit.
   */
  transactIdempotent(key, operation) {
    if (!key) throw new Error("idempotency key required");
    if (typeof operation !== "function") throw new Error("operation required");
    if (this.idempotency.has(key)) return Promise.resolve(clone(this.idempotency.get(key)));

    const run = async () => {
      // Re-check inside the lock: a queued predecessor may have recorded the key.
      if (this.idempotency.has(key)) return clone(this.idempotency.get(key));
      const tx = {
        writes: new Map(),
        put: (namespace, id, value) => this.put(namespace, id, value),
        get: (namespace, id) => this.get(namespace, id)
      };
      this._activeTx = tx;
      let result;
      try {
        result = await operation(tx);
      } finally {
        this._activeTx = null;
      }
      if (result === undefined) throw new Error("idempotent operation must return a result");
      // Clone BEFORE committing: an unclonable result must not leave partial writes.
      const cached = clone(result);
      for (const [k, v] of tx.writes) this.state.set(k, v);
      this.idempotency.set(key, cached);
      return clone(cached);
    };

    const next = this._queue.then(run, run);
    // Keep the chain alive even when an operation fails.
    this._queue = next.then(() => {}, () => {});
    return next;
  }

  appendAudit(entry) {
    return appendJournalEntry(this.journal, clone(entry));
  }

  verify() {
    return verifyJournal(this.journal);
  }

  snapshot() {
    const state = clone(Object.fromEntries(this.state));
    const idempotency = clone(Object.fromEntries(this.idempotency));
    const root = stateRoot(this.state, this.idempotency);
    // Anchor the state root inside the hash-chained journal so the state hash
    // cannot be recomputed without also breaking the journal chain.
    appendJournalEntry(this.journal, { type: CHECKPOINT_ENTRY_TYPE, stateHash: root });
    return {
      state,
      idempotency,
      journal: clone(this.journal),
      stateHash: root
    };
  }

  restore(snapshot) {
    if (!snapshot || typeof snapshot !== "object") throw new Error("invalid snapshot");
    const journal = Array.isArray(snapshot.journal) ? clone(snapshot.journal) : [];
    if (!verifyJournal(journal)) throw new Error("journal integrity failure");
    const state = Object.entries(snapshot.state || {});
    const idempotency = Object.entries(snapshot.idempotency || {});
    // Verify the FULL checkpoint: the stored state hash must match the actual
    // trading state (state + idempotency cache)...
    const expectedRoot = stateRoot(new Map(state), new Map(idempotency));
    if (typeof snapshot.stateHash !== "string" || snapshot.stateHash !== expectedRoot) {
      throw new Error("checkpoint state integrity failure");
    }
    // ...and the state hash must be anchored in the tamper-evident journal.
    const anchored = journal.some((record) =>
      record?.entry?.type === CHECKPOINT_ENTRY_TYPE && record?.entry?.stateHash === snapshot.stateHash
    );
    if (!anchored) throw new Error("checkpoint state integrity failure");
    this.state = new Map(state.map(([k, v]) => [k, clone(v)]));
    this.idempotency = new Map(idempotency.map(([k, v]) => [k, clone(v)]));
    this.journal = journal;
  }
}
