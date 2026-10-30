// Must run under the store's transaction serialization/sequence lock.
export async function nextPaperSequence(tx) {
  const previous = await tx.get("paper-sequence", "global");
  if (previous !== null && (!previous || previous.version !== 1
      || !Number.isSafeInteger(previous.last) || previous.last < 1 || previous.last >= Number.MAX_SAFE_INTEGER)) {
    throw new Error("invalid paper execution sequence");
  }
  const next = previous === null ? 1 : previous.last + 1;
  await tx.put("paper-sequence", "global", {version: 1, last: next});
  return next;
}
