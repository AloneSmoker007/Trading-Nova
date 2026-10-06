/**
 * scripts/lib/require-env.js
 *
 * Operator-friendly environment validation for the CLI scripts.
 *
 * Why this exists: `load-test.js`, `observability-smoke.js` and `migrate.js`
 * used to `throw new Error("<VAR> is required")` at module load, which printed a
 * raw Node stack trace to whoever ran `npm run <script>`. For a repo whose whole
 * point is operational evidence and fail-closed behaviour, an unhandled stack
 * trace is the wrong operator experience: it looks like a crash rather than a
 * missing prerequisite.
 *
 * Design:
 *   - `checkEnv` is PURE and deterministic (takes `env` as an argument) so it is
 *     unit-testable without touching `process`.
 *   - `requireEnv` is the thin CLI wrapper: it prints an actionable message and
 *     exits with code 1. Exit code 1 is deliberate — ops tooling and CI must see
 *     the run as failed, not silently succeed.
 *
 * No secrets are read, stored, logged or echoed here. Only presence is checked.
 */

/**
 * Pure check. Never throws, never calls process.
 *
 * @param {string} name        environment variable name
 * @param {Record<string,string|undefined>} env
 * @param {{example?:string, hint?:string, allowEmpty?:boolean}} [opts]
 * @returns {{ok:true, value:string} | {ok:false, message:string}}
 */
export function checkEnv(name, env = process.env, opts = {}) {
  if (typeof name !== "string" || name.trim() === "") {
    return {ok:false, message:"checkEnv: name must be a non-empty string"};
  }
  const raw = env ? env[name] : undefined;
  const value = typeof raw === "string" ? raw.trim() : "";
  const allowEmpty = opts.allowEmpty === true;
  if (value !== "" || allowEmpty) {
    return {ok:true, value: allowEmpty ? value : raw};
  }
  const lines = [
    "",
    `  [missing configuration] Required environment variable ${name} is not set.`,
    ""
  ];
  if (opts.hint) lines.push(`    why:    ${opts.hint}`);
  if (opts.example) lines.push(`    example: ${opts.example}`);
  lines.push(
    `    set it: ${name}=<value> npm run <script>`,
    "",
    "  This run did nothing and must not be treated as evidence.",
    ""
  );
  return {ok:false, message:lines.join("\n")};
}

/**
 * CLI wrapper: prints the actionable message and exits 1 when missing.
 * Returns the trimmed value when present.
 *
 * @param {string} name
 * @param {{example?:string, hint?:string, allowEmpty?:boolean}} [opts]
 * @returns {string}
 */
export function requireEnv(name, opts = {}) {
  const result = checkEnv(name, process.env, opts);
  if (result.ok) return result.value;
  process.stderr.write(result.message + "\n");
  // Exit cleanly instead of throwing: a missing prerequisite is not a crash.
  process.exit(1);
}
