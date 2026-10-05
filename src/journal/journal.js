import { createHash } from "node:crypto";

export function appendJournalEntry(chain, entry) {
  const previousHash=chain.length ? chain[chain.length-1].hash : "GENESIS";
  const payload=JSON.stringify({previousHash,entry});
  const hash=createHash("sha256").update(payload).digest("hex");
  const record=Object.freeze({index:chain.length,previousHash,entry,hash});
  chain.push(record);
  return record;
}

export function verifyJournal(chain) {
  let previousHash="GENESIS";
  for (const record of chain) {
    const expected=createHash("sha256").update(JSON.stringify({previousHash,entry:record.entry})).digest("hex");
    if (record.previousHash!==previousHash || record.hash!==expected) return false;
    previousHash=record.hash;
  }
  return true;
}