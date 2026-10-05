const REQUIRED = Object.freeze(["DATABASE_URL","BACKUP_TARGET","ROLLBACK_TARGET","OBSERVABILITY_ENDPOINT"]);
export function productionEnvironment(env = process.env) {
  const missing = REQUIRED.filter((key) => typeof env[key] !== "string" || env[key].trim() === "");
  return Object.freeze({ ready: missing.length === 0, missing });
}
