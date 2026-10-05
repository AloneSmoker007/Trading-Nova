import { appendJournalEntry, verifyJournal } from "../journal/journal.js";

export class DurableStore {
  constructor() {
    this.state = new Map();
    this.idempotency = new Map();
    this.journal = [];
  }

  put(namespace, id, value) {
    if (!namespace || !id) throw new Error("namespace and id required");
    const key = namespace + ":" + id;
    this.state.set(key, structuredClone(value));
    return structuredClone(value);
  }

  get(namespace, id) {
    const value = this.state.get(namespace + ":" + id);
    return value === undefined ? null : structuredClone(value);
  }

  transactIdempotent(key, operation) {
    if (!key) throw new Error("idempotency key required");
    if (this.idempotency.has(key)) return structuredClone(this.idempotency.get(key));
    const result = operation();
    this.idempotency.set(key, structuredClone(result));
    return structuredClone(result);
  }

  appendAudit(entry) {
    return appendJournalEntry(this.journal, structuredClone(entry));
  }

  verify() {
    return verifyJournal(this.journal);
  }

  snapshot() {
    return {
      state: Object.fromEntries(this.state),
      idempotency: Object.fromEntries(this.idempotency),
      journal: structuredClone(this.journal)
    };
  }

  restore(snapshot) {
    if (!snapshot || typeof snapshot !== "object") throw new Error("invalid snapshot");
    const journal = Array.isArray(snapshot.journal) ? structuredClone(snapshot.journal) : [];
    if (!verifyJournal(journal)) throw new Error("invalid journal chain");
    this.state = new Map(Object.entries(snapshot.state || {}));
    this.idempotency = new Map(Object.entries(snapshot.idempotency || {}));
    this.journal = journal;
  }
}