// One fixed public publisher endpoint. No user/model URL is ever requested.
export const PUBLISHER_NEWS_URL = "https://blog.kraken.com/wp-json/wp/v2/posts?per_page=10&_fields=id,date_gmt,modified_gmt,link,title";
export const NEWS_PUBLICATION_WINDOW_MS = 72 * 60 * 60 * 1000;
const MAX_BYTES = 65536;
const CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_WINDOW_MS = 30 * 60 * 1000;
const RETRY_MS = 30000;
const POLICY = Object.freeze({
  id: "kraken-blog", name: "Kraken Blog", type: "first-party-exchange-publisher",
  independence: "not-independent", coverage: "latest-10-publisher-posts",
  note: "Publisher announcements may include promotions. No independent corroboration, sentiment score or asset-specific relevance is inferred."
});

function publicationTime(value) {
  // WordPress date_gmt is UTC without an offset. Reject normalization of invalid
  // dates (e.g. February 30), offsets, local dates, and numeric/coerced values.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const time = Date.parse(value + "Z");
  return Number.isFinite(time) && time >= 0 && new Date(time).toISOString().slice(0, 19) === value ? time : null;
}

export function normalizePublisherPosts(payload) {
  if (!Array.isArray(payload) || payload.length > 10) throw new Error("invalid publisher response");
  const items = [];
  const urls = new Set();
  const ids = new Set();
  let rejectedCount = 0;
  for (const row of payload) {
    try {
      if (!Number.isSafeInteger(row?.id) || row.id < 1 || typeof row.link !== "string" || row.link.length > 2048
          || typeof row.title?.rendered !== "string" || row.title.rendered.length > 2000) throw new Error("invalid post");
      const url = new URL(row.link);
      if (url.protocol !== "https:" || url.hostname !== "blog.kraken.com" || url.port || url.username || url.password) throw new Error("invalid link");
      url.hash = "";
      const title = row.title.rendered.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 240);
      if (!title) throw new Error("empty title");
      if (urls.has(url.href) || ids.has(row.id)) throw new Error("duplicate post");
      urls.add(url.href); ids.add(row.id);
      items.push({id: "kraken-blog:" + row.id, title, url: url.href,
        publishedAt: publicationTime(row.date_gmt), modifiedAt: publicationTime(row.modified_gmt),
        dateAttribution: "publisher-reported", corroboration: "not-checked"});
    } catch { rejectedCount++; }
  }
  if (payload.length && !items.length) throw new Error("no usable publisher posts");
  return {items, rejectedCount};
}

async function boundedJson(response, signal) {
  if (!response?.ok || response.status !== 200 || !response.headers?.get("content-type")?.toLowerCase().includes("application/json")
      || !response.body?.getReader) throw new Error("publisher unavailable");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new Error("publisher body too large");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  if (signal.aborted) { cancel(); throw new Error("publisher aborted"); }
  signal.addEventListener("abort", cancel, {once: true});
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("publisher body too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

export function createPublisherNewsService({fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 5000} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000) throw new Error("invalid publisher deadline");
  let cache = null;
  let pending = null;
  let retryAt = null;
  function project(failed = false) {
    const assessedAt = now();
    const age = cache ? assessedAt - cache.retrievedAt : null;
    const usable = cache && Number.isFinite(age) && age >= 0 && age <= STALE_WINDOW_MS;
    const stale = !usable || failed || age > CACHE_TTL_MS;
    const items = usable ? cache.items.map(item => {
      const publicationAgeMs = item.publishedAt === null ? null : assessedAt - item.publishedAt;
      return {...item, publicationAgeMs: Number.isFinite(publicationAgeMs) && publicationAgeMs >= 0 ? publicationAgeMs : null,
        publicationFreshness: publicationAgeMs === null ? "unknown" : publicationAgeMs < 0 ? "future-date"
          : publicationAgeMs <= NEWS_PUBLICATION_WINDOW_MS ? "within-window" : "older-than-window"};
    }) : [];
    return {state: !usable ? "unavailable" : stale ? "stale" : items.length ? "ok" : "empty",
      publisher: {...POLICY}, retrievedAt: usable ? cache.retrievedAt : null,
      retrievalAgeMs: usable ? age : null, assessedAt, publicationWindowMs: NEWS_PUBLICATION_WINDOW_MS,
      rejectedCount: usable ? cache.rejectedCount : null, items,
      scoreImpact: "none", counterEvidence: "not-collected",
      note: "Publication dates are publisher-reported; retrieval time does not prove publication freshness or correctness. This single-source context does not affect Council scores or orders."};
  }
  async function read() {
    const t = now();
    if (cache && t - cache.retrievedAt >= 0 && t - cache.retrievedAt <= CACHE_TTL_MS) return project();
    if (pending) return pending;
    if (retryAt !== null && t < retryAt) return project(true);
    const controller = new AbortController();
    let timer;
    const task = (async () => {
      try {
        const work = (async () => {
          const response = await fetchImpl(PUBLISHER_NEWS_URL, {
            method: "GET", headers: {accept: "application/json"}, redirect: "error", credentials: "omit", signal: controller.signal
          });
          if (response.url && response.url !== PUBLISHER_NEWS_URL) throw new Error("unexpected publisher redirect");
          return normalizePublisherPosts(await boundedJson(response, controller.signal));
        })();
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {controller.abort(); reject(new Error("publisher timeout"));}, timeoutMs);
        });
        const result = await Promise.race([work, deadline]);
        cache = {...result, retrievedAt: now()};
        retryAt = null;
        return project();
      } catch {
        retryAt = now() + RETRY_MS;
        return project(true);
      } finally { clearTimeout(timer); controller.abort(); }
    })();
    pending = task;
    try { return await task; }
    finally { pending = null; }
  }
  return {read};
}
