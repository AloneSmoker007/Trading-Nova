export function buildResearchTrace({requestId,sources=[],agents=[],decision="WAIT"}={}){return Object.freeze({requestId,sources:structuredClone(sources),agents:structuredClone(agents),decision,createdAt:Date.now()});}
export function verifyResearchTrace(trace){return Boolean(trace?.requestId&&Array.isArray(trace.sources)&&Array.isArray(trace.agents)&&trace.createdAt);}
