export function inputCoverage({required=[],provided=[]}={}){const p=new Set(provided);const missing=required.filter(x=>!p.has(x));return Object.freeze({coverage:required.length?1-missing.length/required.length:1,missing,representative:missing.length===0});}
export function requireRepresentativeness(result){if(!result?.representative)throw new Error("AI input coverage insufficient");return true;}
