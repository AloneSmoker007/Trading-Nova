#!/usr/bin/env node
import {readdir,readFile} from "node:fs/promises";
import path from "node:path";
import {validateEvidenceRecord,validateEvidenceRequirement,validateCertificationEvidence,REQUIRED_EVIDENCE} from "./evidence-schema.js";

const EXIT_CERTIFIED=0;
const EXIT_NOT_CERTIFIED=1;
const EXIT_ERROR=2;

export function parseArgs(argv=[]){
  const opts={dir:"evidence",json:false,allowIncomplete:false,help:false};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==="--dir"){opts.dir=argv[++i]??"";}
    else if(arg.startsWith("--dir=")){opts.dir=arg.slice("--dir=".length);}
    else if(arg==="--json"){opts.json=true;}
    else if(arg==="--allow-incomplete"){opts.allowIncomplete=true;}
    else if(arg==="--help"||arg==="-h"){opts.help=true;}
    else throw new Error(`unknown argument: ${arg}`);
  }
  if(!opts.dir) throw new Error("--dir requires a path");
  return Object.freeze(opts);
}

export async function loadEvidence(dir){
  let entries;
  try{entries=await readdir(dir,{withFileTypes:true});}
  catch(error){
    if(error.code==="ENOENT") return Object.freeze({records:[],files:[],duplicates:[],errors:[]});
    throw error;
  }
  const files=entries.filter(e=>e.isFile()&&e.name.endsWith(".json")).map(e=>path.join(dir,e.name)).sort();
  const records=[];
  const duplicates=[];
  const errors=[];
  const seen=new Set();
  for(const file of files){
    let parsed;
    try{parsed=JSON.parse(await readFile(file,"utf8"));}
    catch(error){
      errors.push({file,message:`invalid JSON: ${error.message}`});
      continue;
    }
    const items=Array.isArray(parsed)?parsed:[parsed];
    for(const item of items){
      if(!item||typeof item!=="object"||Array.isArray(item)){
        errors.push({file,message:"entry is not an evidence record object"});
        continue;
      }
      const id=item.id;
      if(typeof id==="string"&&id.length>0){
        if(seen.has(id)) duplicates.push({id,file});
        seen.add(id);
      }
      records.push({...item,sourceFile:file});
    }
  }
  return Object.freeze({records,files,duplicates,errors});
}

export function buildReport(loaded){
  const {records,duplicates,errors,files}=loaded;
  const base=validateCertificationEvidence(records);
  const invalidDetail=records
    .filter(r=>!validateEvidenceRecord(r).valid)
    .map(r=>({id:r.id??null,file:r.sourceFile,missing:validateEvidenceRecord(r).missing,invalidResult:validateEvidenceRecord(r).invalidResult}));
  const failed=records.filter(r=>r.result==="FAIL").map(r=>({id:r.id,file:r.sourceFile,detail:r.failureReason??null}));
  const blocked=records.filter(r=>r.result==="BLOCKED").map(r=>({id:r.id,file:r.sourceFile,reason:r.blockedReason??null}));
  const unsupported=records
    .map(r=>({id:r.id??null,file:r.sourceFile,...validateEvidenceRequirement(r)}))
    .filter(item=>!item.valid);
  const certified=base.certified&&duplicates.length===0&&errors.length===0&&unsupported.length===0;
  return Object.freeze({
    certified,
    recordCount:records.length,
    fileCount:files.length,
    required:REQUIRED_EVIDENCE,
    missing:base.missing,
    invalid:base.invalid,
    invalidDetail,
    unsupported:unsupported.map(item=>item.id),
    unsupportedDetail:unsupported,
    failed:base.failed,
    failedDetail:failed,
    blocked:base.blocked,
    blockedDetail:blocked,
    duplicates,
    errors,
  });
}

export function formatReport(report){
  const lines=[];
  lines.push(report.certified?"EVIDENCE PACK: CERTIFIED":"EVIDENCE PACK: NOT CERTIFIED");
  lines.push(`records: ${report.recordCount} from ${report.fileCount} file(s); required: ${report.required.length}`);
  if(report.missing.length) lines.push(`missing: ${report.missing.join(", ")}`);
  if(report.invalid.length){
    for(const item of report.invalidDetail){
      const why=[];
      if(item.missing.length) why.push(`fields: ${item.missing.join("/")}`);
      if(item.invalidResult) why.push("result not PASS/FAIL/BLOCKED/NOT_RUN");
      lines.push(`invalid: ${item.id??"(no id)"} [${item.file}] ${why.join("; ")}`);
    }
  }
  for(const item of report.unsupportedDetail) lines.push(`unsupported: ${item.id??"(no id)"} [${item.file}] ${item.reasons.join("; ")}`);
  for(const item of report.failedDetail) lines.push(`failed: ${item.id}${item.detail?` - ${item.detail}`:""}`);
  for(const item of report.blockedDetail) lines.push(`blocked: ${item.id}${item.reason?` - ${item.reason}`:""}`);
  for(const item of report.duplicates) lines.push(`duplicate id: ${item.id} [${item.file}]`);
  for(const item of report.errors) lines.push(`unreadable: ${item.file} - ${item.message}`);
  if(!report.certified) lines.push("V1 is NOT certified; real-money trading stays blocked.");
  return lines.join("\n");
}

async function main(argv){
  let opts;
  try{opts=parseArgs(argv);}
  catch(error){
    process.stderr.write(`${error.message}\nusage: npm run evidence:validate -- [--dir <path>] [--json] [--allow-incomplete]\n`);
    return EXIT_ERROR;
  }
  if(opts.help){
    process.stdout.write("usage: npm run evidence:validate -- [--dir <path>] [--json] [--allow-incomplete]\n\n"+
      "Validates the external-evidence pack against the V1 certification schema.\n"+
      "Exits 0 only when every required record is present, valid and PASS.\n"+
      "--allow-incomplete reports status but always exits 0 (read-only informational run).\n");
    return EXIT_CERTIFIED;
  }
  let loaded;
  try{loaded=await loadEvidence(opts.dir);}
  catch(error){
    process.stderr.write(`cannot read evidence directory ${opts.dir}: ${error.message}\n`);
    return EXIT_ERROR;
  }
  const report=buildReport(loaded);
  process.stdout.write(`${opts.json?JSON.stringify(report,null,2):formatReport(report)}\n`);
  if(report.errors.length) return EXIT_ERROR;
  if(opts.allowIncomplete) return EXIT_CERTIFIED;
  return report.certified?EXIT_CERTIFIED:EXIT_NOT_CERTIFIED;
}

const invokedDirectly=process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname);
if(invokedDirectly){
  main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{
    process.stderr.write(`${error.stack??error.message}\n`);
    process.exitCode=EXIT_ERROR;
  });
}
