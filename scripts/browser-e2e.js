// Real-browser regression checks for the dashboard's highest-risk UI flows.
// Install the pinned Playwright runtime first (see .github/workflows/browser-e2e.yml).
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createNovaServer} from "../server/app.js";
import {chromium} from "playwright";

const tempDir = mkdtempSync(join(tmpdir(), "trading-nova-browser-e2e-"));
const server = createNovaServer({
  fetchImpl: async () => ({ok: false, status: 503, json: async () => ({})}),
  stateFile: join(tempDir, "paper-state.json"),
  executionStateFile: join(tempDir, "paper-orders.json"),
  tradingMode: "paper"
});
const requestBodies = [];
const orderOffsets = [];
let orderHistoryMode = "pages";
let councilMode = "unavailable";
let tutorSetupMode = "unconfigured";
let tutorReplyMode = "grounded";
const tutorRequests = [];
let fixtureWatchlist = ["BTCUSDT", "ETHUSDT"];
let fixtureWatchlistRevision = 0;
let watchlistWriteMode = "ok";
const watchlistWrites = [];
const fixtureThesisHash = "a".repeat(64);

function fillsForPage(offset, limit = 10) {
  const total = 25;
  const fills = [];
  const pageEnd = Math.min(total, offset + limit);
  for (let index = offset; index < pageEnd; index += 1) {
    const rank = total - index;
    fills.push({
      id: "fixture-fill-" + rank,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, rank)).toISOString(),
      symbol: "TEST" + rank,
      side: rank % 2 === 0 ? "BUY" : "SELL",
      quantity: 0.001,
      price: 50000 + rank,
      fee: 0.05,
      feeRate: 0.001,
      slippageBps: 5,
      spreadBps: 2,
      status: "RECONCILED"
    });
  }
  return fills;
}

async function installApiFixtures(page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname === "/api/markets") {
      await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({ok: true, data: {
        state: fixtureWatchlist.length ? "ok" : "empty", symbols: fixtureWatchlist,
        revision: fixtureWatchlistRevision, isDefault: false, count: fixtureWatchlist.length,
        markets: fixtureWatchlist.map(symbol => ({symbol, state: "ok", last: 50000, volume24h: 100,
          changePct24h: 1, stale: false, ageMs: 0}))
      }})});
      return;
    }

    if (pathname === "/api/watchlist" && request.method() === "PUT") {
      const input = request.postDataJSON();
      watchlistWrites.push(input);
      if (watchlistWriteMode === "offline") {await route.abort("failed"); return;}
      if (watchlistWriteMode === "conflict") {
        fixtureWatchlist = ["SOLUSDT"];
        fixtureWatchlistRevision++;
        await route.fulfill({status: 409, contentType: "application/json", body: JSON.stringify({ok: false,
          error: {code: "watchlist-conflict", message: "Fixture concurrent edit"}})});
        return;
      }
      fixtureWatchlist = input.symbols;
      fixtureWatchlistRevision++;
      await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({ok: true,
        data: {symbols: fixtureWatchlist, revision: fixtureWatchlistRevision}})});
      return;
    }

    if (pathname === "/api/tutor/status") {
      if (tutorSetupMode === "offline") {
        await route.abort("failed");
        return;
      }
      await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({
        ok: true, data: {configured: tutorSetupMode !== "unconfigured",
          configuration: tutorSetupMode === "unconfigured" ? "missing-credentials" : "configured",
          connection: "not-checked", webResearchEnabled: tutorSetupMode !== "web-off", mode: "paper-only"}
      })});
      return;
    }

    if (pathname === "/api/tutor/chat" && request.method() === "POST") {
      tutorRequests.push(request.postDataJSON());
      const unavailable = tutorReplyMode === "uncited";
      await route.fulfill({status: unavailable ? 503 : 200, contentType: "application/json", body: JSON.stringify(unavailable ? {
        ok: false, state: "unavailable", error: {code: "tutor-sources-unavailable", message: "Web sources nahi mile; current answer unavailable."}
      } : {ok: true, data: {answer: "Source-backed fixture explanation.", research: "grounded", researchMode: "required-sources",
        sources: [{title: "Fixture research", url: "https://example.com/research"}],
        evidence: {state: tutorReplyMode === "sources-only" ? "sources-only" : "claim-attributed",
          sourceDetails: [{id: "S1", sourceIndex: 0, retrievedAt: 123, publishedAt: null}],
          claims: tutorReplyMode === "sources-only" ? [] : [{text: "Source-backed fixture explanation.", start: 0, end: "Source-backed fixture explanation.".length, sourceIds: ["S1"]}]}, note: "Returned fixture sources; no paper order submitted."}})});
      return;
    }

    if (pathname === "/api/journal" && request.method() === "GET") {
      await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({
        ok: true,
        data: {
          state: "ok", verified: true, integrity: "verified", total: 1, returned: 1,
          entries: [{
            index: 0, previousHash: "GENESIS", hash: fixtureThesisHash,
            entry: {timestamp: 123, type: "thesis", symbol: "BTCUSDT", title: "Browser verified thesis", text: "Fixture only"}
          }],
          note: "Verified browser fixture journal."
        }
      })});
      return;
    }

    if (pathname.startsWith("/api/ai/council/")) {
      if (councilMode === "offline") {
        await route.abort("failed");
        return;
      }
      const unavailable = councilMode === "unavailable";
      const stale = councilMode === "stale";
      await route.fulfill({
        status: unavailable ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify(unavailable ? {
          ok: false, state: "unavailable",
          error: {code: "council-data-unavailable", message: "Fixture market data unavailable"}
        } : {
          ok: true,
          data: {state: stale ? "stale" : "ok", council: {
            opportunityScore: stale ? null : 78,
            decision: stale ? "WAIT" : "RESEARCH_READY",
            uncertainty: stale ? "High" : "low",
            roles: [{displayName: "Technical indicators", displayStatus: "FIXTURE", score: 78,
              reason: "Deterministic browser fixture", basis: "Synthetic test input only"}],
            explanation: stale ? "WAIT/NO-TRADE: stale market snapshot." : "Fresh fixture research.",
            dataCoverage: {note: "Fixture: no live news feed connected."}
          }}
        })
      });
      return;
    }

    if (pathname === "/api/paper/orders" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true, state: "ok",
          data: {state: "ok", orders: [], total: 0, pendingCount: 0, note: "Paper only; real money OFF."}
        })
      });
      return;
    }

    if (pathname === "/api/orders" && request.method() === "GET") {
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 10);
      orderOffsets.push(offset);

      if (orderHistoryMode === "error") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            state: "unavailable",
            error: {code: "fixture-unavailable", message: "Fixture history unavailable"}
          })
        });
        return;
      }

      if (orderHistoryMode === "empty") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            state: "ok",
            data: {fills: [], total: 0, offset: 0, limit, hasMore: false}
          })
        });
        return;
      }

      // Keep a small delay so the UI's in-flight disabled state is observable.
      await new Promise((resolve) => setTimeout(resolve, 120));
      const fills = fillsForPage(offset, limit);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          state: "ok",
          data: {fills, total: 25, offset, limit, hasMore: offset + fills.length < 25}
        })
      });
      return;
    }

    if (pathname === "/api/paper/orders" && request.method() === "POST") {
      requestBodies.push(request.postDataJSON());
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          state: "rejected",
          error: {code: "risk-gate-rejected", message: "Blocked by browser E2E Risk Gate fixture"},
          verdict: {decision: "NO_TRADE", reasons: ["MAX_POSITION"]}
        })
      });
      return;
    }

    if (pathname === "/api/auth/status") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ok: true, state: "ok", data: {privateAccessEnabled: false}})
      });
      return;
    }

    // All other API calls are deliberately deterministic; this test suite must
    // not depend on live market feeds, AI providers, or any external service.
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        state: "unavailable",
        error: {code: "fixture-unavailable", message: "Unstubbed API in browser E2E"}
      })
    });
  });
}

async function openDashboard(browser, baseUrl) {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  page.setDefaultTimeout(7000);
  await installApiFixtures(page);
  await page.goto(baseUrl, {waitUntil: "domcontentloaded"});
  await page.locator("#orders-page-status").waitFor({state: "visible"});
  await page.locator("#auto-input").uncheck();
  return page;
}

async function run(name, operation) {
  await operation();
  process.stdout.write("ok - " + name + "\n");
}

async function main() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = "http://127.0.0.1:" + address.port + "/";

  const browser = await chromium.launch({headless: true});
  try {
    await run("browser pagination moves across distinct pages and supports keyboard activation", async () => {
      orderHistoryMode = "pages";
      orderOffsets.length = 0;
      const page = await openDashboard(browser, baseUrl);
      try {
        const status = page.locator("#orders-page-status");
        const previous = page.getByRole("button", {name: "Previous fill history page"});
        const next = page.getByRole("button", {name: "Next fill history page"});
        const rows = page.locator("#orders-history-body tr");

        await page.getByText("Showing 1–10 of 25 fills", {exact: true}).waitFor();
        await rows.first().getByText("TEST25").waitFor();
        assert.equal(await previous.isDisabled(), true);
        assert.equal(await next.isDisabled(), false);

        await next.click();
        assert.equal(await next.isDisabled(), true, "Next is disabled during the in-flight request");
        await page.getByText("Showing 11–20 of 25 fills", {exact: true}).waitFor();
        await rows.first().getByText("TEST15").waitFor();
        assert.equal(await previous.isDisabled(), false);

        await previous.click();
        await status.getByText("Showing 1–10 of 25 fills").waitFor();
        await rows.first().getByText("TEST25").waitFor();

        await next.focus();
        await next.press("Enter");
        await status.getByText("Showing 11–20 of 25 fills").waitFor();
        await rows.first().getByText("TEST15").waitFor();

        assert.ok(orderOffsets.includes(0));
        assert.ok(orderOffsets.includes(10));
        assert.equal(await page.locator("#paper-banner").innerText().then((t) => /real money OFF/i.test(t)), true);
      } finally {
        await page.close();
      }
    });

    await run("empty and unavailable order history have honest visible states", async () => {
      orderHistoryMode = "empty";
      const emptyPage = await openDashboard(browser, baseUrl);
      try {
        await emptyPage.getByText("No fills recorded yet.").waitFor();
        assert.equal(await emptyPage.getByRole("button", {name: "Next fill history page"}).isDisabled(), true);
        assert.match(await emptyPage.locator("#orders-note").innerText(), /No real-money order was placed/i);
      } finally {
        await emptyPage.close();
      }

      orderHistoryMode = "error";
      const errorPage = await openDashboard(browser, baseUrl);
      try {
        await errorPage.getByText("Fill history is unavailable.").waitFor();
        assert.equal(await errorPage.getByRole("button", {name: "Next fill history page"}).isDisabled(), true);
      } finally {
        await errorPage.close();
      }
    });

    await run("paper-order UI exposes lifecycle inputs and renders a Risk Gate NO TRADE", async () => {
      orderHistoryMode = "pages";
      requestBodies.length = 0;
      const page = await openDashboard(browser, baseUrl);
      try {
        for (const value of ["LIMIT", "STOP_LOSS", "TAKE_PROFIT"]) {
          assert.equal(
            await page.locator("#order-type option[value='" + value + "']").isDisabled(),
            false,
            value + " should be available in the paper lifecycle"
          );
        }

        await page.locator("#order-type").selectOption("STOP_LOSS");
        assert.equal(await page.locator("#order-stop-price-field").isVisible(), true);
        assert.equal(await page.locator("#order-price-field").isVisible(), false);
        await page.locator("#order-stop-price").fill("41000");
        await page.locator("#order-type").selectOption("TAKE_PROFIT");
        assert.equal(await page.locator("#order-take-profit-price-field").isVisible(), true);
        await page.locator("#order-take-profit-price").fill("43000");
        await page.locator("#order-type").selectOption("MARKET");
        assert.equal(await page.locator("#order-stop-price-field").isVisible(), false);
        assert.equal(await page.locator("#order-take-profit-price-field").isVisible(), false);

        await page.locator("#order-quantity").fill("0.001");
        await page.locator("#order-price").fill("42000.5");
        await page.locator("#order-thesis option", {hasText: "Browser verified thesis"}).waitFor({state: "attached"});
        assert.equal(await page.locator("#order-thesis").isDisabled(), false);
        await page.locator("#order-thesis").selectOption(fixtureThesisHash);
        await page.getByRole("button", {name: "Submit Paper Order"}).click();
        await page.getByText("NO TRADE", {exact: true}).waitFor();

        assert.equal(requestBodies.length, 1);
        assert.equal(requestBodies[0].type, "MARKET");
        assert.equal(requestBodies[0].thesisHash, fixtureThesisHash);
        assert.equal(typeof requestBodies[0].idempotencyKey, "string");
        assert.ok(requestBodies[0].idempotencyKey.length > 0);
        assert.match(await page.locator("#order-note").innerText(), /MAX_POSITION/);
        assert.match(await page.locator("#order-note").innerText(), /No order was placed\./);
        assert.match(await page.locator("#paper-banner").innerText(), /real money OFF/i);
      } finally {
        await page.close();
      }
    });

    await run("AI Council marks stale snapshots and clears prior scores on unavailable or offline data", async () => {
      councilMode = "fresh";
      const page = await openDashboard(browser, baseUrl);
      try {
        await page.locator("#ai-badge").getByText("ANALYZED", {exact: true}).waitFor();
        assert.equal(await page.locator("#ai-score-val").innerText(), "78 / 100");
        await page.locator("#ai-decision-badge").getByText("RESEARCH_READY", {exact: true}).waitFor();

        councilMode = "stale";
        await page.locator("#refresh-btn").click();
        await page.locator("#ai-badge").getByText("STALE SNAPSHOT", {exact: true}).waitFor();
        assert.equal(await page.locator("#ai-score-val").innerText(), "N/A");
        assert.equal(await page.locator("#ai-decision-badge").innerText(), "WAIT");
        assert.equal(await page.locator("#ai-uncertainty-val").innerText(), "HIGH");

        councilMode = "fresh";
        await page.locator("#refresh-btn").click();
        await page.locator("#ai-badge").getByText("ANALYZED", {exact: true}).waitFor();
        assert.equal(await page.locator("#ai-roles-list .ai-role-item").count(), 1);

        councilMode = "unavailable";
        await page.locator("#refresh-btn").click();
        await page.locator("#ai-badge").getByText("UNAVAILABLE", {exact: true}).waitFor();
        assert.equal(await page.locator("#ai-score-val").innerText(), "N/A");
        assert.equal(await page.locator("#ai-decision-badge").innerText(), "WAIT");
        assert.equal(await page.locator("#ai-roles-list .ai-role-item").count(), 0);

        councilMode = "fresh";
        await page.locator("#refresh-btn").click();
        await page.locator("#ai-badge").getByText("ANALYZED", {exact: true}).waitFor();
        councilMode = "offline";
        await page.locator("#refresh-btn").click();
        await page.locator("#ai-badge").getByText("OFFLINE", {exact: true}).waitFor();
        assert.equal(await page.locator("#ai-score-val").innerText(), "N/A");
        assert.equal(await page.locator("#ai-decision-badge").innerText(), "WAIT");
        assert.equal(await page.locator("#ai-roles-list .ai-role-item").count(), 0);
      } finally {
        councilMode = "unavailable";
        await page.close();
      }
    });

    await run("tutor setup is honest and required-source questions handle uncited and grounded replies", async () => {
      tutorSetupMode = "unconfigured";
      tutorRequests.length = 0;
      const page = await openDashboard(browser, baseUrl);
      try {
        await page.getByText("AI setup abhi mukammal nahi. Setup complete hone par dobara check karein.", {exact: true}).waitFor();
        assert.equal(await page.locator("#tutor-send-btn").isDisabled(), true);
        tutorSetupMode = "configured";
        await page.locator("#tutor-check-status-btn").click();
        await page.getByText(/AI setup ready\. Live jawab ki availability sawal bhejne par maloom hogi/).waitFor();
        assert.equal(tutorRequests.length, 0, "setup checks must not submit an AI question");
        assert.equal(await page.locator("#tutor-send-btn").isDisabled(), false);

        await page.locator("#tutor-require-sources").check();
        tutorReplyMode = "uncited";
        await page.locator("#tutor-input").fill("Fixture current news with sources");
        await page.locator("#tutor-send-btn").click();
        await page.locator("#tutor-badge").getByText("UNAVAILABLE", {exact: true}).waitFor();
        assert.equal(tutorRequests[0].researchMode, "required-sources");
        assert.equal(await page.locator("#tutor-messages .tutor-source-link").count(), 0);

        tutorReplyMode = "grounded";
        await page.locator("#tutor-input").fill("Fixture source-backed research");
        await page.locator("#tutor-send-btn").click();
        await page.locator("#tutor-badge").getByText("WEB SOURCES", {exact: true}).waitFor();
        const source = page.locator("#tutor-messages .tutor-source-link");
        assert.equal(await source.getAttribute("href"), "https://example.com/research");
        assert.equal(await source.getAttribute("rel"), "noopener noreferrer");
        assert.equal(tutorRequests.length, 2);
        assert.deepEqual(tutorRequests[1].history, [], "a failed research answer must not become model history");

        const evidence = page.locator(".tutor-evidence").last();
        await evidence.locator("summary").click();
        await evidence.getByText(/Publication date\/freshness unknown/).waitFor();
        assert.equal(await evidence.locator(".tutor-evidence-claim").count(), 1);
        assert.equal(await evidence.locator("a").getAttribute("href"), "https://example.com/research");
        assert.equal(await evidence.locator("a").getAttribute("rel"), "noopener noreferrer");
        tutorReplyMode = "sources-only";
        await page.locator("#tutor-input").fill("Research without claim mapping");
        await page.locator("#tutor-send-btn").click();
        await page.locator(".tutor-evidence").last().getByText("Claim evidence unavailable", {exact: true}).waitFor();
        assert.equal(await page.locator(".tutor-evidence").last().locator(".tutor-evidence-claim").count(), 0);

        tutorSetupMode = "web-off";
        await page.locator("#tutor-check-status-btn").click();
        await page.getByText(/Web research band hai; sources-required sawal available nahi/).waitFor();
        tutorSetupMode = "offline";
        await page.locator("#tutor-check-status-btn").click();
        await page.getByText("AI setup check ke liye connection nahi mila. Dobara try karein.", {exact: true}).waitFor();
        assert.equal(await page.locator("#tutor-send-btn").isDisabled(), true);
        assert.equal(tutorRequests.length, 3);
      } finally {
        tutorSetupMode = "unconfigured";
        tutorReplyMode = "grounded";
        await page.close();
      }
    });

    await run("watchlist adds, reorders, removes, reloads and handles conflicting or unconfirmed saves", async () => {
      fixtureWatchlist = ["BTCUSDT", "ETHUSDT"];
      fixtureWatchlistRevision = 0;
      watchlistWriteMode = "ok";
      watchlistWrites.length = 0;
      const page = await openDashboard(browser, baseUrl);
      const symbols = () => page.locator("#watchlist-grid .watchlist-symbol").allTextContents();
      try {
        await page.getByRole("button", {name: "Remove ETHUSDT", exact: true}).waitFor();
        await page.locator("#watchlist-symbol-input").fill("BTCUSDT");
        await page.locator("#watchlist-add-btn").click();
        assert.equal(watchlistWrites.length, 0, "duplicate client edit is rejected before a write");
        await page.locator("#watchlist-symbol-input").fill("xrpusdt");
        await page.locator("#watchlist-add-btn").click();
        await page.getByRole("button", {name: "Remove XRPUSDT", exact: true}).waitFor();
        assert.deepEqual(await symbols(), ["BTCUSDT", "ETHUSDT", "XRPUSDT"]);
        await page.reload({waitUntil: "domcontentloaded"});
        await page.locator("#auto-input").uncheck();
        await page.getByRole("button", {name: "Remove XRPUSDT", exact: true}).waitFor();
        assert.deepEqual(await symbols(), ["BTCUSDT", "ETHUSDT", "XRPUSDT"]);
        const up = page.getByRole("button", {name: "Move XRPUSDT up", exact: true});
        await up.focus();
        await up.press("Enter");
        await page.getByText("Watchlist saved.", {exact: true}).waitFor();
        assert.deepEqual(await symbols(), ["BTCUSDT", "XRPUSDT", "ETHUSDT"]);
        await page.getByRole("button", {name: "Switch target symbol to XRPUSDT", exact: true}).click();
        assert.equal(await page.locator("#symbol-input").inputValue(), "XRPUSDT");
        assert.equal(await page.locator("#order-symbol").innerText(), "XRPUSDT");
        await page.getByRole("button", {name: "Remove BTCUSDT", exact: true}).click();
        await page.getByText("Watchlist saved.", {exact: true}).waitFor();
        assert.deepEqual(await symbols(), ["XRPUSDT", "ETHUSDT"]);

        watchlistWriteMode = "conflict";
        await page.getByRole("button", {name: "Remove XRPUSDT", exact: true}).click();
        await page.getByText(/List doosre tab mein change hui/).waitFor();
        assert.deepEqual(await symbols(), ["SOLUSDT"]);
        watchlistWriteMode = "offline";
        await page.getByRole("button", {name: "Remove SOLUSDT", exact: true}).click();
        await page.getByText("Save not confirmed. Check the refreshed saved list before retrying.", {exact: true}).waitFor();
        assert.deepEqual(await symbols(), ["SOLUSDT"]);
        watchlistWriteMode = "ok";
        await page.getByRole("button", {name: "Remove SOLUSDT", exact: true}).click();
        await page.getByText("Watchlist khali hai. Upar se market symbol add karein.", {exact: true}).waitFor();
        assert.deepEqual(await symbols(), []);
        await page.locator("#watchlist-symbol-input").fill("BTCUSDT");
        await page.locator("#watchlist-add-btn").click();
        await page.getByRole("button", {name: "Remove BTCUSDT", exact: true}).waitFor();
        assert.equal(fixtureWatchlistRevision, watchlistWrites.length - 1, "offline request must not count as an acknowledged write");
      } finally {
        watchlistWriteMode = "ok";
        await page.close();
      }
    });
  } finally {
    await browser.close();
  }
}

try {
  await main();
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempDir, {recursive: true, force: true});
}
