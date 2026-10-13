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
  fetchImpl: async () => new Response("{}", {status: 503}),
  stateFile: join(tempDir, "paper-state.json"),
  executionStateFile: join(tempDir, "paper-orders.json"),
  tradingMode: "paper"
});
const requestBodies = [];
const orderOffsets = [];
let orderHistoryMode = "pages";

function fillsForPage(offset, limit = 10) {
  const total = 25;
  const fills = [];
  for (let rank = Math.min(total, offset + limit); rank > offset; rank -= 1) {
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

        await status.getByText("Showing 1–10 of 25 fills").waitFor();
        await rows.first().getByText("TEST25").waitFor();
        assert.equal(await previous.isDisabled(), true);
        assert.equal(await next.isDisabled(), false);

        await next.click();
        assert.equal(await next.isDisabled(), true, "Next is disabled during the in-flight request");
        await status.getByText("Showing 11–20 of 25 fills").waitFor();
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

    await run("paper-order UI keeps unsupported types disabled and renders a Risk Gate NO TRADE", async () => {
      orderHistoryMode = "pages";
      requestBodies.length = 0;
      const page = await openDashboard(browser, baseUrl);
      try {
        for (const value of ["LIMIT", "STOP_LOSS", "TAKE_PROFIT"]) {
          assert.equal(
            await page.locator("#order-type option[value='" + value + "']").isDisabled(),
            true,
            value + " remains unavailable until its lifecycle is implemented"
          );
        }

        await page.locator("#order-quantity").fill("0.001");
        await page.locator("#order-price").fill("42000.5");
        await page.getByRole("button", {name: "Submit Paper Order"}).click();
        await page.getByText("NO TRADE", {exact: true}).waitFor();

        assert.equal(requestBodies.length, 1);
        assert.equal(requestBodies[0].type, "MARKET");
        assert.equal(typeof requestBodies[0].idempotencyKey, "string");
        assert.ok(requestBodies[0].idempotencyKey.length > 0);
        assert.match(await page.locator("#order-note").innerText(), /MAX_POSITION/);
        assert.match(await page.locator("#order-note").innerText(), /No order was placed\./);
        assert.match(await page.locator("#paper-banner").innerText(), /real money OFF/i);
      } finally {
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
