import test from "node:test";
import assert from "node:assert/strict";
import {rsi, stochastic, atr, adx, obv, divergence} from "../src/indicators/momentum.js";

const C = (high, low, close, volume = 0) => ({open: close, high, low, close, volume, ts: 0});

test("rsi hand-computed with Wilder smoothing",()=>{const r=rsi([10,11,12,13,12,13],4);assert.deepEqual(r.slice(0,4),[null,null,null,null]);assert.equal(r[4],75);assert.ok(Math.abs(r[5]-81.25)<1e-9);});
test("rsi is 100 in a pure uptrend and 0 in a pure downtrend",()=>{assert.deepEqual(rsi([1,2,3,4,5],2),[null,null,100,100,100]);assert.deepEqual(rsi([5,4,3,2,1],2),[null,null,0,0,0]);});
test("rsi is null for a flat series (gain and loss both zero)",()=>{assert.deepEqual(rsi([5,5,5,5],2),[null,null,null,null]);});
test("rsi warm-up and edge cases fail safe",()=>{assert.deepEqual(rsi([1,2,3],5),[null,null,null]);assert.deepEqual(rsi([1,2,3],0),[null,null,null]);assert.deepEqual(rsi([],2),[]);assert.deepEqual(rsi([1,2,NaN,4],2),[null,null,null,null]);assert.deepEqual(rsi(null,2),[]);});
test("stochastic hand-computed %K and %D",()=>{const cs=[C(20,4,12),C(18,6,10),C(16,8,14),C(20,4,8)];const r=stochastic(cs,3,2);assert.deepEqual(r.k,[null,null,62.5,25]);assert.deepEqual(r.d,[null,null,null,43.75]);});
test("stochastic nulls zero-range windows and invalid candles",()=>{const flat=[C(5,5,5),C(5,5,5),C(5,5,5)];assert.deepEqual(stochastic(flat,3,2).k,[null,null,null]);const cs=[C(10,8,9),C(12,9,11),{open:1,high:NaN,low:2,close:1,volume:0,ts:0}];const r=stochastic(cs,2,2);assert.deepEqual(r.k,[null,75,null]);assert.deepEqual(r.d,[null,null,null]);});
test("stochastic edge cases fail safe",()=>{assert.deepEqual(stochastic([C(10,8,9),C(12,9,11)],3,2),{k:[null,null],d:[null,null]});assert.deepEqual(stochastic([C(10,8,9)],0,2),{k:[null],d:[null]});assert.deepEqual(stochastic(null,3,2),{k:[],d:[]});});
test("atr hand-computed true-range smoothing",()=>{const cs=[C(10,8,9),C(12,9,10),C(11,8,9),C(13,10,12)];const r=atr(cs,2);assert.deepEqual(r,[null,2.5,2.75,3.375]);});
test("atr warm-up and edge cases fail safe",()=>{const cs=[C(10,8,9),C(12,9,10),C(11,8,9),C(13,10,12)];assert.deepEqual(atr(cs,14),[null,null,null,null]);assert.deepEqual(atr([],3),[]);assert.deepEqual(atr(cs,0),[null,null,null,null]);const poisoned=[C(10,8,9),C(12,9,10),{open:1,high:NaN,low:2,close:1,volume:0,ts:0},C(13,10,12)];assert.deepEqual(atr(poisoned,2),[null,2.5,null,null]);});
test("adx is 100 in a steady uptrend (DX always maximal)",()=>{const cs=Array.from({length:20},(_,i)=>C(i+11,i+9,i+10));const r=adx(cs,5);assert.deepEqual(r.slice(0,9),new Array(9).fill(null));assert.deepEqual(r.slice(9),new Array(11).fill(100));});
test("adx hand-computed on mixed directional movement",()=>{const cs=[C(10,8,9),C(12,7,10),C(11,5,8),C(13,4,6),C(12,2,4)];assert.deepEqual(adx(cs,2),[null,null,null,25,25]);});
test("adx flat market and edge cases fail safe",()=>{const flat=Array.from({length:20},()=>C(5,5,5));assert.deepEqual(adx(flat,5),new Array(20).fill(null));assert.deepEqual(adx([C(10,8,9),C(12,9,10),C(11,8,9)],2),[null,null,null]);assert.deepEqual(adx([],3),[]);});
test("obv accumulates signed volume from a zero base",()=>{const cs=[{close:10,volume:100},{close:11,volume:200},{close:10,volume:300},{close:10,volume:400},{close:12,volume:500}];assert.deepEqual(obv(cs),[0,200,-100,-100,400]);});
test("obv keeps flat closes unchanged and fails safe on bad candles",()=>{assert.deepEqual(obv([{close:10,volume:50},{close:10,volume:60}]),[0,0]);assert.deepEqual(obv([]),[]);assert.deepEqual(obv([{close:10,volume:NaN}]),[null]);assert.deepEqual(obv([{close:10,volume:100},{close:11,volume:200},{close:12,volume:NaN}]),[0,200,null]);});
test("divergence detects bullish pivot-low divergence",()=>{assert.deepEqual(divergence([50,30,60,40,35,70],[10,8,10,9,7,12],6),{bullish:true,bearish:false});});
test("divergence detects bearish pivot-high divergence",()=>{assert.deepEqual(divergence([50,70,40,60,30],[10,12,10,13,9],5),{bullish:false,bearish:true});});
test("divergence is false when pivots agree with price",()=>{assert.deepEqual(divergence([1,2,3,4,5],[1,2,3,4,5],5),{bullish:false,bearish:false});});
test("divergence edge cases fail safe",()=>{const none={bullish:null,bearish:null};assert.deepEqual(divergence([1,2,3],[1,2],3),none);assert.deepEqual(divergence([1,2,3],[1,2,3],4),none);assert.deepEqual(divergence([1,2,3],[1,2,3],2),none);assert.deepEqual(divergence([1,NaN,3],[1,2,3],3),none);assert.deepEqual(divergence(null,[1,2,3],3),none);});
