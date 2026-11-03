import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createPostgresStore} from "../src/persistence/postgres.js";
import {createApi} from "../server/api.js";
import {createPaperOrderService} from "../server/orders.js";
import {createWatchlistService} from "../server/watchlist.js";
import {buildPortfolioState} from "../src/risk/portfolio.js";
import {startTestServer} from "./ws-d-helpers.js";

const enabled = process.env.TRADING_NOVA_REAL_DB_TEST === "1";
const run = enabled ? test : test.skip;
// Tests that require exclusive schema state (they count rows in a namespace or
// rebuild shared portfolio state) run only against a fresh or isolated
// database. The shared-Neon CI job sets TRADING_NOVA_SKIP_AUDIT_TEST=1 and
// skips them the same way as the destructive audit-tamper test below.
const auditRun = enabled && process.env.TRADING_NOVA_SKIP_AUDIT_TEST !== "1" ? test : test.skip;

function journalScopedStore(store, journalId) {
  return {
    health: store.health.bind(store),
    withTransaction: store.withTransaction.bind(store),
    get: (namespace, id, client) => store.get(namespace, namespace === "paper-journal" ? journalId : id, client),
    put: (namespace, id, value, client) => store.put(namespace, namespace === "paper-journal" ? journalId : id, value, client),
    list: store.list.bind(store),
    transactIdempotent: store.transactIdempotent.bind(store)
  };
}

async function withStore(work){
  const store=await createPostgresStore({
    connectionString:process.env.POSTGRES_URL,
    max:2,
    schema:process.env.TRADING_NOVA_DB_SCHEMA
  });
  try{ await work(store); }
  finally{ await store.pool.end(); }
}


auditRun("PostgreSQL distinct paper orders re-read and gate the latest portfolio under one cross-process lock", async () => {
  const prefix = "portfolio-risk-race-" + randomUUID() + ":";
  const first = await createPostgresStore({
    connectionString: process.env.POSTGRES_URL, max: 2, schema: process.env.TRADING_NOVA_DB_SCHEMA
  });
  const second = await createPostgresStore({
    connectionString: process.env.POSTGRES_URL, max: 2, schema: process.env.TRADING_NOVA_DB_SCHEMA
  });
  const scoped = store => ({
    health: store.health.bind(store),
    get: (namespace, id) => store.get(prefix + namespace, id),
    put: (namespace, id, value) => store.put(prefix + namespace, id, value),
    list: namespace => store.list(prefix + namespace),
    transactIdempotent: (key, operation) => store.transactIdempotent(prefix + key, tx => operation({
      get: (namespace, id) => tx.get(prefix + namespace, id),
      put: (namespace, id, value) => tx.put(prefix + namespace, id, value),
      lock: key => tx.lock(prefix + key),
      lockPortfolio: () => tx.lockPortfolio(),
      nextPaperSequence: () => tx.nextPaperSequence()
    }))
  });
  const firstStore = scoped(first);
  const secondStore = scoped(second);
  const initialPortfolio = buildPortfolioState({
    cash: 10000,
    startingEquity: 20000,
    positions: [
      {symbol: "BTCUSDT", quantity: 0.1, markPrice: 50000},
      {symbol: "ETHUSDT", quantity: 0.1, markPrice: 50000}
    ]
  });
  const stateFile = join(tmpdir(), prefix + "state.json");
  const executionStateFile = join(tmpdir(), prefix + "orders.json");
  const quote = {state: "ok", ageMs: 0, data: {last: 50000, bid: 49999, ask: 50001}};
  let arrivals = 0;
  let releaseBarrier;
  const barrier = new Promise(resolve => { releaseBarrier = resolve; });
  const market = {
    getTicker: async symbol => {
      if (symbol === "SOLUSDT" && arrivals < 2) {
        arrivals++;
        if (arrivals === 2) releaseBarrier();
        await barrier;
      }
      return quote;
    }
  };
  try {
    await firstStore.put("paper-portfolio", "current", initialPortfolio);
    await firstStore.put("paper-portfolio-revision", "global", {revision: 0});
    const serviceA = createPaperOrderService({market, stateFile, executionStateFile, store: firstStore});
    const serviceB = createPaperOrderService({market, stateFile, executionStateFile, store: secondStore});
    const [resultA, resultB] = await Promise.all([
      serviceA.submit({symbol: "SOLUSDT", side: "BUY", quantity: 0.06, price: 1, idempotencyKey: "market-risk-a"}),
      serviceB.submit({symbol: "SOLUSDT", side: "BUY", quantity: 0.06, price: 1, idempotencyKey: "market-risk-b"})
    ]);
    const results = [resultA, resultB];
    assert.equal(results.filter(result => result.status === 200).length, 1);
    assert.equal(results.filter(result => result.status === 400 && result.body.error.code === "risk-gate-rejected").length, 1);
    const fills = await firstStore.list("paper-fills");
    assert.equal(fills.length, 1, "the second concurrent order must not commit against the stale portfolio");
    const portfolio = await firstStore.get("paper-portfolio", "current");
    assert.ok(portfolio.grossExposure <= 15000);
    assert.equal(portfolio.positions.filter(position => position.symbol === "SOLUSDT").length, 1);
    assert.equal((await firstStore.get("paper-portfolio-revision", "global")).revision, 1);
    const rejectedKey = resultA.status === 400 ? "market-risk-a" : "market-risk-b";
    assert.equal(await firstStore.get("paper-fills", rejectedKey), null);
  } finally {
    releaseBarrier?.();
    await first.withTransaction(client => client.query(
      `DELETE FROM ${first.table("trading_state")} WHERE left(namespace,length($1))=$1`, [prefix]
    ));
    await first.withTransaction(client => client.query(
      `DELETE FROM ${first.table("trading_idempotency")} WHERE left(idempotency_key,length($1))=$1`, [prefix]
    ));
    await first.pool.end();
    await second.pool.end();
  }
});

auditRun("PostgreSQL cancel and trigger fill are linearized across independent store connections", async () => {
  const prefix = "order-transition-race-" + randomUUID() + ":";
  const first = await createPostgresStore({
    connectionString: process.env.POSTGRES_URL, max: 2, schema: process.env.TRADING_NOVA_DB_SCHEMA
  });
  const second = await createPostgresStore({
    connectionString: process.env.POSTGRES_URL, max: 2, schema: process.env.TRADING_NOVA_DB_SCHEMA
  });
  const scoped = store => ({
    health: store.health.bind(store),
    get: (namespace, id) => store.get(prefix + namespace, id),
    put: (namespace, id, value) => store.put(prefix + namespace, id, value),
    list: namespace => store.list(prefix + namespace),
    transactIdempotent: (key, operation) => store.transactIdempotent(prefix + key, tx => operation({
      get: (namespace, id) => tx.get(prefix + namespace, id),
      put: (namespace, id, value) => tx.put(prefix + namespace, id, value),
      lock: key => tx.lock(prefix + key),
      lockPortfolio: () => tx.lockPortfolio(),
      nextPaperSequence: () => tx.nextPaperSequence()
    }))
  });
  const stateFile = join(tmpdir(), prefix + "state.json");
  const executionStateFile = join(tmpdir(), prefix + "orders.json");
  const initialQuote = {state: "ok", ageMs: 0, data: {last: 42000.5, bid: 42000, ask: 42001}};
  let markQuoteStarted;
  const quoteStarted = new Promise(resolve => { markQuoteStarted = resolve; });
  let releaseQuote;
  let quoteReleased = false;
  let processing;
  const delayedQuote = new Promise(resolve => { releaseQuote = resolve; });
  const release = value => {
    if (!quoteReleased && releaseQuote) {
      quoteReleased = true;
      releaseQuote(value);
    }
  };
  const firstService = createPaperOrderService({
    market: {getTicker: async () => initialQuote},
    stateFile, executionStateFile, store: scoped(first)
  });
  const key = "pending-cancel-race";
  try {
    const accepted = await firstService.submit({
      symbol: "BTCUSDT", side: "BUY", quantity: 0.01, price: 41000,
      idempotencyKey: key, type: "LIMIT"
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.order.status, "PENDING");

    const secondService = createPaperOrderService({
      market: {getTicker: async () => { markQuoteStarted(); return delayedQuote; }},
      stateFile, executionStateFile, store: scoped(second)
    });
    processing = secondService.processPendingOrders();
    await quoteStarted;

    const canceled = await firstService.cancelOrder(accepted.body.data.order.orderId);
    assert.equal(canceled.status, 200);
    assert.equal(canceled.body.data.order.status, "CANCELED");

    release({state: "ok", ageMs: 0, data: {last: 40000, bid: 39999, ask: 40000}});
    const processed = await processing;
    assert.equal(processed.state, "ok");
    assert.equal(processed.processed, 0);
    assert.equal((await scoped(second).get("paper-orders", key)).status, "CANCELED");
    assert.equal(await scoped(second).get("paper-fills", key), null);
  } finally {
    release(initialQuote);
    await processing?.catch(() => {});
    await first.withTransaction(client => client.query(
      `DELETE FROM ${first.table("trading_state")} WHERE left(namespace,length($1))=$1`, [prefix]
    ));
    await first.withTransaction(client => client.query(
      `DELETE FROM ${first.table("trading_idempotency")} WHERE left(idempotency_key,length($1))=$1`, [prefix]
    ));
    await first.pool.end();
    await second.pool.end();
  }
});

auditRun("PostgreSQL paper sequence serializes concurrent clients and rolls back with failed fills", async()=>withStore(async store=>{
  const batch=randomUUID();
  const before=await store.get("paper-sequence","global");
  await assert.rejects(store.transactIdempotent(`sequence-rollback-${batch}`,async tx=>{
    await tx.nextPaperSequence();
    await tx.put("sequence-proof",batch,{partial:true});
    throw new Error("injected sequence rollback");
  }),/injected sequence rollback/);
  assert.deepEqual(await store.get("paper-sequence","global"),before);
  assert.equal(await store.get("sequence-proof",batch),null);
  const values=await Promise.all(Array.from({length:8},(_,i)=>store.transactIdempotent(`sequence-${batch}-${i}`,async tx=>{
    const sequence=await tx.nextPaperSequence();
    await tx.put("sequence-proof",`${batch}-${i}`,{sequence});
    return sequence;
  })));
  assert.equal(new Set(values).size,8);
  assert.ok(values.every(n=>Number.isSafeInteger(n)&&n>0));
  const sorted=[...values].sort((a,b)=>a-b);
  assert.equal(sorted.at(-1)-sorted[0],7);
  const replay=await store.transactIdempotent(`sequence-${batch}-0`,()=>{throw new Error("replay must not allocate");});
  assert.equal(replay,values[0]);
}));

auditRun("PostgreSQL learning snapshot rejects same-count replacement from another connection", async()=>withStore(async first=>{
  const second=await createPostgresStore({
    connectionString:process.env.POSTGRES_URL,
    max:2,
    schema:process.env.TRADING_NOVA_DB_SCHEMA
  });
  const id="learning-snapshot-"+randomUUID();
  let server;
  try{
    const fill={orderId:id,idempotencyKey:id,status:"RECONCILED",symbol:"BTCUSDT",side:"BUY",
      quantity:1,price:100,fee:0.1,timestamp:Date.now()};
    await first.put("paper-fills",id,fill);
    const before=await first.get("paper-fill-revision","global");
    assert.ok(Number.isSafeInteger(before?.revision));
    let replaced=false;
    let observedTotal=null;
    const store=new Proxy(first,{
      get(target,property){
        if(property==="listPage") return async(namespace,options)=>{
          const page=await target.listPage(namespace,options);
          if(namespace==="paper-fills"&&!replaced){
            replaced=true;
            observedTotal=page.total;
            await second.put("paper-fills",id,{...fill,price:101});
          }
          return page;
        };
        const value=Reflect.get(target,property,target);
        return typeof value==="function"?value.bind(target):value;
      }
    });
    server=await startTestServer({store});
    const response=await fetch(server.base+"/api/learning/outcomes");
    assert.equal(response.status,503);
    assert.equal((await response.json()).error.code,"paper-learning-unavailable");
    assert.equal(replaced,true);
    const after=await second.get("paper-fill-revision","global");
    assert.ok(after.revision>before.revision);
    const afterPage=await first.listPage("paper-fills",{limit:200,offset:0});
    assert.equal(afterPage.total,observedTotal,"replacement must preserve the row count");
    assert.ok(afterPage.items.some(item=>item.idempotencyKey===id));
    assert.equal((await first.get("paper-fills",id)).price,101);
    const beforeRollback=await first.get("paper-fill-revision","global");
    await assert.rejects(first.transactIdempotent("learning-snapshot-rollback-"+id,async tx=>{
      await tx.put("paper-fills",id,{...fill,price:102});
      throw new Error("injected snapshot rollback");
    }),/injected snapshot rollback/);
    assert.deepEqual(await second.get("paper-fill-revision","global"),beforeRollback);
    assert.equal((await second.get("paper-fills",id)).price,101);
  }finally{
    if(server) await server.close();
    await first.withTransaction(client=>client.query(
      `DELETE FROM ${first.table("trading_state")} WHERE namespace=$1 AND state_id=$2`,
      ["paper-fills",id]
    ));
    await second.pool.end();
  }
}));

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

run("PostgreSQL real integration: watchlist survives reconnection and concurrent edits use revision fencing", async () => {
  const id = "watchlist-test-" + randomUUID();
  const first = await createPostgresStore({connectionString: process.env.POSTGRES_URL, max: 2, schema: process.env.TRADING_NOVA_DB_SCHEMA});
  let second;
  const scoped = store => ({
    get: (namespace, _id, client) => store.get(namespace, id, client),
    put: (namespace, _id, value, client) => store.put(namespace, id, value, client),
    withTransaction: store.withTransaction.bind(store)
  });
  try {
    const a = createWatchlistService({store: scoped(first)});
    await a.save({symbols: ["ETHUSDT", "BTCUSDT"], revision: 0});
    second = await createPostgresStore({connectionString: process.env.POSTGRES_URL, max: 2, schema: process.env.TRADING_NOVA_DB_SCHEMA});
    const b = createWatchlistService({store: scoped(second)});
    assert.deepEqual((await b.read()).symbols, ["ETHUSDT", "BTCUSDT"]);
    const outcomes = await Promise.allSettled([
      a.save({symbols: ["SOLUSDT"], revision: 1}), b.save({symbols: [], revision: 1})
    ]);
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.find(result => result.status === "rejected").reason.code, "watchlist-conflict");
    const winner = outcomes.find(result => result.status === "fulfilled").value;
    assert.deepEqual((await b.read()).symbols, winner.symbols);
    assert.equal((await b.read()).revision, 2);
  } finally {
    try { await first.pool.query(`DELETE FROM ${first.table("trading_state")} WHERE namespace=$1 AND state_id=$2`, ["paper-watchlist", id]); }
    finally { await first.pool.end(); if (second) await second.pool.end(); }
  }
});

run("PostgreSQL real integration: journal survives a fresh store connection", async () => {
  const firstStore = await createPostgresStore({
    connectionString: process.env.POSTGRES_URL,
    max: 2,
    schema: process.env.TRADING_NOVA_DB_SCHEMA
  });
  const marker = `journal-restart-${randomUUID()}`;
  const journalId = `journal-test-${randomUUID()}`;
  try {
    const api = createApi({
      market: {},
      stateFile: join(tmpdir(), `trading-nova-journal-${randomUUID()}.json`),
      executionStateFile: join(tmpdir(), `trading-nova-orders-${randomUUID()}.json`),
      store: journalScopedStore(firstStore, journalId)
    });
    const written = await api.addJournalEntry(JSON.stringify({text: marker, symbol: "BTCUSDT"}));
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.equal(written.body.data.record.entry.text, marker);
  } finally {
    await firstStore.pool.end();
  }

  const secondStore = await createPostgresStore({
    connectionString: process.env.POSTGRES_URL,
    max: 2,
    schema: process.env.TRADING_NOVA_DB_SCHEMA
  });
  try {
    const recoveredApi = createApi({
      market: {},
      stateFile: join(tmpdir(), `trading-nova-journal-recover-${randomUUID()}.json`),
      executionStateFile: join(tmpdir(), `trading-nova-orders-recover-${randomUUID()}.json`),
      store: journalScopedStore(secondStore, journalId)
    });
    const recovered = await recoveredApi.journal();
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.data.verified, true);
    assert.ok(recovered.body.data.entries.some((entry) => entry.entry.text === marker));
  } finally {
    await secondStore.pool.end();
  }
});

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
  const market={getTicker:async()=>({state:"ok",ageMs:0,data:{last:42000.5,bid:42000,ask:42001}})};
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
    assert.ok(Number.isSafeInteger(first.body.data.fill.executionSequence));
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
    assert.equal(replay.body.data.fill.executionSequence,first.body.data.fill.executionSequence);
    assert.equal((await recoveryStore.list("paper-fills")).length,1);

    const portfolio=await recovered.getPortfolio();
    assert.equal(portfolio.state,"ok");
    assert.equal(portfolio.portfolio.positions[0].quantity,0.01);
  }finally{
    await recoveryStore?.pool.end().catch(()=>{});
    await firstStore.pool.end().catch(()=>{});
  }
});
