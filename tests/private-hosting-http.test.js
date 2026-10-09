import test from "node:test";
import assert from "node:assert/strict";
import {createNovaServer} from "../server/app.js";

test("private hosting HTTP gate protects assets and API, then permits login and logout", async (t) => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    NOVA_ACCESS_PASSWORD: process.env.NOVA_ACCESS_PASSWORD,
    NOVA_SESSION_SECRET: process.env.NOVA_SESSION_SECRET
  };
  process.env.NODE_ENV = "production";
  process.env.NOVA_ACCESS_PASSWORD = "test-only-private-host-password";
  process.env.NOVA_SESSION_SECRET = "test-only-session-secret-material-0123456789";
  const server = createNovaServer({tradingMode:"paper"});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const origin = base;
  const unauthApi = await fetch(base + "/api/portfolio");
  assert.equal(unauthApi.status, 401);
  assert.equal((await unauthApi.json()).error.code, "authentication-required");

  const unauthAsset = await fetch(base + "/app.js");
  assert.equal(unauthAsset.status, 200);
  assert.match(await unauthAsset.text(), /Private Login/);

  const login = await fetch(base + "/api/auth/login", {
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded",origin},
    body:new URLSearchParams({password:"test-only-private-host-password"}),
    redirect:"manual"
  });
  assert.equal(login.status, 303);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0];

  const asset = await fetch(base + "/app.js", {headers:{cookie}});
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);
  assert.doesNotMatch(await asset.text(), /Private Login/);

  const status = await fetch(base + "/api/auth/status", {headers:{cookie}});
  assert.equal(status.status, 200);
  assert.equal((await status.json()).data.privateAccessEnabled, true);

  const logout = await fetch(base + "/api/auth/logout", {
    method:"POST",headers:{origin,cookie},redirect:"manual"
  });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
});
