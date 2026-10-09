import test from "node:test";
import assert from "node:assert/strict";
import {URLSearchParams} from "node:url";
import {createAccessGuard, validatePrivateAccessConfig} from "../server/access-guard.js";

const passphrase = ["test-only","strong","password"].join("-");
const signingKey = "0123456789abcdef".repeat(3);

function responseRecorder() {
  return {
    status: null, headers: {}, body: "",
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = "") { this.body = String(body); }
  };
}
function request({method="GET", pathname="/", cookie="", body="", contentType="application/x-www-form-urlencoded", origin="https://nova.example", ip="127.0.0.1"}={}) {
  return {
    method, headers: {"content-type":contentType, ...(cookie ? {cookie} : {}), ...(origin ? {origin,host:"nova.example"} : {host:"nova.example"})},
    socket:{remoteAddress:ip}
  };
}
const readBody = async () => ({body:new URLSearchParams({password:passphrase}).toString()});

test("hosted access configuration rejects weak or missing credentials", () => {
  assert.throws(() => validatePrivateAccessConfig({password:"short",secret:signingKey}), /NOVA_ACCESS_PASSWORD/);
  assert.throws(() => validatePrivateAccessConfig({password:passphrase,secret:"too-short"}), /NOVA_SESSION_SECRET/);
  assert.throws(() => createAccessGuard({production:true}), /NOVA_ACCESS_PASSWORD/);
});

test("unauthenticated API requests are denied and dashboard requests receive only the login page", async () => {
  const guard = createAccessGuard({password:passphrase,secret:signingKey,production:true});
  const apiRes = responseRecorder();
  assert.equal(await guard.handle(request({pathname:"/api/portfolio"}),apiRes,"/api/portfolio",readBody),true);
  assert.equal(apiRes.status,401);
  assert.match(apiRes.body,/authentication-required/);
  const pageRes = responseRecorder();
  assert.equal(await guard.handle(request({pathname:"/"}),pageRes,"/",readBody),true);
  assert.equal(pageRes.status,200);
  assert.match(pageRes.body,/Private Login/);
  assert.doesNotMatch(pageRes.body,/GEMINI_API_KEY/);
});

test("successful login creates an HttpOnly, SameSite=Strict session cookie", async () => {
  const guard = createAccessGuard({password:passphrase,secret:signingKey,production:true,now:()=>1700000000000});
  const res = responseRecorder();
  const req = request({method:"POST",pathname:"/api/auth/login",body:new URLSearchParams({password:passphrase}).toString()});
  const handled = await guard.handle(req,res,"/api/auth/login",readBody);
  assert.equal(handled,true);
  assert.equal(res.status,303);
  assert.match(res.headers["Set-Cookie"],/HttpOnly/);
  assert.match(res.headers["Set-Cookie"],/SameSite=Strict/);
  assert.match(res.headers["Set-Cookie"],/; Secure/);
  const cookie = res.headers["Set-Cookie"].split(";")[0];
  assert.equal(guard.authenticated({headers:{cookie}}),true);
  const apiRes = responseRecorder();
  assert.equal(await guard.handle(request({pathname:"/api/portfolio",cookie}),apiRes,"/api/portfolio",readBody),false);
});

test("wrong password and cross-origin login are rejected", async () => {
  const guard = createAccessGuard({password:passphrase,secret:signingKey,production:true});
  const wrong = responseRecorder();
  await guard.handle(request({method:"POST",pathname:"/api/auth/login",origin:"https://nova.example"}),wrong,"/api/auth/login",async()=>({body:"password=wrong"}));
  assert.equal(wrong.status,401);
  const cross = responseRecorder();
  await guard.handle(request({method:"POST",pathname:"/api/auth/login",origin:"https://attacker.example"}),cross,"/api/auth/login",readBody);
  assert.equal(cross.status,403);
});


test("expired sessions are rejected and logout clears the session cookie", async () => {
  let clock = 1700000000000;
  const guard = createAccessGuard({password:passphrase,secret:signingKey,production:true,now:()=>clock});
  const login = responseRecorder();
  await guard.handle(request({method:"POST",pathname:"/api/auth/login",ip:"198.51.100.44"}),login,"/api/auth/login",readBody);
  assert.equal(login.status,303);
  const cookie = login.headers["Set-Cookie"].split(";")[0];
  assert.equal(guard.authenticated({headers:{cookie}}),true);

  clock += 12 * 60 * 60 * 1000 + 1;
  assert.equal(guard.authenticated({headers:{cookie}}),false);

  clock = 1700000000000;
  const freshLogin = responseRecorder();
  await guard.handle(request({method:"POST",pathname:"/api/auth/login",ip:"198.51.100.45"}),freshLogin,"/api/auth/login",readBody);
  const freshCookie = freshLogin.headers["Set-Cookie"].split(";")[0];
  const logout = responseRecorder();
  await guard.handle(request({method:"POST",pathname:"/api/auth/logout",cookie:freshCookie,ip:"198.51.100.45"}),logout,"/api/auth/logout",readBody);
  assert.equal(logout.status,303);
  assert.match(logout.headers["Set-Cookie"],/Max-Age=0/);
  assert.match(logout.headers["Set-Cookie"],/HttpOnly/);
});

test("login attempts are throttled after eight wrong passwords", async () => {
  const guard = createAccessGuard({password:passphrase,secret:signingKey,production:true});
  const ip = "198.51.100.46";
  for (let i=0;i<8;i+=1) {
    const response = responseRecorder();
    await guard.handle(request({method:"POST",pathname:"/api/auth/login",ip}),response,"/api/auth/login",async()=>({body:"password=wrong"}));
    assert.equal(response.status,401);
  }
  const blocked = responseRecorder();
  await guard.handle(request({method:"POST",pathname:"/api/auth/login",ip}),blocked,"/api/auth/login",readBody);
  assert.equal(blocked.status,429);
  assert.ok(Number(blocked.headers["Retry-After"]) > 0);
});
