import test from "node:test";
import assert from "node:assert/strict";
import {marketStructure,swings,breakout,trendDirection,volatilityAdjustedLevel} from "../src/indicators/structure.js";

// rows are [high, low, close]; open is unused by the module
function build(rows){return rows.map((r,i)=>({open:r[2],high:r[0],low:r[1],close:r[2],volume:1,ts:i}));}

// Hand-built 22-bar path: rise to a swing high (110 @3), decline to a swing low
// (89 @10), rally that closes through 110 on bar 14, then a collapse through 89
// on bar 20. Highs = close+1 except bar 3 (high = close = 110); lows = close-1
// except bar 10 (low = 89).
const H=[103,106,109,110,108,105,102,99,96,93,91,94,97,100,112,113,114,111,106,101,89,88];
const L=[101,104,107,109,106,103,100,97,94,91,89,92,95,98,110,111,112,109,104,99,87,86];
const C=[102,105,108,110,107,104,101,98,95,92,90,93,96,99,111,112,113,110,105,100,88,87];
const base=H.map((h,i)=>({open:C[i],high:h,low:L[i],close:C[i],volume:1,ts:i}));

test("swings finds fractal pivot highs and lows",()=>{
  assert.deepEqual(swings(base,3),[
    {index:3,price:110,type:"high"},
    {index:10,price:89,type:"low"},
    {index:16,price:114,type:"high"}
  ]);
});

test("swings excludes window edges, ties and invalid windows",()=>{
  // highs [1,3,2] => strict max at 1; lows [0,0,0] are ties => no swing low
  assert.deepEqual(swings(build([[1,0,1],[3,0,3],[2,0,2]]),1),[{index:1,price:3,type:"high"}]);
  // lows [2,1,2] => strict min at 1; highs [3,3,3] are ties => no swing high
  assert.deepEqual(swings(build([[3,2,3],[3,1,3],[3,2,3]]),1),[{index:1,price:1,type:"low"}]);
  // a 2-bar series has no interior pivot for strength 1
  assert.deepEqual(swings(build([[1,0,1],[3,0,3]]),1),[]);
  // all-equal highs never qualify (must be the *strict* max)
  assert.deepEqual(swings(build([[10,8,9],[10,8,9],[10,8,9]]),1),[]);
});

test("swings fails safe on invalid input",()=>{
  assert.deepEqual(swings([],3),[]);
  assert.deepEqual(swings(null,3),[]);
  assert.deepEqual(swings(base,0),[]);
  assert.deepEqual(swings(base,NaN),[]);
  // any invalid candle inside the fractal window voids that pivot
  assert.deepEqual(swings(build([[1,0,1],[2,0,2],[NaN,0,1],[2,0,2],[1,0,1]]),1),[]);
});

test("breakout detects a close beyond the prior range",()=>{
  assert.deepEqual(breakout(build([[12,10,11],[13,11,12],[12,10,11],[11,9,10],[16,13,15]]),3),
    {ok:true,direction:"up",level:13,index:4}); // prior highs [13,12,11] => level 13
  assert.deepEqual(breakout(build([[12,10,11],[11,9,10],[10,8,9],[12,10,11],[8,5,6]]),3),
    {ok:true,direction:"down",level:8,index:4}); // prior lows [9,8,10] => level 8
});

test("breakout reports the most recent breakout",()=>{
  assert.deepEqual(breakout(build([[12,10,11],[13,11,12],[12,10,11],[11,9,10],[16,13,15],[20,18,19]]),3),
    {ok:true,direction:"up",level:16,index:5}); // bar 5 beats bar 4; level = prior high 16
});

test("breakout returns direction null when the range holds",()=>{
  const none={ok:false,direction:null,level:null,index:null};
  assert.deepEqual(breakout(build([[10,10,10],[10,10,10],[10,10,10],[10,10,10]]),3),none);
  // close exactly at the prior range edge (13) is not "beyond" it
  assert.deepEqual(breakout(build([[12,10,11],[13,11,12],[12,10,11],[13,9,13]]),3),none);
});

test("breakout fails safe on short, empty or invalid input",()=>{
  const none={ok:false,direction:null,level:null,index:null};
  assert.deepEqual(breakout([],3),none);
  assert.deepEqual(breakout(null,3),none);
  assert.deepEqual(breakout(build([[12,10,11],[13,11,12]]),5),none); // period > length-1
  assert.deepEqual(breakout(build([[12,10,11],[13,11,12]]),0),none);
  // a bar with an invalid high poisons its lookback window: no breakout is claimed
  assert.deepEqual(breakout(build([[NaN,9,10],[12,10,11],[16,13,15]]),2),none);
});

test("trendDirection combines MA cross and long-MA slope",()=>{
  const up=Array.from({length:60},(_,i)=>i+1);
  const down=Array.from({length:60},(_,i)=>60-i);
  // up: maShort=59.5 > maLong=58 and maLong rose from 57 => slope +1
  assert.equal(trendDirection(up,2,5),"up");
  // down: maShort=1.5 < maLong=3 and maLong fell from 4 => slope -1
  assert.equal(trendDirection(down,2,5),"down");
  assert.equal(trendDirection([5,5,5,5,5,5],2,3),"sideways");
  // conflict: maShort=9.5 > maLong=3.8 but maLong fell 4 => 3.8 => not "up"
  assert.equal(trendDirection([10,0,0,0,10,9],2,5),"sideways");
});

test("trendDirection returns null on unusable input",()=>{
  assert.equal(trendDirection([]),null);
  assert.equal(trendDirection(null),null);
  assert.equal(trendDirection([1,2,3],2,5),null); // needs long+1 samples
  assert.equal(trendDirection([1,2,3,4,5,NaN],2,5),null); // invalid sample
  assert.equal(trendDirection([1,2,3,4,5,6],3,3),null); // short must be < long
  assert.equal(trendDirection([1,2,3,4,5,6],0,5),null);
});

test("volatilityAdjustedLevel scales the breakout distance by ATR",()=>{
  // TR = [2,3,3] => atr over last 2 bars = 3; prior range [8,12];
  // close 13 breaks up: distance 1 => scaled 1/3
  assert.deepEqual(volatilityAdjustedLevel(build([[10,8,9],[12,10,11],[14,12,13]]),2),
    {atr:3,rangeHigh:12,rangeLow:8,direction:"up",level:12,distance:1,scaled:1/3});
  // TR = [2,3,6] => atr 4.5; close 6 breaks down through 8: distance 2 => scaled 2/4.5
  assert.deepEqual(volatilityAdjustedLevel(build([[10,8,9],[12,10,11],[9,5,6]]),2),
    {atr:4.5,rangeHigh:12,rangeLow:8,direction:"down",level:8,distance:2,scaled:2/4.5});
});

test("volatilityAdjustedLevel is all-null without a breakout or enough data",()=>{
  // TR = [2,3,1] => atr 2; close 11.5 sits inside [8,12] => no breakout
  assert.deepEqual(volatilityAdjustedLevel(build([[10,8,9],[12,10,11],[12,11,11.5]]),2),
    {atr:2,rangeHigh:12,rangeLow:8,direction:null,level:null,distance:null,scaled:null});
  const na={atr:null,rangeHigh:null,rangeLow:null,direction:null,level:null,distance:null,scaled:null};
  assert.deepEqual(volatilityAdjustedLevel([],2),na);
  assert.deepEqual(volatilityAdjustedLevel(null,2),na);
  assert.deepEqual(volatilityAdjustedLevel(build([[10,8,9],[12,10,11]]),5),na);
});

test("marketStructure maps swings to BOS and CHOCH events",()=>{
  const res=marketStructure(base);
  assert.deepEqual(res.swings,[
    {index:3,price:110,type:"high"},
    {index:10,price:89,type:"low"},
    {index:16,price:114,type:"high"}
  ]);
  assert.deepEqual(res.events,[
    {index:14,type:"BOS",direction:"bullish"},   // first break through swing high 110
    {index:20,type:"CHOCH",direction:"bearish"}  // reversal through swing low 89
  ]);
});

test("marketStructure ignores stale swing levels outside the lookback",()=>{
  // with lookback=5 the 110 high (bar 3) is stale by bar 9 and the 89 low
  // (bar 10) by bar 16, so neither break on bars 14/20 is ever flagged
  assert.deepEqual(marketStructure(base,5).events,[]);
  // invalid lookback falls back to the default window
  assert.deepEqual(marketStructure(base,0).events,marketStructure(base).events);
});

test("marketStructure cannot see the future",()=>{
  const full=marketStructure(base);
  // a prefix run agrees with the full run on everything before the cut
  const prefix=marketStructure(base.slice(0,15));
  assert.deepEqual(prefix.events,full.events.filter(e=>e.index<15));
  // perturbing bar 20 leaves earlier events and pre-20 pivots untouched
  const bumped=structuredClone(base);
  bumped[20]={open:500,high:500,low:87,close:500,volume:1,ts:20};
  const after=marketStructure(bumped);
  assert.deepEqual(after.swings,full.swings);
  assert.deepEqual(after.events.filter(e=>e.index<20),full.events.filter(e=>e.index<20));
  // the perturbation did land: bar 20 now breaks up (BOS) and bar 21 reverses
  assert.deepEqual(after.events.filter(e=>e.index>=20),[
    {index:20,type:"BOS",direction:"bullish"},
    {index:21,type:"CHOCH",direction:"bearish"}
  ]);
});

test("marketStructure fails safe on empty input",()=>{
  assert.deepEqual(marketStructure([]),{swings:[],events:[]});
  assert.deepEqual(marketStructure(null),{swings:[],events:[]});
});
