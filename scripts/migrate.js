import {readdir,readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createPostgresStore} from "../src/persistence/postgres.js";

const root=path.dirname(fileURLToPath(import.meta.url));
const dir=path.resolve(root,"../db/migrations");
const files=(await readdir(dir)).filter(x=>x.endsWith(".sql")).sort();
const store=await createPostgresStore({connectionString:process.env.POSTGRES_URL});
await store.withTransaction(async client=>{
  await client.query("CREATE TABLE IF NOT EXISTS trading_schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const {createHash}=await import("node:crypto");
  for(const file of files){
    const sql=await readFile(path.join(dir,file),"utf8");
    const checksum=createHash("sha256").update(sql).digest("hex");
    const existing=await client.query("SELECT checksum FROM trading_schema_migrations WHERE version=$1",[file]);
    if(existing.rowCount){ if(existing.rows[0].checksum!==checksum) throw new Error(`migration checksum mismatch: ${file}`); continue; }
    await client.query(sql);
    await client.query("INSERT INTO trading_schema_migrations(version,checksum) VALUES($1,$2)",[file,checksum]);
  }
});
console.log(JSON.stringify({ok:true,migrations:files.length}));
