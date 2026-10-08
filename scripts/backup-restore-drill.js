import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promises as fs} from "node:fs";
import {promisify} from "node:util";
import {Client} from "pg";
import {createPostgresStore} from "../src/persistence/postgres.js";

const exec=promisify(execFile);
const sourceUrl=process.env.POSTGRES_URL;
const restoreUrl=process.env.POSTGRES_RESTORE_URL;
const artifact=process.env.BACKUP_FILE || "/tmp/trading-nova-backup.dump";
if(!sourceUrl || !restoreUrl) throw new Error("POSTGRES_URL and POSTGRES_RESTORE_URL required");

async function run(command,args){ await exec(command,args,{env:process.env}); }
async function sha256(path){ const data=await fs.readFile(path); return createHash("sha256").update(data).digest("hex"); }
async function ensureDatabase(){
  const target=new URL(restoreUrl);
  const db=target.pathname.slice(1);
  if(!db) throw new Error("restore database required");
  target.pathname="/postgres";
  const admin=new Client({connectionString:target.toString()});
  await admin.connect();
  try{ const exists=await admin.query("SELECT 1 FROM pg_database WHERE datname=$1",[db]); if(!exists.rowCount) await admin.query('CREATE DATABASE "'+db.replace(/"/g,'""')+'"'); }
  finally{ await admin.end(); }
}

await run("pg_dump",["--format=custom","--no-owner","--no-acl","--file",artifact,sourceUrl]);
const beforeHash=await sha256(artifact);
const manifest={version:1,format:"custom",sha256:beforeHash};
await fs.writeFile(artifact+".manifest.json",JSON.stringify(manifest)+"\n");
const manifestOnDisk=JSON.parse(await fs.readFile(artifact+".manifest.json","utf8"));
if(manifestOnDisk.sha256!==await sha256(artifact)) throw new Error("backup artifact hash mismatch");
await ensureDatabase();
await run("pg_restore",["--clean","--if-exists","--no-owner","--no-acl","--dbname",restoreUrl,artifact]);

const store=await createPostgresStore({connectionString:restoreUrl,max:2});
try{
  if(!await store.health()) throw new Error("restored database health check failed");
  if(!await store.verifyAudit()) throw new Error("restored audit chain failed verification");
  const migrations=await store.pool.query("SELECT count(*)::int AS count FROM trading_schema_migrations");
  if(migrations.rows[0].count<1) throw new Error("restored migration state missing");
  const state=await store.pool.query("SELECT value FROM trading_state WHERE namespace=$1 AND state_id=$2",["recovery-drill","sentinel"]);
  if(state.rows[0]?.value?.value!=="phase3") throw new Error("restored sentinel missing");
} finally { await store.pool.end(); }
console.log(JSON.stringify({passed:true,artifactSha256:beforeHash,restoreVerified:true}));
