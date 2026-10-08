import {appendFile} from "node:fs/promises";

const action=process.argv[2];

function runSchema(){
  const runId=process.env.GITHUB_RUN_ID;
  const attempt=process.env.GITHUB_RUN_ATTEMPT;
  if(!/^\d+$/.test(runId??"")||!/^\d+$/.test(attempt??"")) throw new Error("GitHub run identifiers are required");
  return `nova_ci_${runId}_${attempt}`;
}

async function main(){
  if(!["prepare","cleanup"].includes(action)) throw new Error("unsupported schema action");
  const connectionString=process.env.POSTGRES_URL;
  if(!connectionString) throw new Error("POSTGRES_URL is required");
  const schema=runSchema();
  const {Pool}=await import("pg");
  const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:10000});

  try{
    if(action==="prepare"){
      const envFile=process.env.GITHUB_ENV;
      if(!envFile) throw new Error("GitHub Actions environment file is required");
      await pool.query(`CREATE SCHEMA "${schema}"`);
      try{
        await appendFile(envFile,`TRADING_NOVA_DB_SCHEMA=${schema}\n`);
      }catch(error){
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(()=>{});
        throw error;
      }
      process.stdout.write("Created isolated Neon CI schema.\n");
      return;
    }

    if(process.env.TRADING_NOVA_DB_SCHEMA!==schema) throw new Error("CI schema does not match this run");
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    process.stdout.write("Removed isolated Neon CI schema.\n");
  }finally{
    await pool.end();
  }
}

main().catch(()=>{
  process.stderr.write("Neon CI schema operation failed; connection details were suppressed.\n");
  process.exitCode=1;
});
