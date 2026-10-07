/**
 * scripts/secret-scan.js
 *
 * High-confidence credential scanner for the working tree (CI gate:
 * `npm run security:secrets`). This file is the security gate for the repo, so
 * it must never be weakened to make a run pass. If it flags something, fix the
 * data (rotate + scrub), not the scanner.
 *
 * Design (post 2026-10 hardening):
 *   - Scans every text-ish file: source, config, docs AND the previously
 *     skipped credential-bearing types (`.example`, `.pem`, `.key`, `.sh`, ...).
 *   - Matches both vendor-shaped credentials (OpenAI/GitHub/AWS/Google/Slack/
 *     Stripe/JWT/Telegram/private keys/credentialed URLs) and GENERIC
 *     credential assignments (`API_KEY=`, `SECRET=`, `TOKEN=`, `PASSWORD=`,
 *     `PRIVATE_KEY=`, including prefixed names such as `MY_API_KEY=`).
 *   - The CI placeholder allowlist (the throwaway `postgres:postgres@localhost`
 *     service credentials used by GitHub Actions) is only applied to files
 *     under `.github/workflows/`. The same string anywhere else is a finding —
 *     a real localhost credential must never be silently whitelisted.
 *   - The scanner prints only the pattern name and the path, never the matched
 *     secret itself.
 *   - Placeholder-shaped values (your-*, *-MARKER-*, EXAMPLE/PLACEHOLDER/...)
 *     are excluded so docs and test fixtures stay quiet without opening a hole
 *     for realistic values.
 *
 * Scope note: the working tree only — git history is out of scope by policy
 * (see SECURITY.md: leaked keys are rotated and history scrubbed).
 */
import {readFile, readdir} from "node:fs/promises";
import {join, relative, extname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const IGNORED_DIRS = new Set([".git", "node_modules", "coverage", ".next", "dist", "build"]);
const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".yml", ".yaml", ".html", ".css",
  ".sql", ".env", ".toml", ".ini",
  // Credential-bearing types that used to be skipped entirely:
  ".example", ".pem", ".key", ".crt", ".p8", ".p12", ".pfx", ".sh", ".bash", ".zsh",
  ".properties", ".log", ".ts"
]);

// Allowlist: well-known FAKE credentials used by the GitHub Actions postgres service
// (user postgres / password postgres, loopback host only, trading_nova_* database names).
// These are placeholders documented in .github/workflows/*.yml and are never real secrets.
// IMPORTANT: this stripping is applied ONLY to workflow files (see isWorkflowFile).
// Outside .github/workflows/ the same URI is a finding, not a placeholder.
const CI_PLACEHOLDER_URI = /postgres(?:ql)?:\/\/postgres:postgres@(?:localhost|127\.0\.0\.1):\d+\/trading_nova_[a-z_]+/g;
const isWorkflowFile = (relPath) => /(^|[\\/])\.github[\\/]workflows[\\/]/.test(relPath);

// Placeholder-shaped values (docs examples, test markers) are excluded from the
// generic pattern: start-of-value words like your-*/EXAMPLE/DUMMY and marker-style
// substrings (MARKER/PLACEHOLDER/...). Realistic random secrets do not contain them.

// Generic credential assignment: `API_KEY=`, `MY_SECRET=`, `token:`, `DB_PASSWORD=`,
// `client_secret=`, `PRIVATE_KEY=` etc. with a realistic (16+ charset) value.
// Prefixed names are matched so `OBSERVABILITY_TOKEN=...` is caught too.
const GENERIC_CREDENTIAL_ASSIGNMENT =
  /(?<![A-Za-z0-9])[A-Za-z0-9_]*(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|secret|token|password|passwd)\s*[:=]\s*["'`]?(?![A-Za-z0-9_\-/+=]{0,64}(?:marker|placeholder|example|sample|dummy|changeme|redacted|obscured|not[_-]?a[_-]?real|xxx{3,}))(?!your[_-]|change[_-]|replace[_-]|insert[_-]|example|placeholder|sample|dummy|fake|redacted|<[a-z_]+>|\$\{|\$\(|%)[A-Za-z0-9_\-/+=]{16,}/i;

const HIGH_CONFIDENCE_PATTERNS = [
  {name:"OpenAI key", regex:/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/},
  {name:"GitHub token", regex:/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/},
  {name:"GitHub fine-grained token", regex:/\bgithub_pat_[A-Za-z0-9_]{20,}\b/},
  {name:"AWS access key", regex:/\bAKIA[0-9A-Z]{16}\b/},
  {name:"Google API key", regex:/\bAIza[0-9A-Za-z_-]{30,}\b/},
  {name:"Slack token", regex:/\bxox[baprs]-[0-9A-Za-z-]{20,}\b/},
  {name:"Slack webhook URL", regex:/\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/},
  {name:"Stripe live key", regex:/\bsk_live_[0-9A-Za-z]{20,}\b/},
  {name:"JSON Web Token", regex:/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/},
  {name:"Telegram bot token", regex:/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/},
  {name:"Private key", regex:/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ED25519 )?PRIVATE KEY-----/},
  {name:"PostgreSQL password URI", regex:/\bpostgres(?:ql)?:\/\/[^\s/:@]+:[^\s/@]+@/i},
  {name:"Credentialed HTTP URL", regex:/\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/i},
  {name:"Binance credential assignment", regex:/\b(?:BINANCE|MBX)[A-Z0-9_]*(?:API[_-]?KEY|SECRET|PRIVATE[_-]?KEY)\s*[:=]\s*["'`]?(?!\$\{|<|>)(?!YOUR_|CHANGE_|REPLACE_)[A-Za-z0-9_\-+/=]{16,}/i},
  {name:"Generic credential assignment", regex:GENERIC_CREDENTIAL_ASSIGNMENT}
];

/** True when a file should be read and scanned (by extension or extension-less). */
export function isScannablePath(path) {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || !extname(path);
}

/**
 * Scan raw file content. Returns [{name, path}] findings.
 * `relPath` decides whether the CI-placeholder allowlist applies (workflow files only).
 * Never returns the matched secret text.
 */
export function scanText(text, relPath = "") {
  const findings = [];
  const scanTextBody = isWorkflowFile(relPath) ? text.replace(CI_PLACEHOLDER_URI, "") : text;
  for (const pattern of HIGH_CONFIDENCE_PATTERNS) {
    if (pattern.regex.test(scanTextBody)) findings.push({pattern: pattern.name, path: relPath});
  }
  return findings;
}

/** Recursively scan a directory tree. Returns all findings. */
export async function scanDirectory(root) {
  const findings = [];
  await scanDir(root, root, findings);
  return findings;
}

async function scanDir(root, dir, findings) {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDir(root, path, findings);
      continue;
    }
    if (!entry.isFile() || !isScannablePath(path)) continue;
    let text;
    try { text = await readFile(path, "utf8"); } catch { continue; }
    findings.push(...scanText(text, relative(root, path)));
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  const findings = await scanDirectory(root);
  if (findings.length) {
    for (const finding of findings) console.error("Potential secret:", finding.pattern, finding.path);
    process.exitCode = 1;
  } else {
    console.log("Secret scan passed: no high-confidence credential patterns found.");
  }
}
