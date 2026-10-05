import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {pathToFileURL} from "node:url";

const run = promisify(execFile);

test("load-test main module fails fast without LOAD_TEST_URL", async () => {
  await assert.rejects(
    run(process.execPath, ["scripts/load-test.js"], {
      env: {...process.env, LOAD_TEST_URL: ""},
    }),
    (err) => {
      assert.equal(err.code, 1, "expected exit code 1");
      assert.match(err.stderr, /LOAD_TEST_URL is required/);
      return true;
    },
  );
});

test("load-test module import does not execute main (main-module gating)", async () => {
  const mod = await import(pathToFileURL("scripts/load-test.js").href);
  assert.equal(typeof mod.runLoadTest, "function", "runLoadTest must be exported");
});

test("load-test runLoadTest validates url parameter", async () => {
  const {runLoadTest} = await import(pathToFileURL("scripts/load-test.js").href);
  await assert.rejects(() => runLoadTest({url: ""}), /LOAD_TEST_URL is required/);
});
