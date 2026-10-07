/**
 * tests/ws-c-secret-scan.test.js
 *
 * Regression coverage for the hardened secret scanner (M2):
 *   - generic credential assignments (`API_KEY=`, `SECRET=`, `TOKEN=`,
 *     `PASSWORD=`, `PRIVATE_KEY=`) are caught;
 *   - credential-bearing file types (`.env.example`, `.pem`, `.sh`, `.key`) are
 *     scanned instead of skipped;
 *   - the CI placeholder allowlist only applies to workflow files;
 *   - clean files and placeholder-shaped values stay quiet;
 *   - the repository working tree itself stays clean under the hardened rules.
 *
 * NOTE: every fake credential below is assembled at runtime from short
 * fragments. Literal secrets in this source would (correctly!) make
 * `npm run security:secrets` fail on the test file itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {scanDirectory, scanText, isScannablePath} from "../scripts/secret-scan.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TESTS_DIR, "..");

const piece = (...parts) => parts.join("");
const FAKE_API_KEY = piece("q7Zx", "9Kd2", "Lm4T", "Rv8W", "pY3n", "Hs6J");
const FAKE_SECRET = piece("z9Y8", "x7W6", "v5U4", "t3S2", "r1Q0", "pO9I");
const FAKE_TOKEN = piece("c3V6", "b2R5", "n1M0", "k8L2", "j7H3", "g5F1");
const FAKE_PASSWORD = piece("q1w2", "e3r4", "t5y6", "u7i8", "o0p1", "a2s3");
const FAKE_PRIVATE_KEY = piece("aBcD", "eFgH", "iJkL", "mNoP", "qRsT", "uVwX");
const PEM_HEADER = piece("-----BEGIN ", "PRIVATE ", "KEY-----");
const PEM_BODY = piece("MIIEvQ", "IBADANBgkq", "hkiG9w0BAQEF", "AAOCAQ8AMIIBCgKCAQEA");
const CI_DB_URI = piece("postgres", "ql://", "postgres:postgres@", "localhost:5432/", "trading_nova_ci");
const FAKE_OPENAI = piece("sk-", "proj-", "T3BlbkFJVc2", "VyQ29udGV4dF", "N0cmluZ1ZhbHV");

async function withFixtureDir(files, fn) {
  const dir = await mkdtemp(join(TESTS_DIR, ".ws-c-fixtures-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const target = join(dir, rel);
      await mkdir(dirname(target), {recursive: true});
      await writeFile(target, content);
    }
    return await fn(dir);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

const names = (findings) => findings.map((f) => f.pattern);

test("scanner scans credential-bearing file types that used to be skipped", () => {
  for (const p of ["secrets.env.example", "deploy.sh", "server.pem", "server.key", "notes.md", "config.yml", "plain"]) {
    assert.equal(isScannablePath(p), true, p + " must be scanned");
  }
  assert.equal(isScannablePath("logo.png"), false, "binary types stay out of scope");
});

test("catches generic credential assignments (API_KEY/SECRET/TOKEN/PASSWORD/PRIVATE_KEY)", () => {
  const cases = [
    piece("API_", "KEY=", FAKE_API_KEY),
    piece("MY_", "SECRET=", FAKE_SECRET),
    piece("ACCESS_", "TOKEN=", FAKE_TOKEN),
    piece("DB_", "PASSWORD=", FAKE_PASSWORD),
    piece("PRIVATE_", "KEY=", FAKE_PRIVATE_KEY)
  ];
  for (const content of cases) {
    const findings = scanText(content + "\n", "notes.txt");
    assert.ok(findings.length > 0, "must flag: " + content.slice(0, 8));
    assert.ok(names(findings).includes("Generic credential assignment"), names(findings).join(","));
  }
});

test("catches a secret inside a .env.example file (end to end)", async () => {
  await withFixtureDir({
    "secrets.env.example": piece("NODE_ENV=development\nAPI_", "KEY=", FAKE_API_KEY, "\n")
  }, async (dir) => {
    const findings = await scanDirectory(dir);
    assert.ok(findings.length > 0, ".env.example secret must be flagged");
    assert.equal(findings[0].path, "secrets.env.example");
  });
});

test("catches a private key inside a .pem file (end to end)", async () => {
  await withFixtureDir({
    "server.pem": piece(PEM_HEADER, "\n", PEM_BODY, "\n-----END ", "PRIVATE ", "KEY-----\n")
  }, async (dir) => {
    const findings = await scanDirectory(dir);
    assert.ok(findings.some((f) => f.pattern === "Private key"), JSON.stringify(names(findings)));
  });
});

test("catches a vendor key inside a .sh file (end to end)", async () => {
  await withFixtureDir({
    "deploy.sh": piece("#!/bin/sh\nexport OPENAI_API_", "KEY=", FAKE_OPENAI, "\n")
  }, async (dir) => {
    const findings = await scanDirectory(dir);
    assert.ok(findings.some((f) => f.pattern === "OpenAI key"), JSON.stringify(names(findings)));
  });
});

test("clean files produce zero findings", async () => {
  await withFixtureDir({
    "README.md": "Just some prose about the deployment process.\n",
    "config.yml": piece("mode: paper\napi_", "key: YOUR_KEY_HERE_PLEASE_CHANGE_ME_NOW\n"),
    "clean.env.example": "NODE_ENV=development\nLOG_LEVEL=info\nTRADING_MODE=paper\n",
    "deploy.sh": "echo hello\n",
    "notes.txt": piece("placeholder token: <INSERT_TOKEN_HERE>\n")
  }, async (dir) => {
    const findings = await scanDirectory(dir);
    assert.deepEqual(findings, [], JSON.stringify(names(findings)));
  });
});

test("placeholder and test-marker values stay quiet (docs and fixtures)", () => {
  assert.deepEqual(scanText(piece("API_", "KEY=YOUR_KEY_HERE_PLEASE_CHANGE_ME_NOW\n"), "doc.md"), []);
  assert.deepEqual(scanText(piece("API_", "KEY:", String.fromCharCode(34), "SENSITIVE_MARKER_VALUE", String.fromCharCode(34), "\n"), "t.js"), []);
  assert.deepEqual(scanText(piece("API_", "KEY=", "${API_KEY_VALUE}\n"), "t.js"), []);
  assert.deepEqual(scanText(piece("API_", "KEY=short\n"), "t.js"), []);
});

test("CI placeholder allowlist only applies to workflow files", async () => {
  await withFixtureDir({
    ".github/workflows/ci.yml": piece("env:\n  POSTGRES_URL: ", CI_DB_URI, "\n"),
    "notes.txt": piece("local dsn: ", CI_DB_URI, "\n"),
    "ops.md": piece("connection string ", CI_DB_URI, " used by the runner\n")
  }, async (dir) => {
    const findings = await scanDirectory(dir);
    const flagged = findings.map((f) => f.path).sort();
    assert.deepEqual(flagged, ["notes.txt", "ops.md"], "only non-workflow files may carry the finding");
    assert.equal(flagged.includes(join(".github", "workflows", "ci.yml")), false, "workflow placeholder stays allowed");
  });
});

test("repository working tree is clean under the hardened scanner", async () => {
  const findings = await scanDirectory(REPO_ROOT);
  assert.deepEqual(findings, [], "repo must stay clean: " + JSON.stringify(findings));
});
