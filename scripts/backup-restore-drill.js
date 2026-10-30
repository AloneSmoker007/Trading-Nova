import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promises as fs} from "node:fs";
import {dirname} from "node:path";
import {promisify} from "node:util";
import {Client} from "pg";
import {createPostgresStore} from "../src/persistence/postgres.js";
import {classifyEnvironment,computeRto,computeRpo,buildBackupRestoreEvidence,labelLocalEvidence} from "./lib/recovery-metrics.js";

const exec=promisify(execFile);
const sourceUrl=process.env.POSTGRES_URL;
const restoreUrl=process.env.POSTGRES_RESTORE_URL;
const artifact=process.env.BACKUP_FILE || "/tmp/trading-nova-backup.dump";
const evidenceOut=process.env.EVIDENCE_OUT || "evidence/backup-restore-rto-rpo.json";
const requireProduction=process.env.EVIDENCE_REQUIRE_PRODUCTION==="1";
const operator=process.env.EVIDENCE_OPERATOR || (process.env.CI ? "unattended-ci" : process.env.USER || "unknown");
if(!sourceUrl || !restoreUrl) throw new Error("POSTGRES_URL and POSTGRES_RESTORE_URL required");

const heartbeatNamespace="recovery-drill";
const heartbeatId="backup-heartbeat";

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

// Writes a monotonic heartbeat into the source database while pg_dump runs, so
// the newest heartbeat present in the restored copy proves exactly how much
// committed data the backup captured — that is the RPO bound.
function startHeartbeat(store,intervalMs=100){
  const state={lastWrittenMs:0,inFlight:false,error:null};
  const beat=async()=>{
    if(state.inFlight) return;
    state.inFlight=true;
    const epochMs=Date.now();
    try{
      await store.put(heartbeatNamespace,heartbeatId,{epochMs,at:new Date(epochMs).toISOString()});
      if(epochMs>state.lastWrittenMs) state.lastWrittenMs=epochMs;
    }
    catch(error){ state.error=error; }
    finally{ state.inFlight=false; }
  };
  // The dump's snapshot is taken when pg_dump starts, so one heartbeat must
  // already be committed before that point or the backup captures none.
  const primed=beat();
  const timer=setInterval(beat,intervalMs);
  return {state,primed,stop:async()=>{ clearInterval(timer); await beat(); }};
}

const drillStartedAt=Date.now();
const environment=classifyEnvironment(sourceUrl);

const source=await createPostgresStore({connectionString:sourceUrl,max:2});
const heartbeat=startHeartbeat(source);
let backupCompletedAt;
try{
  await heartbeat.primed;
  if(heartbeat.state.error) throw new Error("heartbeat writer failed: "+heartbeat.state.error.message);
  await run("pg_dump",["--format=custom","--no-owner","--no-acl","--file",artifact,sourceUrl]);
  backupCompletedAt=Date.now();
} finally {
  await heartbeat.stop();
  await source.pool.end();
}
if(heartbeat.state.error) throw new Error("heartbeat writer failed: "+heartbeat.state.error.message);
const beforeHash=await sha256(artifact);
const manifest={version:1,format:"custom",sha256:beforeHash};
await fs.writeFile(artifact+".manifest.json",JSON.stringify(manifest)+"\n");
const manifestOnDisk=JSON.parse(await fs.readFile(artifact+".manifest.json","utf8"));
if(manifestOnDisk.sha256!==await sha256(artifact)) throw new Error("backup artifact hash mismatch");

const destination=classifyEnvironment(restoreUrl);
const restoreStartedAt=Date.now();
await ensureDatabase();
await run("pg_restore",["--clean","--if-exists","--no-owner","--no-acl","--dbname",restoreUrl,artifact]);
const restoredAt=Date.now();

const store=await createPostgresStore({connectionString:restoreUrl,max:2});
let serviceReadyAt,rto,rpo,incidentToReadyMs,lastDurableMs,serverVersion,migrationCount;
try{
  if(!await store.health()) throw new Error("restored database health check failed");
  if(!await store.verifyAudit()) throw new Error("restored audit chain failed verification");
  const version=await store.pool.query("SHOW server_version");
  serverVersion=version.rows[0]?.server_version ?? null;
  const migrations=await store.pool.query("SELECT count(*)::int AS count FROM trading_schema_migrations");
  migrationCount=migrations.rows[0].count;
  if(migrationCount<1) throw new Error("restored migration state missing");
  const state=await store.pool.query("SELECT value FROM trading_state WHERE namespace=$1 AND state_id=$2",["recovery-drill","sentinel"]);
  if(state.rows[0]?.value?.value!=="phase3") throw new Error("restored sentinel missing");

  serviceReadyAt=Date.now();
  rto=computeRto([{name:"restore",startMs:restoreStartedAt,endMs:restoredAt},{name:"verify",startMs:restoredAt,endMs:serviceReadyAt}]);
  incidentToReadyMs=serviceReadyAt-restoreStartedAt;

  const heartbeat=await store.get(heartbeatNamespace,heartbeatId);
  lastDurableMs=Number(heartbeat?.epochMs);
  if(!Number.isFinite(lastDurableMs)) throw new Error("no heartbeat captured by the backup; RPO cannot be measured");
  rpo=computeRpo({lastDurableAt:lastDurableMs,recoveryPointAt:backupCompletedAt});
} finally { await store.pool.end(); }

const evidence=buildBackupRestoreEvidence({
  environment:environment.environment,
  productionEligible:environment.productionEligible && destination.productionEligible,
  operator,
  artifact,
  drillStartedAt,
  rto,
  rpo,
  incidentToReadyMs,
  requireProduction,
  details:{
    artifactSha256:beforeHash,
    sourceHost:environment.host,
    restoreHost:destination.host,
    serverVersion,
    migrationCount,
    backupCompletedAt:new Date(backupCompletedAt).toISOString(),
    serviceReadyAt:new Date(serviceReadyAt).toISOString(),
    totalDrillMs:Date.now()-drillStartedAt
  }
});
const labelled=labelLocalEvidence(evidence);
await fs.mkdir(dirname(evidenceOut),{recursive:true});
await fs.writeFile(evidenceOut,JSON.stringify(labelled,null,2)+"\n");

console.log(JSON.stringify({passed:labelled.result==="PASS",result:labelled.result,artifactSha256:beforeHash,restoreVerified:true,rtoMs:labelled.rtoMs,rpoMs:labelled.rpoMs,environment:labelled.environment,serverVersion,migrationCount,evidence:evidenceOut}));
// A local/CI run proves the drill works and its evidence is deliberately
// labelled BLOCKED; that is not a drill failure. Only an explicitly requested
// production run that cannot meet the bar fails the process.
if(labelled.result!=="PASS" && requireProduction) process.exitCode=2;
