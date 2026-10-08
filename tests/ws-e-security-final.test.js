import test from "node:test";
import assert from "node:assert/strict";
import {createNovaServer} from "../server/app.js";
import {startTestServer} from "./ws-d-helpers.js";

test("server refuses every non-paper trading mode", () => {
  for (const mode of ["shadow","limited-live","live"]) {
    assert.throws(() => createNovaServer({tradingMode: mode}), /paper-only/);
  }
});

test("paper order endpoint is rate limited before body parsing", async () => {
  let now=1000;
  const srv=await startTestServer({now:()=>now});
  try {
    const body=JSON.stringify({symbol:"BTCUSDT",side:"BUY",quantity:1,price:42000,idempotencyKey:"rate-limit-test"});
    let last;
    for(let i=0;i<30;i++){
      last=await fetch(srv.base+"/api/paper/orders",{method:"POST",headers:{"content-type":"application/json"},body});
      assert.notEqual(last.status,429);
    }
    last=await fetch(srv.base+"/api/paper/orders",{method:"POST",headers:{"content-type":"application/json"},body});
    assert.equal(last.status,429);
    assert.equal((await last.json()).error.code,"rate-limited");
    assert.equal(last.headers.get("retry-after"),"2");
    now+=2000;
    const recovered=await fetch(srv.base+"/api/paper/orders",{method:"POST",headers:{"content-type":"application/json"},body});
    assert.notEqual(recovered.status,429);
  } finally { await srv.close(); }
});

test("rate limiter does not affect read-only health traffic", async () => {
  const srv=await startTestServer();
  try {
    for(let i=0;i<40;i++){const res=await fetch(srv.base+"/api/health");assert.equal(res.status,200);}
  } finally { await srv.close(); }
});
