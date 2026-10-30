import {spawn, exec} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {Client} from "pg";
import {createPostgresStore} from "../src/persistence/postgres.js";

const execAsync=promisify(exec);
const connectionString=process.env.POSTGRES_URL;
const crashCommand=process.env.PG_CRASH_CMD;
if(!connectionString) throw new Error("POSTGRES_URL required");

const namespace="crash-drill";
const committedId="committed-sentinel";
const abortedId="aborted-sentinel";
const storePath=fileURLToPath(new URL("../src/persistence/postgres.js",import.meta.url));

async function probe(){
  const client=new Client({connectionString,connectionTimeoutMillis:2000});
  try{
    await client.connect();
    const r=await client.query("SELECT 1 AS ok");
    return r.rows[0]?.ok===1;
  }
  catch{ return false; }
  finally{ try{ await client.end(); } catch{} }
}

async function waitForHealthy({timeoutMs=60000,pollMs=100}={}){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    if(await probe()) return Date.now()-started;
    await new Promise(r=>setTimeout(r,pollMs));
  }
  throw new Error("database did not become healthy within "+timeoutMs+"ms");
}

// Kills a client mid-transaction so the server must roll the open transaction
// back itself; nothing may survive from the aborted write.
async function crashUncommittedWrite(){
  const source=`
import {createPostgresStore} from ${JSON.stringify(storePath)};
const store=await createPostgresStore({connectionString:process.env.POSTGRES_URL,max:1});
const client=await store.pool.connect();
await client.query("BEGIN");
await store.put(${JSON.stringify(namespace)},${JSON.stringify(abortedId)},{value:"uncommitted"},client);
process.stdout.write("UNCOMMITTED\\n");
await new Promise(()=>{});
`;
  const child=spawn(process.execPath,["--input-type=module","-e",source],{env:process.env,stdio:["ignore","pipe","pipe"]});
  let stderr="";
  child.stderr.on("data",chunk=>{ stderr+=chunk.toString(); });
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("crash writer never reported an open transaction: "+stderr)),20000);
    child.stdout.on("data",chunk=>{
      if(chunk.toString().includes("UNCOMMITTED")){ clearTimeout(timer); resolve(); }
    });
    child.on("exit",code=>{ clearTimeout(timer); reject(new Error("crash writer exited early ("+code+"): "+stderr)); });
  });
  child.removeAllListeners("exit");
  const exited=new Promise(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})));
  child.kill("SIGKILL");
  const exit=await exited;
  if(exit.signal!=="SIGKILL") throw new Error("crash writer was not killed as expected");
}

const report={passed:false,database:{}};
const store=await createPostgresStore({connectionString,max:2});
try{
  const version=await store.pool.query("SHOW server_version");
  report.database.version=version.rows[0]?.server_version ?? null;
  if(!await store.health()) throw new Error("database health check failed");
  await store.assertReady();
  if(!await store.verifyAudit()) throw new Error("audit chain failed verification before the drill");

  // Phase 1 — a committed write must survive a client crash.
  await store.put(namespace,committedId,{value:"committed",at:new Date().toISOString()});
  await store.appendAudit({type:"CRASH_RECOVERY_DRILL",id:committedId});
  const committed=await store.get(namespace,committedId);
  if(committed?.value!=="committed") throw new Error("committed sentinel missing before crash");
  report.committedWriteSurvived=true;

  // Phase 2 — an in-flight transaction killed mid-write must leave nothing.
  await crashUncommittedWrite();
  const aborted=await store.get(namespace,abortedId);
  if(aborted!==null) throw new Error("aborted transaction left partial state: "+JSON.stringify(aborted));
  if(!await store.verifyAudit()) throw new Error("audit chain failed verification after client crash");
  report.abortedWriteRolledBack=true;

  // Phase 3 — optional hard server crash/restart (PG_CRASH_CMD), then verify
  // durability, migration state and audit integrity from a fresh connection.
  if(crashCommand){
    const incidentStart=Date.now();
    await execAsync(crashCommand,{env:process.env,timeout:120000});
    const recoveryMs=await waitForHealthy();
    report.serverCrash={
      command:crashCommand,
      measuredRecoveryMs:recoveryMs,
      totalDowntimeMs:Date.now()-incidentStart
    };
    const recovered=await createPostgresStore({connectionString,max:2});
    try{
      if(!await recovered.health()) throw new Error("health check failed after server crash");
      await recovered.assertReady();
      const after=await recovered.get(namespace,committedId);
      if(after?.value!=="committed") throw new Error("committed sentinel lost across server crash");
      if(!await recovered.verifyAudit()) throw new Error("audit chain failed verification after server crash");
      const migrations=await recovered.pool.query("SELECT count(*)::int AS count FROM trading_schema_migrations");
      if(migrations.rows[0].count<1) throw new Error("migration state lost across server crash");
      report.committedWriteSurvivedServerCrash=true;
    }
    finally{ await recovered.pool.end(); }
  } else {
    report.serverCrash={skipped:"PG_CRASH_CMD not set"};
  }

  report.passed=true;
} finally {
  await store.pool.end();
}
console.log(JSON.stringify(report));
