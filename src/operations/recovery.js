export function readiness({db,market,risk,backup,rollback}={}){const checks={db:Boolean(db),market:Boolean(market),risk:Boolean(risk),backup:Boolean(backup),rollback:Boolean(rollback)};return Object.freeze({ready:Object.values(checks).every(Boolean),checks});}
export function requireReady(x){if(!x?.ready)throw new Error("operations not ready");return true;}
