const REQUIRED = Object.freeze(["DATABASE_URL", "BACKUP_TARGET", "ROLLBACK_TARGET", "OBSERVABILITY_ENDPOINT"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function looksLikePlaceholder(value) {
  if (typeof value !== "string") return true;
  const text = value.trim();
  if (text === "") return true;
  return /^(?:\<.*\>|SET_IN_HOST_SECRET_MANAGER|REPLACE_WITH_|CHANGE_ME|YOUR_[A-Z0-9_]+|EXAMPLE|DUMMY|PLACEHOLDER|TEST_ONLY|replace-with-|example|dummy|placeholder|changeme|test-value)$/i.test(text)
    || /(?:replace|example|dummy|placeholder|changeme|test-only)/i.test(text);
}

export function productionEnvironment(env = process.env) {
  const missing = REQUIRED.filter((key) => !isNonEmptyString(env[key]));
  const placeholders = REQUIRED.filter((key) => isNonEmptyString(env[key]) && looksLikePlaceholder(env[key]));
  return Object.freeze({
    ready: missing.length === 0 && placeholders.length === 0,
    missing,
    placeholders
  });
}
