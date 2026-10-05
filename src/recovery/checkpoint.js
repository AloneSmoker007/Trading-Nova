export function createCheckpoint(store) {
  if (!store || typeof store.snapshot !== "function" || typeof store.verify !== "function") throw new Error("store required");
  if (!store.verify()) throw new Error("journal integrity failure");
  return Object.freeze({version:1,createdAt:Date.now(),snapshot:store.snapshot()});
}

export function restoreCheckpoint(store, checkpoint) {
  if (!checkpoint?.snapshot) throw new Error("invalid checkpoint");
  store.restore(checkpoint.snapshot);
  if (!store.verify()) throw new Error("restored state failed integrity check");
  return true;
}