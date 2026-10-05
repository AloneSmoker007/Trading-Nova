import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createPostgresStore} from "../src/persistence/postgres.js";

const enabled = process.env.TRADING_NOVA_REAL_DB_TEST === "1";
const run = enabled ? test : test.skip;

run("PostgreSQL real integration: health, persistence and migration state", async()=>{
  const store=await createPostgresStore({connectionString:process.env.POSTGRES_URL,max:2});
  assert.equal(await store.health(),true);
  const id=randomUUID();
  await store.put("integration",id,{value:"ok"});
  assert.deepEqual(await store.get("integration",id),{value:"ok"});
  const migrations=await store.pool.query("SELECT version FROM trading_schema_migrations ORDER BY version");
  assert.ok(migrations.rows.some((row)=>row.version==="001_initial.sql"));
  await store.pool.end();
});

run("PostgreSQL real integration: transaction rollback is durable", async()=>{
  const store=await createPostgresStore({connectionString:process.env.POSTGRES_URL,max:2});
  const id=randomUUID();
  await assert.rejects(
    store.withTransaction(async client=>{
      await client.query(
        "INSERT INTO trading_state(namespace,state_id,value) VALUES($1,$2,$3::jsonb)",
        ["rollback-test",id,JSON.stringify({shouldNotPersist:true})]
      );
      throw new Error("forced rollback");
    }),
    /forced rollback/
  );
  const result=await store.get("rollback-test",id);
  assert.equal(result,null);
  await store.pool.end();
});

run("PostgreSQL real integration: idempotency executes once", async()=>{
  const store=await createPostgresStore({connectionString:process.env.POSTGRES_URL,max:2});
  const key=`integration-${randomUUID()}`;
  let calls=0;
  const first=await store.transactIdempotent(key,async()=>({value:++calls}));
  const second=await store.transactIdempotent(key,async()=>({value:++calls}));
  assert.deepEqual(first,{value:1});
  assert.deepEqual(second,{value:1});
  assert.equal(calls,1);
  await store.pool.end();
});

run("PostgreSQL real integration: audit hash chain verifies and detects tamper", async()=>{
  const store=await createPostgresStore({connectionString:process.env.POSTGRES_URL,max:2});
  const first=await store.appendAudit({type:"INTEGRATION",id:randomUUID()});
  await store.appendAudit({type:"INTEGRATION",id:randomUUID()});
  assert.equal(await store.verifyAudit(),true);
  await store.pool.query("UPDATE trading_audit SET hash=$1 WHERE sequence=$2",[first.hash==="tampered"?"x":"tampered",first.sequence]);
  assert.equal(await store.verifyAudit(),false);
  await store.pool.end();
});
