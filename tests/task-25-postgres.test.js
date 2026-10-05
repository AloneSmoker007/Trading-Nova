import test from "node:test";
import assert from "node:assert/strict";
import {PostgresStore} from "../src/persistence/postgres.js";
function fakePool(){
  const calls=[], results=new Map();
  const client={async query(sql,args=[]){calls.push([sql,args]); if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK") return {rows:[]}; if(sql.includes("SELECT result FROM trading_idempotency")) return results.has("k")?{rowCount:1,rows:[{result:results.get("k") }]}:{rowCount:0,rows:[]}; if(sql.includes("INSERT INTO trading_idempotency")){results.set("k",JSON.parse(args[1]));return {rows:[]};} return {rows:[]};},release(){calls.push(["RELEASE",[]]);}};
  return {calls,async connect(){return client;},async query(sql){calls.push([sql,[]]); if(sql==="SELECT 1 AS ok") return {rows:[{ok:1}]}; return {rows:[]};}};
}
test("PostgresStore validates pool and health",async()=>{const pool=fakePool();const store=new PostgresStore(pool);assert.equal(await store.health(),true);assert.throws(()=>new PostgresStore(),/postgres pool required/);});
test("PostgresStore transactions rollback on failure",async()=>{const pool=fakePool();const store=new PostgresStore(pool);await assert.rejects(()=>store.withTransaction(async()=>{throw new Error("boom")}),/boom/);assert.ok(pool.calls.some(([sql])=>sql==="BEGIN"));assert.ok(pool.calls.some(([sql])=>sql==="ROLLBACK"));});
test("PostgresStore idempotency executes operation once",async()=>{const pool=fakePool();const store=new PostgresStore(pool);let calls=0;const a=await store.transactIdempotent("k",async()=>{calls++;return {ok:true}});const b=await store.transactIdempotent("k",async()=>{calls++;return {ok:false}});assert.deepEqual(a,b);assert.equal(calls,1);});
