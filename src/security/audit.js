export function securityEvent(type,details={}){return Object.freeze({type:String(type),details:structuredClone(details),timestamp:Date.now()});}
export function redactSecrets(value){return JSON.parse(JSON.stringify(value,(k,v)=>/token|secret|password|api.?key|authorization/i.test(k)?"[REDACTED]":v));}
