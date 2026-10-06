import test from "node:test";
import assert from "node:assert/strict";
import {checkEnv} from "../scripts/lib/require-env.js";

test("missing variable fails with an actionable message naming the variable",()=>{
  const r=checkEnv("MISSING_VAR",{});
  assert.equal(r.ok,false);
  assert.match(r.message,/MISSING_VAR/);
  assert.match(r.message,/missing configuration/);
  assert.match(r.message,/must not be treated as evidence/);
});

test("present variable succeeds and returns the raw value",()=>{
  const r=checkEnv("PRESENT_VAR",{PRESENT_VAR:"hello-world"});
  assert.deepEqual(r,{ok:true,value:"hello-world"});
});

test("value is trimmed for the emptiness check but returned untrimmed",()=>{
  const r=checkEnv("PADDED_VAR",{PADDED_VAR:"  spaced  "});
  assert.deepEqual(r,{ok:true,value:"  spaced  "});
});

test("empty string counts as missing by default",()=>{
  assert.equal(checkEnv("EMPTY_VAR",{EMPTY_VAR:""}).ok,false);
});

test("whitespace-only value counts as missing by default",()=>{
  assert.equal(checkEnv("WS_VAR",{WS_VAR:"   "}).ok,false);
});

test("allowEmpty explicitly permits an empty value",()=>{
  const r=checkEnv("OPTIONAL_VAR",{OPTIONAL_VAR:""},{allowEmpty:true});
  assert.deepEqual(r,{ok:true,value:""});
});

test("undefined env object is fail-closed, not a throw",()=>{
  const r=checkEnv("ANY_VAR",undefined);
  assert.equal(r.ok,false);
});

test("non-string variable value is fail-closed, not coerced",()=>{
  for(const bad of [123,null,true,{},[]]){
    const r=checkEnv("BAD_VAR",{BAD_VAR:bad});
    assert.equal(r.ok,false,`non-string ${String(bad)} must fail closed`);
  }
});

test("invalid variable name is rejected without throwing",()=>{
  assert.equal(checkEnv("",{}).ok,false);
  assert.equal(checkEnv("   ",{}).ok,false);
  assert.equal(checkEnv(null,{}).ok,false);
  assert.equal(checkEnv(undefined,{}).ok,false);
});

test("message includes hint and example when supplied",()=>{
  const r=checkEnv("HINTED_VAR",{},{hint:"why it is needed",example:"HINTED_VAR=x npm run y"});
  assert.equal(r.ok,false);
  assert.match(r.message,/why it is needed/);
  assert.match(r.message,/HINTED_VAR=x npm run y/);
});

test("message omits hint and example cleanly when not supplied",()=>{
  const r=checkEnv("PLAIN_VAR",{});
  assert.equal(r.ok,false);
  assert.doesNotMatch(r.message,/undefined/);
  assert.doesNotMatch(r.message,/example:/);
});

test("SECURITY: the message never echoes a value from the environment",()=>{
  // Even when other sensitive-looking variables exist, they must never be printed.
  const env={MISSING_VAR:"",API_KEY:"SENSITIVE_MARKER_VALUE",DB_PASSWORD:"PW_MARKER_VALUE"};
  const r=checkEnv("MISSING_VAR",env);
  assert.equal(r.ok,false);
  assert.doesNotMatch(r.message,/SENSITIVE_MARKER/);
  assert.doesNotMatch(r.message,/PW_MARKER/);
});

test("SECURITY: the success path leaks nothing into a message field",()=>{
  const r=checkEnv("API_KEY",{API_KEY:"SENSITIVE_MARKER_VALUE"});
  assert.equal(r.ok,true);
  assert.deepEqual(Object.keys(r),["ok","value"]);
});
