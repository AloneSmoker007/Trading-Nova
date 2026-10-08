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
  async put(namespace,id,value,client=this.pool){
    if(!namespace||!id) throw new Error("namespace and id required");
    await client.query("INSERT INTO trading_state(namespace,state_id,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,state_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[namespace,id,JSON.stringify(value)]);
    return structuredClone(value);
  }
  async get(namespace,id,client=this.pool){
    const r=await client.query("SELECT value FROM trading_state WHERE namespace=$1 AND state_id=$2",[namespace,id]);
    return r.rows[0] ? structuredClone(r.rows[0].value) : null;
  }
  async list(namespace){
    const r=await this.pool.query("SELECT value FROM trading_state WHERE namespace=$1 ORDER BY state_id",[namespace]);
    return r.rows.map(row=>structuredClone(row.value));
  }
  async transactIdempotent(key,operation){
    if(!key) throw new Error("idempotency key required");
    if(typeof operation!=="function") throw new Error("operation required");
    return this.withTransaction(async client=>{
      // M7: SELECT ... FOR UPDATE on a not-yet-existing row locks nothing, so
      // concurrent same-key calls would both execute the operation and the
      // loser's INSERT would fail the whole call. Serialize per key with an
      // advisory transaction lock; the loser then reads the winner's result.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",["trading_nova:idempotency:"+key]);
      const existing=await client.query("SELECT result FROM trading_idempotency WHERE idempotency_key=$1",[key]);
      if(existing.rowCount) return structuredClone(existing.rows[0].result);
      // The operation must write through `tx` so its writes join THIS
      // transaction (H3): store.put on a pooled connection would escape it.
      const tx={client,put:(ns,id,value)=>this.put(ns,id,value,client),get:(ns,id)=>this.get(ns,id,client)};
      const result=await operation(tx);
      if(result===undefined) throw new Error("idempotent operation must return a result");
      const cached=structuredClone(result);
      await client.query("INSERT INTO trading_idempotency(idempotency_key,result) VALUES($1,$2::jsonb)",[key,JSON.stringify(result)]);
      return cached;
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
  async list(namespace,client=this.pool){
    const r=await client.query("SELECT value FROM trading_state WHERE namespace=$1 ORDER BY state_id ASC",[namespace]);
    return r.rows.map((row)=>structuredClone(row.value));
  }
  async health(){ const r=await this.pool.query("SELECT 1 AS ok"); return r.rows[0]?.ok===1; }
  async assertReady(){
    const migrations=await this.pool.query("SELECT version FROM trading_schema_migrations ORDER BY version");
    const versions=new Set(migrations.rows.map(row=>row.version));
    const required=["001_initial.sql","002_constraints.sql"];
    const missing=required.filter(version=>!versions.has(version));
    if(missing.length) throw new Error("required PostgreSQL migrations are not applied");
    return true;
  }
}
export async function createPostgresStore({connectionString,max=10,idleTimeoutMillis=10000,schema}={}){
  if(!connectionString) throw new Error("POSTGRES_URL required");
  const {Pool}=await import("pg");
  const config={connectionString,max,idleTimeoutMillis};
  if(schema!==undefined){
    if(typeof schema!=="string"||!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("invalid PostgreSQL schema");
    // Neon poolers reject custom startup options, so set the path per connection.
    config.onConnect=client=>client.query("SELECT set_config('search_path',$1,false)",[schema]);
  }
  const store=new PostgresStore(new Pool(config));
  try {
    await store.health();
    if(schema!==undefined){
      const result=await store.pool.query("SELECT current_schema() AS schema");
      if(result.rows[0]?.schema!==schema){
        const error=new Error("schema selection failed");
        error.code="SCHEMA_MISMATCH";
        throw error;
      }
    }
  } catch (error) {
    await store.pool.end().catch(()=>{});
    const failure=new Error("requested PostgreSQL schema is unavailable");
    if(typeof error?.code==="string"&&/^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)) failure.code=error.code;
    failure.safeDetail=String(error?.message??"")
      .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi,"[redacted PostgreSQL URL]")
      .replace(/password authentication failed for user\s+["']?[^"'\s,]+["']?/gi,"password authentication failed for user [redacted]")
      .replace(/\b(?:user|username|password|passwd|pwd|host|hostname|database|dbname)\s*[=:]\s*[^,\s)]+/gi,"[redacted connection field]")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g,"[redacted endpoint]")
      .replace(/\b[\w.-]+\.neon\.tech\b/gi,"[redacted endpoint]")
      .slice(0,180);
    throw failure;
  }
  return store;
}
