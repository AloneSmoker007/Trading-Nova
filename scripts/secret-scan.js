import {readFile, readdir} from "node:fs/promises";
import {join, relative, extname} from "node:path";

const ROOT = process.cwd();
const IGNORED_DIRS = new Set([".git", "node_modules", "coverage", ".next", "dist", "build"]);
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".yml", ".yaml", ".html", ".css", ".sql", ".env", ".toml", ".ini"]);
const HIGH_CONFIDENCE_PATTERNS = [
  {name:"OpenAI key", regex:/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/},
  {name:"GitHub token", regex:/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/},
  {name:"GitHub fine-grained token", regex:/\bgithub_pat_[A-Za-z0-9_]{20,}\b/},
  {name:"AWS access key", regex:/\bAKIA[0-9A-Z]{16}\b/},
  {name:"Google API key", regex:/\bAIza[0-9A-Za-z_-]{30,}\b/},
  {name:"Slack token", regex:/\bxox[baprs]-[0-9A-Za-z-]{20,}\b/},
  {name:"Private key", regex:/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ED25519 )?PRIVATE KEY-----/},
  {name:"PostgreSQL password URI", regex:/\bpostgres(?:ql)?:\/\/[^\s/:@]+:[^\s/@]+@/i},
  {name:"Credentialed HTTP URL", regex:/\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/i},
  {name:"Binance credential assignment", regex:/\b(?:BINANCE|MBX)[A-Z0-9_]*(?:API[_-]?KEY|SECRET|PRIVATE[_-]?KEY)\s*[:=]\s*["'`]?(?!\$\{|<|>)(?!YOUR_|CHANGE_|REPLACE_)[A-Za-z0-9_\-+/=]{16,}/i}
];

function isText(path) {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || !extname(path);
}

async function scanDir(dir, findings) {
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDir(path, findings);
      continue;
    }
    if (!entry.isFile() || !isText(path)) continue;
    let text;
    try { text = await readFile(path, "utf8"); } catch { continue; }
    // Known non-secret: ephemeral CI container credentials (localhost-only, throwaway DB).
    // Documented allowlist entry, not a hidden finding — see audits/security.md.
    const scanText = text.replace(/postgres(?:ql)?:\/\/postgres:postgres@(?:localhost|127\.0\.0\.1):\d+\/trading_nova_[A-Za-z0-9_]+/g, "");
    for (const pattern of HIGH_CONFIDENCE_PATTERNS) {
      if (pattern.regex.test(scanText)) findings.push({pattern:pattern.name,path:relative(ROOT,path)});
    }
  }
}

const findings = [];
await scanDir(ROOT, findings);
if (findings.length) {
  for (const finding of findings) console.error("Potential secret:", finding.pattern, finding.path);
  process.exitCode = 1;
} else {
  console.log("Secret scan passed: no high-confidence credential patterns found.");
}
