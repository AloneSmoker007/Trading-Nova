import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createPostgresStore} from "../src/persistence/postgres.js";
import {createPaperOrderService} from "../server/orders.js";

const enabled = process.env.TRADING_NOVA_REAL_DB_TEST === "1";
const run = enabled ? test : test.skip;
// Tests that require exclusive schema state (they count rows in a namespace or
// rebuild shared portfolio state) run only against a fresh or isolated
// database. The shared-Neon CI job sets TRADING_NOVA_SKIP_AUDIT_TEST=1 and
// skips them the same way as the destructive audit-tamper test below.
const auditRun = enabled && process.env.TRADING_NOVA_SKIP_AUDIT_TEST !== "1" ? test : test.skip;

async function withStore(work){
  const store=await createPostgresStore({
    connectionString:process.env.POSTGRES_URL,
    max:2,
    schema:process.env.TRADING_NOVA_DB_SCHEMA
  });
  try{ await work(store); }
  finally{ await store.pool.end(); }
}

run("PostgreSQL real integration: health, persistence and migration state", async()=>withStore(async store=>{
  assert.equal(await store.health(),true);
  assert.equal(await store.assertReady(),true);
  const id=randomUUID();
  await store.put("integration",id,{value:"ok"});
  assert.deepEqual(await store.get("integration",id),{value:"ok"});
  // Raw statements must run inside a store transaction so the schema-scoped
  // search_path applies: an unqualified statement outside a transaction on a
  // pooled endpoint resolves in the default schema, not the run's schema.
  const migrations=await store.withTransaction(client=>client.query("SELECT version FROM trading_schema_migrations ORDER BY version"));
  assert.ok(migrations.rows.some((row)=>row.version==="001_initial.sql"));
  assert.ok(migrations.rows.some((row)=>row.version==="002_constraints.sql"));
}));

run("PostgreSQL real integration: transaction rollback is durable", async()=>withStore(async store=>{
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
}));

run("PostgreSQL real integration: idempotency executes once", async()=>withStore(async store=>{
  const key=`integration-${randomUUID()}`;
  let calls=0;
  const first=await store.transactIdempotent(key,async()=>({value:++calls}));
  const second=await store.transactIdempotent(key,async()=>({value:++calls}));
  assert.deepEqual(first,{value:1});
  assert.deepEqual(second,{value:1});
  assert.equal(calls,1);
}));

auditRun("PostgreSQL real integration: audit hash chain verifies and detects tamper", async()=>withStore(async store=>{
  const [first]=await Promise.all([
    store.appendAudit({type:"INTEGRATION",id:randomUUID()}),
    store.appendAudit({type:"INTEGRATION",id:randomUUID()}),
    store.appendAudit({type:"INTEGRATION",id:randomUUID()})
  ]);
  assert.equal(await store.verifyAudit(),true);
  await store.withTransaction(client=>client.query("UPDATE trading_audit SET hash=$1 WHERE sequence=$2",[first.hash==="tampered"?"x":"tampered",first.sequence]));
  assert.equal(await store.verifyAudit(),false);
}));

auditRun("PostgreSQL real integration: paper orders survive restart and replay idempotently", async()=>{
  const stateFile=join(tmpdir(),`trading-nova-neon-state-${randomUUID()}.json`);
  const executionStateFile=join(tmpdir(),`trading-nova-neon-orders-${randomUUID()}.json`);
  const market={getTicker:async()=>({state:"ok",ageMs:0,data:{last:42000.5}})};
  const order={symbol:"BTCUSDT",side:"BUY",quantity:0.01,price:42000.5,idempotencyKey:`neon-${randomUUID()}`};
  const firstStore=await createPostgresStore({
    connectionString:process.env.POSTGRES_URL,
    max:2,
    schema:process.env.TRADING_NOVA_DB_SCHEMA
  });
  let recoveryStore;
  try{
    const service=createPaperOrderService({market,stateFile,executionStateFile,store:firstStore});
    const first=await service.submit(order);
    assert.equal(first.status,200);
    assert.equal(first.body.data.fill.status,"RECONCILED");
    await firstStore.pool.end();

    recoveryStore=await createPostgresStore({
      connectionString:process.env.POSTGRES_URL,
      max:2,
      schema:process.env.TRADING_NOVA_DB_SCHEMA
    });
    const recovered=createPaperOrderService({market,stateFile,executionStateFile,store:recoveryStore});
    const replay=await recovered.submit(order);
    assert.equal(replay.status,200);
    assert.equal(replay.body.data.state,"replayed");
    assert.equal(replay.body.data.fill.orderId,first.body.data.fill.orderId);
    assert.equal((await recoveryStore.list("paper-fills")).length,1);

    const portfolio=await recovered.getPortfolio();
    assert.equal(portfolio.state,"ok");
    assert.equal(portfolio.portfolio.positions[0].quantity,0.01);
  }finally{
    await recoveryStore?.pool.end().catch(()=>{});
    await firstStore.pool.end().catch(()=>{});
  }
});
