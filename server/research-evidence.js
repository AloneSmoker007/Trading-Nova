// Gemini segment offsets are UTF-8 bytes within a content part, not JS indices.
// Provider attribution is evidence metadata, never independent fact verification.

const PUBLISHER_GROUPS = Object.freeze([
  {domain: "reuters.com", id: "reuters", label: "Reuters", type: "editorial", diversityEligible: true},
  {domain: "apnews.com", id: "associated-press", label: "Associated Press", type: "editorial", diversityEligible: true},
  {domain: "bloomberg.com", id: "bloomberg", label: "Bloomberg", type: "editorial", diversityEligible: true},
  {domain: "ft.com", id: "financial-times", label: "Financial Times", type: "editorial", diversityEligible: true},
  {domain: "wsj.com", id: "wall-street-journal", label: "Wall Street Journal", type: "editorial", diversityEligible: true},
  {domain: "sec.gov", id: "us-sec", label: "U.S. SEC", type: "regulator", diversityEligible: true},
  {domain: "cftc.gov", id: "us-cftc", label: "U.S. CFTC", type: "regulator", diversityEligible: true},
  {domain: "federalreserve.gov", id: "federal-reserve", label: "Federal Reserve", type: "regulator", diversityEligible: true},
  {domain: "bis.org", id: "bis", label: "BIS", type: "intergovernmental", diversityEligible: true},
  {domain: "imf.org", id: "imf", label: "IMF", type: "intergovernmental", diversityEligible: true},
  {domain: "kraken.com", id: "kraken", label: "Kraken", type: "commercial-exchange", diversityEligible: false},
  {domain: "bitfinex.com", id: "bitfinex", label: "Bitfinex", type: "commercial-exchange", diversityEligible: false},
  {domain: "binance.com", id: "binance", label: "Binance", type: "commercial-exchange", diversityEligible: false}
]);

function assessPublisher(url) {
  const hostname = new URL(url).hostname.toLowerCase();
  const group = PUBLISHER_GROUPS.find(item => hostname === item.domain || hostname.endsWith("." + item.domain));
  return group ? {
    publisherGroupId: group.id,
    publisherLabel: group.label,
    publisherClass: group.type,
    diversityEligible: group.diversityEligible
  } : {
    publisherGroupId: null,
    publisherLabel: null,
    publisherClass: "unclassified",
    diversityEligible: false
  };
}

function claimPublisherDiversity(sourceIndices, sourceAssessments) {
  const groups = new Map();
  for (const index of sourceIndices) {
    const assessment = sourceAssessments[index];
    if (!assessment?.publisherGroupId) continue;
    groups.set(assessment.publisherGroupId, {
      id: assessment.publisherGroupId,
      label: assessment.publisherLabel,
      type: assessment.publisherClass,
      diversityEligible: assessment.diversityEligible
    });
  }
  const publisherGroups = [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
  const diversityGroupCount = publisherGroups.filter(group => group.diversityEligible).length;
  return {
    publisherGroups,
    diversityGroupCount,
    sourceDiversity: diversityGroupCount >= 2 ? "multiple-editorial-regulatory-groups"
      : diversityGroupCount === 1 ? "single-editorial-regulatory-group" : "commercial-or-unclassified-only",
    independentCorroboration: "not-established"
  };
}

function overallPublisherDiversity(sourceAssessments) {
  const groups = new Map();
  for (const assessment of sourceAssessments) {
    if (!assessment.publisherGroupId) continue;
    groups.set(assessment.publisherGroupId, assessment);
  }
  const eligibleGroups = [...groups.values()].filter(group => group.diversityEligible)
    .map(group => ({id: group.publisherGroupId, label: group.publisherLabel, type: group.publisherClass}))
    .sort((a, b) => a.id.localeCompare(b.id));
  const diversityGroupCount = eligibleGroups.length;
  return {
    state: diversityGroupCount >= 2 ? "multiple-editorial-regulatory-groups"
      : diversityGroupCount === 1 ? "single-editorial-regulatory-group" : "commercial-or-unclassified-only",
    diversityGroupCount,
    groups: eligibleGroups,
    commercialSourceCount: sourceAssessments.filter(source => source.publisherClass === "commercial-exchange").length,
    unclassifiedSourceCount: sourceAssessments.filter(source => source.publisherClass === "unclassified").length,
    independentCorroboration: "not-established",
    note: "Domain grouping is a conservative registry hint, not proof of common ownership, editorial independence, non-syndication, claim support or truth. Unknown domains are not counted."
  };
}

export function researchEvidence(parts, grounding, retrievedAt) {
  parts = Array.isArray(parts) ? parts.slice(0, 128) : [];
  const visible = parts.map(p => p?.thought !== true && typeof p?.text === "string" ? p.text : "");
  const raw = visible.join("");
  const answer = raw.trim();
  const trimStart = raw.length - raw.trimStart().length;
  const sources = [];
  const sourceAssessments = [];
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
        sourceAssessments.push(assessPublisher(canonical));
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
    claims.push({
      text: extracted, start, end, sourceIds,
      ...claimPublisherDiversity(sourceIndices, sourceAssessments)
    });
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
    sourceDetails: sources.map((_, i) => ({
      id: `S${i + 1}`, sourceIndex: i, retrievedAt, publishedAt: null, ...sourceAssessments[i]
    })),
    publisherDiversity: overallPublisherDiversity(sourceAssessments),
    claims, coveredCharacters, answerCharacters: answer.length,
    note: "Source retrieval time is not publication time. Mapped text is provider attribution, not proof of correctness, completeness, independence or currentness. Publisher grouping is a domain-registry hint only. Unmapped text has no claim-level citation."
  }};
}
