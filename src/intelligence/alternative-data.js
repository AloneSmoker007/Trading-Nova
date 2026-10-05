export function normalizeExternalEvidence({source,type,value,timestamp,now=Date.now(),maxAgeMs=300000}={}){
  if(!source||!type||!Number.isFinite(value)||!Number.isFinite(timestamp))throw new Error("invalid external evidence");
  const ageMs=Math.max(0,now-timestamp);return Object.freeze({source,type,value,timestamp,ageMs,fresh:ageMs<=maxAgeMs});
}
export function externalEvidenceAllowed(evidence,{minTrust=.7}={}){return Boolean(evidence?.fresh&&Number(evidence.trust??1)>=minTrust);}
