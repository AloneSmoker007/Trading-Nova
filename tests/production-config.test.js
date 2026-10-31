import test from "node:test";
import assert from "node:assert/strict";

import {readConfig, validateProductionConfig} from "../src/config.js";

const validDevelopmentEnv = {
  NODE_ENV: "development",
  LOG_LEVEL: "info",
  TRADING_MODE: "paper"
};

const validProductionEnv = {
  NODE_ENV: "production",
  LOG_LEVEL: "info",
  TRADING_MODE: "paper",
  NOVA_ACCESS_PASSWORD: "this-is-a-valid-passphrase",
  NOVA_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  POSTGRES_URL: "postgres://user:pass@db.internal:5432/trading_nova",
  NOVA_PORT: "7411"
};

test("readConfig rejects invalid NODE_ENV values", () => {
  assert.throws(() => readConfig({ ...validDevelopmentEnv, NODE_ENV: "qa" }), /NODE_ENV/i);
});

test("readConfig preserves local development defaults", () => {
  const config = readConfig(validDevelopmentEnv);
  assert.equal(config.tradingMode, "paper");
  assert.equal(config.logLevel, "info");
  assert.equal(config.nodeEnv, "development");
});

test("validateProductionConfig rejects placeholder or weak hosted credentials", () => {
  const weak = {
    ...validProductionEnv,
    NOVA_ACCESS_PASSWORD: "replace-with-a-secret",
    NOVA_SESSION_SECRET: "short-secret"
  };
  assert.throws(() => validateProductionConfig(weak), /NOVA_ACCESS_PASSWORD|NOVA_SESSION_SECRET/i);

  const missingDb = { ...validProductionEnv, POSTGRES_URL: "   " };
  assert.throws(() => validateProductionConfig(missingDb), /POSTGRES_URL/i);
});

test("validateProductionConfig rejects invalid network ports", () => {
  assert.throws(() => validateProductionConfig({ ...validProductionEnv, NOVA_PORT: "70000" }), /NOVA_PORT|port/i);
  assert.throws(() => validateProductionConfig({ ...validProductionEnv, NOVA_PORT: "abc" }), /NOVA_PORT|port/i);
});

test("validateProductionConfig accepts valid production configuration", () => {
  assert.doesNotThrow(() => validateProductionConfig(validProductionEnv));
});
