function sortAsOf(records){return [...records].sort((a,b)=>a.observedAt-b.observedAt);}
function snapshotAsOf(records,asOf){if(!Number.isFinite(asOf))throw new TypeError("asOf must be finite");return sortAsOf(records).filter(r=>r.observedAt<=asOf).at(-1)??null;}
export {sortAsOf,snapshotAsOf};