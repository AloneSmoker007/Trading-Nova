// src/intelligence/alternative-data.js
//
// External/alternative evidence (news, sentiment, on-chain feeds — typically
// AI-ingested) is the least trustworthy input class, so the trust gate FAILS
// CLOSED: evidence without an explicit finite trust in [0,1] is treated as
// trust 0 (not fully trusted), matching src/market-data/source.js where
// SOURCE_TRUST.unknown = 0. (This used to default to 1.0 — full trust for
// anything that simply omitted the field.)
export function normalizeExternalEvidence({source,type,value,timestamp,trust,now=Date.now(),maxAgeMs=300000}={}){
  if(!source||!type||!Number.isFinite(value)||!Number.isFinite(timestamp))throw new Error("invalid external evidence");
  if(trust!==undefined&&!(typeof trust==="number"&&Number.isFinite(trust)&&trust>=0&&trust<=1))throw new Error("invalid external evidence");
  const ageMs=Math.max(0,now-timestamp);
  return Object.freeze({source,type,value,timestamp,ageMs,fresh:ageMs<=maxAgeMs,trust:trust===undefined?0:trust});
}
export function externalEvidenceAllowed(evidence,{minTrust=.7}={}){
  return Boolean(evidence?.fresh&&typeof evidence.trust==="number"&&Number.isFinite(evidence.trust)&&evidence.trust>=minTrust);
}
