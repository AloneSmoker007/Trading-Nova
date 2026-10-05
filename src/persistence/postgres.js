import {createHash} from "node:crypto";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,stable(value[key])]));
  return value;
}

function auditHash(entry, previousHash) {
  return createHash("sha256").update(JSON.stringify(stable({entry,previousHash}))).digest("hex");
}

export class PostgresStore {
  constructor(pool){ if(!pool || typeof pool.connect!=="function") throw new Error("postgres pool required"); this.pool=pool; }
  async withTransaction(fn){
    const client=await this.pool.connect();
    try{ await client.query("BEGIN"); const result=await fn(client); await client.query("COMMIT"); return result; }
    catch(error){ try{ await client.query("ROLLBACK"); } catch{} throw error; }
    finally{ client.release(); }
  }
  async put(namespace,id,value){
    if(!namespace||!id) throw new Error("namespace and id required");
    await this.pool.query("INSERT INTO trading_state(namespace,state_id,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,state_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[namespace,id,JSON.stringify(value)]);
    return structuredClone(value);
  }
  async get(namespace,id){
    const r=await this.pool.query("SELECT value FROM trading_state WHERE namespace=$1 AND state_id=$2",[namespace,id]);
    return r.rows[0] ? structuredClone(r.rows[0].value) : null;
  }
  async transactIdempotent(key,operation){
    if(!key) throw new Error("idempotency key required");
    return this.withTransaction(async client=>{
      const existing=await client.query("SELECT result FROM trading_idempotency WHERE idempotency_key=$1 FOR UPDATE",[key]);
      if(existing.rowCount) return structuredClone(existing.rows[0].result);
      const result=await operation(client);
      await client.query("INSERT INTO trading_idempotency(idempotency_key,result) VALUES($1,$2::jsonb)",[key,JSON.stringify(result)]);
      return structuredClone(result);
    });
  }
  async appendAudit(entry){
    return this.withTransaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtext('trading_nova:audit-chain')::bigint)");
      const prev=await client.query("SELECT hash FROM trading_audit ORDER BY sequence DESC LIMIT 1");
      const previousHash=prev.rows[0]?.hash ?? null;
      const hash=auditHash(entry,previousHash);
      const r=await client.query("INSERT INTO trading_audit(entry,previous_hash,hash) VALUES($1::jsonb,$2,$3) RETURNING sequence,entry,previous_hash,hash,created_at",[JSON.stringify(entry),previousHash,hash]);
      return r.rows[0];
    });
  }
  async verifyAudit(){
    const r=await this.pool.query("SELECT sequence,entry,previous_hash,hash FROM trading_audit ORDER BY sequence ASC");
    let previousHash=null;
    for(const row of r.rows){
      if(row.previous_hash!==previousHash) return false;
      if(row.hash!==auditHash(row.entry,previousHash)) return false;
      previousHash=row.hash;
    }
    return true;
  }
  async health(){ const r=await this.pool.query("SELECT 1 AS ok"); return r.rows[0]?.ok===1; }
}
export async function createPostgresStore({connectionString,max=10,idleTimeoutMillis=10000}={}){
  if(!connectionString) throw new Error("POSTGRES_URL required");
  const {Pool}=await import("pg");
  return new PostgresStore(new Pool({connectionString,max,idleTimeoutMillis}));
}
