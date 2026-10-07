import {readdir,readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createPostgresStore} from "../src/persistence/postgres.js";
import {requireEnv} from "./lib/require-env.js";
import {withDeadline, DeadlineExceededError} from "./lib/deadline.js";

const connectionString=requireEnv("POSTGRES_URL",{
  hint:"PostgreSQL connection string for the canonical trading_* schema (embed credentials in the URL; never commit it)",
  example:"POSTGRES_URL=postgresql://localhost:5432/trading_nova npm run db:migrate"
});

// H-sec-1: a migration must fail loudly rather than hang a wedged connection.
// Per-statement guard (DB side) + overall deadline (client side).
const statementTimeoutMs=Math.max(1000,Number(process.env.MIGRATE_STATEMENT_TIMEOUT_MS??30000));
const lockTimeoutMs=Math.max(1000,Number(process.env.MIGRATE_LOCK_TIMEOUT_MS??10000));
const deadlineMs=Math.max(statementTimeoutMs,Number(process.env.MIGRATE_DEADLINE_MS??120000));

const root=path.dirname(fileURLToPath(import.meta.url));
const dir=path.resolve(root,"../db/migrations");

// 001_core.sql is a legacy schema from an earlier architecture (trading_nova.*).
// The canonical persistence adapter uses the trading_* schema created by 001_initial.sql.
// Keep the legacy file for historical visibility, but never apply it to a fresh database.
const LEGACY_MIGRATIONS = new Set(["001_core.sql"]);
const files=(await readdir(dir))
  .filter(x=>x.endsWith(".sql") && !LEGACY_MIGRATIONS.has(x))
  .sort();

const store=await createPostgresStore({connectionString});
try{
  await withDeadline(store.withTransaction(async client=>{
    // Transaction-local DB-side timeouts: a single migration statement or lock
    // wait can never hold the advisory-locked transaction open indefinitely.
    await client.query("SELECT set_config('statement_timeout',$1,false)",[String(statementTimeoutMs)]);
    await client.query("SELECT set_config('lock_timeout',$1,false)",[String(lockTimeoutMs)]);
    await client.query("CREATE TABLE IF NOT EXISTS trading_schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const {createHash}=await import("node:crypto");
    for(const file of files){
      const sql=await readFile(path.join(dir,file),"utf8");
      const checksum=createHash("sha256").update(sql).digest("hex");
      const existing=await client.query("SELECT checksum FROM trading_schema_migrations WHERE version=$1",[file]);
      if(existing.rowCount){
        if(existing.rows[0].checksum!==checksum) throw new Error(`migration checksum mismatch: ${file}`);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO trading_schema_migrations(version,checksum) VALUES($1,$2)",[file,checksum]);
    }
  }),{timeoutMs:deadlineMs,label:"db:migrate"});
}catch(error){
  if(error instanceof DeadlineExceededError){
    console.error(`
  [db:migrate] Migration exceeded its ${deadlineMs}ms deadline and was aborted.
  The database connection may be wedged or unreachable. Nothing after the
  deadline is applied; re-run after checking connectivity (MIGRATE_DEADLINE_MS
  and MIGRATE_STATEMENT_TIMEOUT_MS can raise the bounds).
`);
    // Best-effort teardown, then exit: a wedged run must not hang CI.
    try{ await Promise.race([store.pool.end(),new Promise(r=>setTimeout(r,2000))]); }catch{}
    process.exit(1);
  }
  throw error;
}
console.log(JSON.stringify({ok:true,migrations:files.length,legacyIgnored:[...LEGACY_MIGRATIONS],statementTimeoutMs,lockTimeoutMs,deadlineMs}));
