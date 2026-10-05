const states=["research","validated","paper","shadow","limited-live","live","retired"];
const allowed={research:["validated","retired"],validated:["paper","retired"],paper:["shadow","retired"],shadow:["limited-live","retired"],"limited-live":["live","retired"],live:["retired"],retired:[]};

export function createStrategy(id, version) {
  if (!id || !version) throw new Error("strategy id/version required");
  return Object.freeze({id,version,state:"research"});
}
export function promoteStrategy(strategy,target,{certificate=false,testsPassed=false}={}) {
  if (!states.includes(target) || !allowed[strategy.state]?.includes(target)) throw new Error("invalid promotion");
  if (target!=="retired" && (!certificate || !testsPassed)) throw new Error("promotion certificate required");
  return Object.freeze({...strategy,state:target});
}