import test from "node:test";
import assert from "node:assert/strict";
import {PostgresStore} from "../src/persistence/postgres.js";
function fakePool(){
  const calls=[], results=new Map(), state=new Map();
  async function query(sql,args=[]){
    calls.push([sql,args]);
    if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK") return {rows:[]};
    if(sql.includes("SELECT result FROM trading_idempotency")) return results.has(args[0])?{rowCount:1,rows:[{result:results.get(args[0])}]}:{rowCount:0,rows:[]};
    if(sql.includes("INSERT INTO trading_idempotency")){results.set(args[0],JSON.parse(args[1]));return {rows:[]};}
    if(sql.includes("INSERT INTO trading_state")){state.set(`${args[0]}:${args[1]}`,JSON.parse(args[2]));return {rows:[]};}
    if(sql.includes("SELECT value FROM trading_state WHERE namespace=$1")){
      const prefix=`${args[0]}:`;
      return {rows:[...state.entries()].filter(([key])=>key.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b)).map(([,value])=>({value}))};
    }
    if(sql==="SELECT 1 AS ok") return {rows:[{ok:1}]};
    if(sql==="SELECT version FROM trading_schema_migrations ORDER BY version") return {rows:[{version:"001_initial.sql"},{version:"002_constraints.sql"}]};
    return {rows:[]};
  }
  const client={query,release(){calls.push(["RELEASE",[]]);}};
  return {calls,async connect(){return client;},query,state};
}
test("PostgresStore validates pool and health",async()=>{const pool=fakePool();const store=new PostgresStore(pool);assert.equal(await store.health(),true);assert.throws(()=>new PostgresStore(),/postgres pool required/);});
test("PostgresStore transactions rollback on failure",async()=>{const pool=fakePool();const store=new PostgresStore(pool);await assert.rejects(()=>store.withTransaction(async()=>{throw new Error("boom")}),/boom/);assert.ok(pool.calls.some(([sql])=>sql==="BEGIN"));assert.ok(pool.calls.some(([sql])=>sql==="ROLLBACK"));});
test("PostgresStore idempotency executes operation once",async()=>{const pool=fakePool();const store=new PostgresStore(pool);let calls=0;const a=await store.transactIdempotent("k",async()=>{calls++;return {ok:true}});const b=await store.transactIdempotent("k",async()=>{calls++;return {ok:false}});assert.deepEqual(a,b);assert.equal(calls,1);});
test("PostgresStore lists state and verifies required migrations",async()=>{const store=new PostgresStore(fakePool());await store.put("paper-fills","b",{id:"b"});await store.put("paper-fills","a",{id:"a"});assert.deepEqual(await store.list("paper-fills"),[{id:"a"},{id:"b"}]);assert.equal(await store.assertReady(),true);});
