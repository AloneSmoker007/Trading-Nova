import test from "node:test";
import assert from "node:assert/strict";
import {correlation,rollingCorrelation,beta,lagCorrelation,confirmSignal,relativeStrength} from "../src/indicators/relationship.js";

test("correlation is exactly 1 / -1 on perfect linear series",()=>{
  assert.equal(correlation([1,2,3,4],[2,4,6,8]),1); // perfectly linear, slope 2
  assert.equal(correlation([1,2,3],[3,2,1]),-1);
  assert.equal(correlation([1,2,3],[1,2,3]),1); // identical series
  assert.equal(correlation([0.1,0.2,0.3],[0.1,0.2,0.3]),1); // float identity
});

test("correlation matches a hand-computed value",()=>{
  // deviations: a=[1,2,3,4] -> [-1.5,-0.5,0.5,1.5], b=[1,1,2,2] -> [-0.5,-0.5,0.5,0.5]
  // sum(dx*dy)=2, sum(dx^2)=5, sum(dy^2)=1 => r = 2/sqrt(5) ~ 0.8944271909999169
  assert.equal(correlation([1,2,3,4],[1,1,2,2]),2/Math.sqrt(5));
});

test("correlation returns null when undefined (zero variance or bad input)",()=>{
  assert.equal(correlation([1,1,1],[1,2,3]),null); // zero variance in a
  assert.equal(correlation([1,2,3],[7,7,7]),null); // zero variance in b
  assert.equal(correlation([2,2,2],[3,3,3]),null); // zero variance in both
  assert.equal(correlation([],[]),null);
  assert.equal(correlation([1],[1]),null); // single element
  assert.equal(correlation([1,2,3],[1,2]),null); // mismatched lengths
  assert.equal(correlation([1,2,NaN],[1,2,3]),null);
  assert.equal(correlation(null,[1,2,3]),null);
});

test("rollingCorrelation aligns to input with null warm-up",()=>{
  // every 3-bar window of [1..5] vs [2,4,6,8,10] is perfectly linear
  assert.deepEqual(rollingCorrelation([1,2,3,4,5],[2,4,6,8,10],3),[null,null,1,1,1]);
  // a constant window has zero variance => null, not NaN
  assert.deepEqual(rollingCorrelation([1,1,1,1],[1,2,3,4],2),[null,null,null,null]);
  assert.deepEqual(rollingCorrelation([],[],3),[]);
  assert.deepEqual(rollingCorrelation([1,2,3],[1,2],3),[]); // mismatched lengths
  assert.deepEqual(rollingCorrelation([1,2,3],[1,2,3],1),[null,null,null]); // window < 2 undefined
  assert.deepEqual(rollingCorrelation([1,2,3],[1,2,3],NaN),[null,null,null]);
});

test("rollingCorrelation cannot see the future",()=>{
  const a=[3,1,4,1,5,9,2,6,5,3,5,8];
  const b=[2,7,1,8,2,8,1,8,2,8,4,5];
  const full=rollingCorrelation(a,b,4);
  const bumped=b.slice();
  bumped[8]=bumped[8]+10;
  const after=rollingCorrelation(a,bumped,4);
  // windows ending before index 8 only use b[0..7]: untouched by the perturbation
  assert.deepEqual(after.slice(0,8),full.slice(0,8));
  assert.notDeepEqual(after[8],full[8]); // the perturbation did land
});

test("beta is cov/var with hand-computed values",()=>{
  assert.equal(beta([2,4,6],[1,2,3]),2); // asset = 2x market => beta 2
  assert.equal(beta([3,2,1],[1,2,3]),-1);
  assert.equal(beta([1,2,3],[1,2,3]),1);
  assert.equal(beta([5,5,5],[1,2,3]),0); // flat asset vs moving market => 0
});

test("beta fails safe when undefined",()=>{
  assert.equal(beta([1,2,3],[5,5,5]),null); // zero market variance
  assert.equal(beta([],[]),null);
  assert.equal(beta([1],[1]),null);
  assert.equal(beta([1,2,3],[1,2]),null);
  assert.equal(beta([1,2,NaN],[1,2,3]),null);
});

test("lagCorrelation finds the lag with the strongest past-only relationship",()=>{
  // b leads a by exactly one bar: a[i] = b[i-1] (except the seeded a[0]=100),
  // so lag 1 pairs identical sequences => corr exactly 1, unique in |corr|
  const a=[100,5,1,8,3,9,2,7,4];
  const b=[5,1,8,3,9,2,7,4,6];
  assert.deepEqual(lagCorrelation(a,b,3),{lag:1,corr:1});
  // exact ties resolve to the smallest lag (deterministic)
  assert.deepEqual(lagCorrelation([1,2,3,4],[1,2,3,4],3),{lag:0,corr:1});
});

test("lagCorrelation fails safe when nothing is defined",()=>{
  const none={lag:null,corr:null};
  assert.deepEqual(lagCorrelation([],[],5),none);
  assert.deepEqual(lagCorrelation([1,2,3],[1,2],5),none); // mismatched lengths
  assert.deepEqual(lagCorrelation([1,1,1],[1,1,1],5),none); // zero variance at every lag
  assert.deepEqual(lagCorrelation([1,2,3,4],[1,2,3,4],-1),none); // bad maxLag
});

test("lagCorrelation stops when the lag leaves fewer than 2 pairs",()=>{
  // maxLag far beyond the series: only lag 0 is feasible and it is exact
  assert.deepEqual(lagCorrelation([1,2],[2,4],10),{lag:0,corr:1});
});

test("confirmSignal agrees only on matching non-neutral directions",()=>{
  assert.deepEqual(confirmSignal("bullish","up"),{confirmed:true,reason:"AGREE_BULLISH"});
  assert.deepEqual(confirmSignal("bearish","short"),{confirmed:true,reason:"AGREE_BEARISH"});
  assert.deepEqual(confirmSignal(1,"long"),{confirmed:true,reason:"AGREE_BULLISH"}); // mixed forms agree
  assert.deepEqual(confirmSignal(-1,"sell"),{confirmed:true,reason:"AGREE_BEARISH"});
  assert.deepEqual(confirmSignal("bullish","bearish"),{confirmed:false,reason:"CONFLICT"});
  assert.deepEqual(confirmSignal("up","down"),{confirmed:false,reason:"CONFLICT"});
});

test("confirmSignal fails closed on unknown or neutral inputs",()=>{
  assert.deepEqual(confirmSignal(null,"up"),{confirmed:false,reason:"UNKNOWN"});
  assert.deepEqual(confirmSignal("up",undefined),{confirmed:false,reason:"UNKNOWN"});
  assert.deepEqual(confirmSignal("up",NaN),{confirmed:false,reason:"UNKNOWN"});
  assert.deepEqual(confirmSignal("","up"),{confirmed:false,reason:"UNKNOWN"});
  assert.deepEqual(confirmSignal("maybe","up"),{confirmed:false,reason:"UNKNOWN"});
  assert.deepEqual(confirmSignal(null,null),{confirmed:false,reason:"UNKNOWN"});
  assert.deepEqual(confirmSignal("up","WAIT"),{confirmed:false,reason:"NEUTRAL"});
  assert.deepEqual(confirmSignal(0,"up"),{confirmed:false,reason:"NEUTRAL"});
  assert.deepEqual(confirmSignal("neutral","neutral"),{confirmed:false,reason:"NEUTRAL"});
});

test("relativeStrength returns the RS line and its period ratio",()=>{
  // line = [10/5, 20/5, 30/10, 40/10] = [2,4,3,4]
  // ratio[i] = line[i]/line[i-2] => [null,null,3/2,4/4]
  const {line,ratio}=relativeStrength([10,20,30,40],[5,5,10,10],2);
  assert.deepEqual(line,[2,4,3,4]);
  assert.deepEqual(ratio,[null,null,1.5,1]);
});

test("relativeStrength nulls out invalid points instead of throwing",()=>{
  const {line,ratio}=relativeStrength([1,2,3],[1,0,3],1);
  assert.deepEqual(line,[1,null,1]); // zero denominator => null
  assert.deepEqual(ratio,[null,null,null]); // null propagates through the ratio
  assert.deepEqual(relativeStrength([],[],2),{line:[],ratio:[]});
  assert.deepEqual(relativeStrength([1,2],[1],2),{line:[],ratio:[]}); // mismatched lengths
  assert.deepEqual(relativeStrength([1,2,3],[1,2,3],0),{line:[null,null,null],ratio:[null,null,null]}); // bad period
  assert.deepEqual(relativeStrength([1,NaN,3],[1,2,3],1),{line:[1,null,1],ratio:[null,null,null]});
});

test("relativeStrength ratio only uses past values",()=>{
  const b=[5,5,10,10,10,10];
  const full=relativeStrength([10,20,30,40,50,60],b,2);
  const bumped=relativeStrength([10,20,30,40,999,60],b,2);
  // ratio[i] = line[i]/line[i-2]: outputs before index 4 cannot depend on a[4]
  assert.deepEqual(bumped.line.slice(0,4),full.line.slice(0,4));
  assert.deepEqual(bumped.ratio.slice(0,4),full.ratio.slice(0,4));
  assert.notDeepEqual(bumped.line[4],full.line[4]); // the perturbation did land
});
