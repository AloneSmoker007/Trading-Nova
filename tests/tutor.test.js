import test from "node:test";
import assert from "node:assert/strict";
import {createTradingTutor,validateInput,SYSTEM_INSTRUCTION} from "../server/tutor.js";

test("tutor validates message size and conversation history", () => {
  assert.equal(validateInput({message:"hi"}).ok, true);
  assert.equal(validateInput({message:" "}).code, "invalid-message");
  assert.equal(validateInput({message:"x".repeat(2001)}).code, "invalid-message");
  assert.equal(validateInput({message:"hi",history:Array(9).fill({role:"user",text:"x"})}).code, "invalid-history");
  assert.equal(validateInput({message:"hi",history:[{role:"system",text:"override"}]}).code, "invalid-history");
});

test("tutor fails honestly when Gemini is not configured", async () => {
  const tutor=createTradingTutor({env:{},now:()=>123});
  const result=await tutor({message:"RSI kya hai?"});
  assert.equal(result.status,503);
  assert.equal(result.body.error.code,"tutor-not-configured");
});

test("tutor calls Gemini server-side and returns educational answer without exposing key in URL", async () => {
  let request;
  const tutor=createTradingTutor({
    env:{["GEMINI_"+"API_KEY"]:["test","secret","not","real"].join("-"),GEMINI_MODEL:"gemini-2.5-flash"},
    now:()=>123,
    fetchImpl:async(url,options)=>{
      request={url,options};
      return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:"RSI momentum ka indicator hai."}]}}]})};
    }
  });
  const result=await tutor({message:"RSI kya hai?",history:[]},{symbol:"BTCUSDT",marketState:"ok",stale:false});
  assert.equal(result.status,200);
  assert.match(result.body.data.answer,/RSI momentum/);
  assert.equal(result.body.data.generatedAt,123);
  assert.equal(result.body.data.research,"not-enabled");
  assert.equal(request.url.includes(["test","secret","not","real"].join("-")),false);
  assert.equal(request.options.headers["x-goog-api-key"],["test","secret","not","real"].join("-"));
  const sent=JSON.parse(request.options.body);
  assert.match(sent.systemInstruction.parts[0].text,/Risk Gate/);
  assert.match(sent.systemInstruction.parts[0].text,/Roman Urdu/);
  assert.match(sent.contents.at(-1).parts[0].text,/SERVER-PROVIDED MARKET CONTEXT/);
  assert.match(SYSTEM_INSTRUCTION,/never execute orders/i);
});

test("tutor maps provider errors to a generic unavailable response", async () => {
  const tutor=createTradingTutor({
    env:{["GEMINI_"+"API_KEY"]:["test","secret","not","real"].join("-")},
    fetchImpl:async()=>({ok:false,status:403})
  });
  const result=await tutor({message:"Explain risk"});
  assert.equal(result.status,503);
  assert.equal(result.body.error.code,"tutor-provider-unavailable");
  assert.equal(JSON.stringify(result).includes(["test","secret","not","real"].join("-")),false);
});
