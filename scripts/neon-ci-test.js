import {spawnSync} from "node:child_process";

function redact(output){
  let text=String(output);
  if(process.env.POSTGRES_URL) text=text.replaceAll(process.env.POSTGRES_URL,"[redacted PostgreSQL URL]");
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi,"[redacted PostgreSQL URL]")
    .replace(/password authentication failed for user\s+["']?[^"'\s,]+["']?/gi,"password authentication failed for user [redacted]")
    .replace(/\b(?:user|username|password|passwd|pwd|host|hostname|database|dbname)\s*[=:]\s*[^,\s)]+/gi,"[redacted connection field]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g,"[redacted endpoint]")
    .replace(/\b[\w.-]+\.neon\.tech\b/gi,"[redacted endpoint]")
    .slice(0,30000);
}

const result=spawnSync(process.execPath,["--test","tests/postgres.integration.test.js"],{
  encoding:"utf8",
  maxBuffer:2*1024*1024,
  timeout:14*60*1000
});

if(result.status===0){
  process.stdout.write("Neon PostgreSQL integration tests passed.\n");
}else{
  if(result.error) process.stderr.write("Could not start the Neon integration test runner.\n");
  const output=redact(`${result.stdout??""}${result.stderr??""}`);
  process.stderr.write(output||"Neon PostgreSQL integration tests failed without diagnostics.\n");
  process.exitCode=result.status??1;
}
