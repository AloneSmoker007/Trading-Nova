// Gemini segment offsets are UTF-8 bytes within a content part, not JS indices.
// Provider attribution is evidence metadata, never independent fact verification.
export function researchEvidence(parts, grounding, retrievedAt) {
  parts = Array.isArray(parts) ? parts.slice(0, 128) : [];
  const visible = parts.map(p => p?.thought !== true && typeof p?.text === "string" ? p.text : "");
  const raw = visible.join("");
  const answer = raw.trim();
  const trimStart = raw.length - raw.trimStart().length;
  const sources = [];
  const chunkToSource = new Map();
  const urls = new Map();
  const chunks = Array.isArray(grounding?.groundingChunks) ? grounding.groundingChunks : [];
  chunks.slice(0, 128).forEach((chunk, index) => {
    const web = chunk?.web;
    if (typeof web?.uri !== "string" || web.uri.length > 2048) return;
    try {
      const url = new URL(web.uri);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
      const canonical = url.toString();
      let sourceIndex = urls.get(canonical);
      if (sourceIndex === undefined) {
        if (sources.length >= 8) return;
        sourceIndex = sources.length;
        urls.set(canonical, sourceIndex);
        sources.push({title: typeof web.title === "string" && web.title.trim() ? web.title.trim().slice(0, 180) : url.hostname, url: canonical});
      }
      chunkToSource.set(index, sourceIndex);
    } catch { /* Unusable URLs cannot support a claim. */ }
  });
  const claims = [];
  const seen = new Set();
  const supports = Array.isArray(grounding?.groundingSupports) ? grounding.groundingSupports : [];
  for (const support of supports.slice(0, 128)) {
    if (claims.length >= 32) break;
    const segment = support?.segment;
    const partIndex = segment?.partIndex ?? 0;
    const startByte = segment?.startIndex ?? 0;
    const endByte = segment?.endIndex;
    if (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= visible.length
        || !Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte) || startByte < 0 || endByte <= startByte) continue;
    const text = visible[partIndex];
    // Build exact code-point boundaries: reject offsets inside a multibyte code point.
    const offsets = new Map([[0, 0]]);
    let bytes = 0; let chars = 0;
    for (const point of text) { bytes += Buffer.byteLength(point, "utf8"); chars += point.length; offsets.set(bytes, chars); }
    if (!offsets.has(startByte) || !offsets.has(endByte)) continue;
    const extracted = text.slice(offsets.get(startByte), offsets.get(endByte));
    if (!extracted.trim() || (segment.text !== undefined && segment.text !== extracted)) continue;
    const start = visible.slice(0, partIndex).join("").length + offsets.get(startByte) - trimStart;
    const end = start + extracted.length;
    if (start < 0 || end > answer.length || answer.slice(start, end) !== extracted) continue;
    const sourceIndices = [...new Set((Array.isArray(support.groundingChunkIndices) ? support.groundingChunkIndices.slice(0, 128) : [])
      .filter(Number.isSafeInteger).map(i => chunkToSource.get(i)).filter(i => i !== undefined))];
    if (!sourceIndices.length) continue;
    const sourceIds = sourceIndices.map(i => `S${i + 1}`).sort();
    const key = JSON.stringify([start, end, sourceIds]);
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({text: extracted, start, end, sourceIds});
  }
  // Union overlapping intervals; coverage describes text mapping, not truth/confidence.
  let coveredCharacters = 0; let lastEnd = 0;
  for (const {start, end} of [...claims].sort((a, b) => a.start - b.start)) {
    coveredCharacters += Math.max(0, end - Math.max(lastEnd, start)); lastEnd = Math.max(lastEnd, end);
  }
  return {answer, sources, evidence: {
    state: claims.length ? "claim-attributed" : sources.length ? "sources-only" : "unavailable",
    attribution: "provider-reported-not-independently-verified",
    publicationFreshness: "unknown",
    sourceDetails: sources.map((_, i) => ({id: `S${i + 1}`, sourceIndex: i, retrievedAt, publishedAt: null})),
    claims, coveredCharacters, answerCharacters: answer.length,
    note: "Source retrieval time is not publication time. Mapped text is provider attribution, not proof of correctness, completeness or currentness. Unmapped text has no claim-level citation."
  }};
}
