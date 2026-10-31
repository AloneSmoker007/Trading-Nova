const ALLOWED_MODES = new Set(["paper", "shadow", "limited-live", "live"]);
const ALLOWED_LEVELS = new Set(["debug", "info", "warn", "error"]);
const ALLOWED_NODE_ENV = new Set(["development", "test", "production"]);

function normalizeEnvValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text === "" ? fallback : text;
}

function looksLikePlaceholder(value) {
  if (typeof value !== "string") return true;
  const text = value.trim();
  if (text === "") return true;
  return /^(?:\<.*\>|SET_IN_HOST_SECRET_MANAGER|REPLACE_WITH_|CHANGE_ME|YOUR_[A-Z0-9_]+|EXAMPLE|DUMMY|PLACEHOLDER|TEST_ONLY|replace-with-|example|dummy|placeholder|changeme|test-value)$/i.test(text)
    || /(?:replace|set.*secret|your_|example|dummy|placeholder|changeme|test-only)/i.test(text);
}

function validateNodeEnv(nodeEnv) {
  const normalized = normalizeEnvValue(nodeEnv, "development").toLowerCase();
  if (!ALLOWED_NODE_ENV.has(normalized)) {
    throw new Error(`Invalid NODE_ENV "${nodeEnv ?? "undefined"}". Allowed values: ${[...ALLOWED_NODE_ENV].join(", ")}`);
  }
  return normalized;
}

function readConfig(env = process.env) {
  const mode = normalizeEnvValue(env.TRADING_MODE, "paper").toLowerCase();
  const level = normalizeEnvValue(env.LOG_LEVEL, "info").toLowerCase();
  const nodeEnv = validateNodeEnv(env.NODE_ENV ?? "development");

  if (!ALLOWED_MODES.has(mode)) {
    throw new Error(`Invalid TRADING_MODE "${mode}". Allowed values: ${[...ALLOWED_MODES].join(", ")}`);
  }

  if (!ALLOWED_LEVELS.has(level)) {
    throw new Error(`Invalid LOG_LEVEL "${level}". Allowed values: ${[...ALLOWED_LEVELS].join(", ")}`);
  }

  return Object.freeze({
    tradingMode: mode,
    mode,
    logLevel: level,
    level,
    nodeEnv,
    liveEnabled: mode === "limited-live" || mode === "live"
  });
}

function validateProductionConfig(env = process.env) {
  const nodeEnv = normalizeEnvValue(env.NODE_ENV, "development").toLowerCase();
  if (nodeEnv !== "production") return;

  const password = env.NOVA_ACCESS_PASSWORD;
  if (typeof password !== "string" || password.trim() === "" || password.length < 12 || password.length > 256 || looksLikePlaceholder(password)) {
    throw new Error("NOVA_ACCESS_PASSWORD must be a non-placeholder string between 12 and 256 characters in hosted production mode.");
  }

  const secret = env.NOVA_SESSION_SECRET;
  if (typeof secret !== "string" || secret.trim() === "" || Buffer.byteLength(secret) < 32 || looksLikePlaceholder(secret)) {
    throw new Error("NOVA_SESSION_SECRET must be a non-placeholder value at least 32 bytes in hosted production mode.");
  }

  const dbUrl = env.POSTGRES_URL;
  if (typeof dbUrl !== "string" || dbUrl.trim() === "" || looksLikePlaceholder(dbUrl)) {
    throw new Error("POSTGRES_URL must be a non-empty, non-placeholder database connection string in hosted production mode.");
  }

  const portText = normalizeEnvValue(env.NOVA_PORT, "7411");
  if (!/^\d+$/.test(portText)) {
    throw new Error("NOVA_PORT must be a numeric TCP port between 0 and 65535 in hosted production mode.");
  }

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("NOVA_PORT must be a numeric TCP port between 0 and 65535 in hosted production mode.");
  }

  return Object.freeze({
    nodeEnv,
    password: true,
    secret: true,
    dbUrl: true,
    port
  });
}

export {readConfig, validateProductionConfig, ALLOWED_MODES, ALLOWED_LEVELS};
