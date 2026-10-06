import test from "node:test";
import assert from "node:assert/strict";
import {sma, ema, vwap, macd, bollinger, supportResistance} from "../src/indicators/trend.js";

const C = (high, low, close, volume = 0) => ({open: close, high, low, close, volume, ts: 0});

test("sma pads warm-up with null and averages trailing windows",()=>{assert.deepEqual(sma([1,2,3,4,5],3),[null,null,2,3,4]);});
test("sma at index i only uses values[0..i] (no look-ahead)",()=>{assert.deepEqual(sma([0,0,0,6],3),[null,null,0,2]);});
test("sma only nulls windows that contain bad values",()=>{assert.deepEqual(sma([1,2,NaN,4,5],2),[null,1.5,null,null,4.5]);});
test("sma edge cases fail safe instead of throwing",()=>{assert.deepEqual(sma([],3),[]);assert.deepEqual(sma([1,2,3],4),[null,null,null]);assert.deepEqual(sma([1,2,3],0),[null,null,null]);assert.deepEqual(sma([1,2,3],1.5),[null,null,null]);assert.deepEqual(sma(null,3),[]);});
test("ema seeds with the window average then smooths with alpha=2/(period+1)",()=>{assert.deepEqual(ema([2,4,6,8],3),[null,null,4,6]);});
test("ema with period 1 tracks the values exactly",()=>{assert.deepEqual(ema([3,7],1),[3,7]);});
test("ema is null from the first non-finite input onward",()=>{assert.deepEqual(ema([1,2,NaN,4,5],2),[null,1.5,null,null,null]);});
test("ema edge cases fail safe",()=>{assert.deepEqual(ema([1,2,3],4),[null,null,null]);assert.deepEqual(ema([],2),[]);assert.deepEqual(ema([1,2,3],-1),[null,null,null]);});
test("vwap is cumulative typical-price weighted",()=>{const cs=[C(10,10,10,100),C(12,12,12,100),C(15,15,15,200)];assert.deepEqual(vwap(cs),[10,11,13]);});
test("vwap uses the typical price (high+low+close)/3",()=>{assert.deepEqual(vwap([C(9,3,6,10)]),[6]);});
test("vwap stays null while cumulative volume is zero",()=>{assert.deepEqual(vwap([C(10,10,10,0),C(12,12,12,100)]),[null,12]);});
test("vwap is null from the first invalid candle onward",()=>{const cs=[C(10,10,10,100),C(12,12,12,-5),C(15,15,15,200)];assert.deepEqual(vwap(cs),[10,null,null]);});
test("macd line, signal and histogram align with the input",()=>{const values=[1,3,5,7,9,11,13,15,17,19,21,23,25];const r=macd(values,3,7,3);assert.deepEqual(r.macd,[null,null,null,null,null,null,4,4,4,4,4,4,4]);assert.deepEqual(r.signal,[null,null,null,null,null,null,null,null,4,4,4,4,4]);assert.deepEqual(r.histogram,[null,null,null,null,null,null,null,null,0,0,0,0,0]);});
test("macd default warm-up is 26 bars for the line and 9 more for the signal",()=>{const values=Array.from({length:40},(_,i)=>1+2*i);const r=macd(values);assert.equal(r.macd.length,40);assert.equal(r.macd[24],null);assert.ok(Number.isFinite(r.macd[25]));assert.equal(r.signal[32],null);assert.ok(Number.isFinite(r.signal[33]));assert.equal(r.histogram[25],null);assert.ok(Number.isFinite(r.histogram[33]));});
test("macd invalid parameters and inputs fail safe",()=>{assert.deepEqual(macd([1,2,3],5,5,2),{macd:[null,null,null],signal:[null,null,null],histogram:[null,null,null]});assert.deepEqual(macd("nope"),{macd:[],signal:[],histogram:[]});});
test("bollinger matches the hand-computed classic example",()=>{const r=bollinger([2,4,4,4,5,5,7,9],8,2);assert.deepEqual(r.upper,[null,null,null,null,null,null,null,9]);assert.deepEqual(r.middle,[null,null,null,null,null,null,null,5]);assert.deepEqual(r.lower,[null,null,null,null,null,null,null,1]);});
test("bollinger rescales with mult and defaults to period 20",()=>{const r=bollinger([2,4,4,4,5,5,7,9],8,1);assert.deepEqual(r.upper,[null,null,null,null,null,null,null,7]);assert.deepEqual(r.lower,[null,null,null,null,null,null,null,3]);const d=bollinger([2,4,4,4,5,5,7,9]);assert.deepEqual(d.middle,[null,null,null,null,null,null,null,null]);});
test("supportResistance finds trailing extremes over lookback candles",()=>{const cs=[C(10,8,9),C(12,9,11),C(11,7,10),C(15,12,13),C(13,11,12)];assert.deepEqual(supportResistance(cs,3),{support:7,resistance:15});assert.deepEqual(supportResistance(cs,2),{support:11,resistance:15});});
test("supportResistance fails safe on short or invalid windows",()=>{const cs=[C(10,8,9),C(12,9,11)];assert.deepEqual(supportResistance(cs,3),{support:null,resistance:null});assert.deepEqual(supportResistance([],2),{support:null,resistance:null});assert.deepEqual(supportResistance([C(10,8,9),{open:1,high:NaN,low:2,close:1,volume:0,ts:0}],2),{support:null,resistance:null});assert.deepEqual(supportResistance([C(10,8,9),C(5,9,7)],2),{support:null,resistance:null});});
