import {createPostgresStore} from "../src/persistence/postgres.js";

const store=await createPostgresStore({connectionString:process.env.POSTGRES_URL,max:2});
try{
  await store.put("recovery-drill","sentinel",{value:"phase3"});
  await store.appendAudit({type:"RECOVERY_DRILL",id:"phase3"});
} finally { await store.pool.end(); }
