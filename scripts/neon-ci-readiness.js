import {spawn} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";

async function main(){
  if(!process.env.POSTGRES_URL||!process.env.TRADING_NOVA_DB_SCHEMA) throw new Error("Neon CI environment is required");
  const child=spawn(process.execPath,["server/index.js"],{
    env:{...process.env,NOVA_PORT:"0"},
    stdio:["ignore","pipe","pipe"]
  });
  let output="";
  child.stdout.on("data",chunk=>{ output+=chunk.toString(); });
  child.stderr.on("data",chunk=>{ output+=chunk.toString(); });

  try{
    const startDeadline=Date.now()+15000;
    let port;
    while(Date.now()<startDeadline){
      const match=/Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if(match){ port=Number(match[1]); break; }
      if(child.exitCode!==null) throw new Error("server exited before listening");
      await delay(100);
    }
    if(!port) throw new Error("server did not become ready");

    const response=await fetch(`http://127.0.0.1:${port}/api/health`);
    const body=await response.json();
    if(!response.ok||body?.ok!==true||body?.data?.paperOnly!==true) throw new Error("health check failed");
    process.stdout.write("Neon-backed server startup and health check passed.\n");
  }finally{
    if(child.exitCode===null){
      child.kill("SIGTERM");
      await Promise.race([
        new Promise(resolve=>child.once("exit",resolve)),
        delay(3000)
      ]);
      if(child.exitCode===null) child.kill("SIGKILL");
    }
  }
}

main().catch(()=>{
  process.stderr.write("Neon-backed server startup/readiness check failed; server output was suppressed.\n");
  process.exitCode=1;
});
