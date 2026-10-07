/**
 * tests/ws-c-ops-timeout.test.js
 *
 * Regression coverage for the H-sec-1 ops hardening: outbound HTTP calls made
 * from `scripts/` can no longer hang a job. A hung upstream (connection opens,
 * never responds) must abort at the per-request timeout, retries must respect
 * the overall deadline, and DB work (`scripts/migrate.js`) is bounded by
 * `withDeadline`.
 *
 * Every test uses loopback `node:http` servers with sub-second timeouts and
 * asserts wall-clock bounds loosely (< 2s) so the suite stays non-flaky while
 * still failing on any hang.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {fetchWithTimeout, fetchWithRetry, RequestTimeoutError, isTimeoutError} from "../scripts/lib/http.js";
import {withDeadline, DeadlineExceededError} from "../scripts/lib/deadline.js";

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({server, url: "http://127.0.0.1:" + server.address().port}));
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(() => resolve());
  });
}

test("fetchWithTimeout aborts a hung upstream instead of hanging", async () => {
  const {server, url} = await listen(() => {}); // never responds
  try {
    const started = Date.now();
    await assert.rejects(
      () => fetchWithTimeout(url + "/hang", {timeoutMs: 150}),
      (error) => error instanceof RequestTimeoutError && isTimeoutError(error) && error.code === "ETIMEDOUT"
    );
    assert.ok(Date.now() - started < 2000, "abort must fire near the timeout, not hang");
  } finally {
    await close(server);
  }
});

test("fetchWithTimeout resolves promptly when the server responds", async () => {
  const {server, url} = await listen((req, res) => {
    res.writeHead(200, {"content-type": "application/json"});
    res.end("{}");
  });
  try {
    const res = await fetchWithTimeout(url + "/ok", {timeoutMs: 2000});
    assert.equal(res.ok, true);
  } finally {
    await close(server);
  }
});

test("fetchWithTimeout refuses to start a request past the deadline", async () => {
  const {server, url} = await listen((req, res) => res.end("ok"));
  try {
    await assert.rejects(
      () => fetchWithTimeout(url, {timeoutMs: 2000, deadlineAt: Date.now() - 1}),
      (error) => error instanceof RequestTimeoutError
    );
  } finally {
    await close(server);
  }
});

test("fetchWithRetry retries retryable failures and gives up at the deadline", async () => {
  let requests = 0;
  const {server, url} = await listen(() => {
    requests++; // hang every request
  });
  try {
    const started = Date.now();
    await assert.rejects(
      () => fetchWithRetry(url + "/flaky", {timeoutMs: 60, deadlineAt: Date.now() + 400, retries: 5, backoffMs: 250}),
      (error) => isTimeoutError(error)
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, "deadline must bound the retry loop, elapsed=" + elapsed);
    assert.ok(requests >= 2, "at least one retry must happen, requests=" + requests);
    assert.ok(requests <= 3, "deadline must stop the retry loop, requests=" + requests);
  } finally {
    await close(server);
  }
});

test("fetchWithRetry returns the final response after exhausting retries on 5xx", async () => {
  let requests = 0;
  const {server, url} = await listen((req, res) => {
    requests++;
    res.writeHead(503);
    res.end("busy");
  });
  try {
    const res = await fetchWithRetry(url + "/down", {timeoutMs: 1000, retries: 2, backoffMs: 10});
    assert.equal(res.status, 503);
    assert.equal(requests, 3, "exactly retries+1 attempts");
  } finally {
    await close(server);
  }
});

test("fetchWithRetry retries once and succeeds on recovery", async () => {
  let requests = 0;
  const {server, url} = await listen((req, res) => {
    requests++;
    if (requests === 1) {
      res.writeHead(503);
      res.end("busy");
    } else {
      res.writeHead(200);
      res.end("ok");
    }
  });
  try {
    const res = await fetchWithRetry(url + "/recover", {timeoutMs: 1000, retries: 2, backoffMs: 10});
    assert.equal(res.ok, true);
    assert.equal(requests, 2);
  } finally {
    await close(server);
  }
});

test("withDeadline passes through fast work", async () => {
  assert.equal(await withDeadline(Promise.resolve(42), {timeoutMs: 1000, label: "fast"}), 42);
  assert.equal(await withDeadline(async () => 7, {timeoutMs: 1000, label: "fast-fn"}), 7);
});

test("withDeadline rejects work that exceeds its deadline", async () => {
  const started = Date.now();
  await assert.rejects(
    () => withDeadline(new Promise(() => {}), {timeoutMs: 100, label: "wedged-db"}),
    (error) => error instanceof DeadlineExceededError && error.code === "ETIMEDOUT"
  );
  assert.ok(Date.now() - started < 2000, "deadline must fire near the timeout, not hang");
});

test("withDeadline validates its timeout", async () => {
  await assert.rejects(
    () => withDeadline(Promise.resolve(1), {timeoutMs: 0}),
    /timeoutMs/
  );
});
