const UNCERTAINTY_LEVELS = Object.freeze(["Low", "Medium", "High"]);

// Fail-closed opportunity builder (L8): every input is strictly validated —
// unvalidated garbage (string scores, unknown uncertainty labels, negative
// sample sizes) can never coerce its way into an ENTER decision.
export function buildOpportunity({symbol,side,score,evidence,sampleSize=0,calibratedProbability=null}={}){
  if(!symbol||!["LONG","SHORT"].includes(side))throw new Error("invalid opportunity");
  if(!Number.isFinite(score)||score<0||score>100)throw new Error("invalid opportunity score");
  if(!Number.isInteger(sampleSize)||sampleSize<0)throw new Error("invalid opportunity sample size");
  if(calibratedProbability!==null&&(!Number.isFinite(calibratedProbability)||calibratedProbability<0||calibratedProbability>1))throw new Error("invalid calibrated probability");
  if(evidence!==undefined&&evidence!==null){
    if(typeof evidence!=="object")throw new Error("invalid opportunity evidence");
    if(evidence.uncertainty!==undefined&&evidence.uncertainty!==null&&!UNCERTAINTY_LEVELS.includes(evidence.uncertainty))throw new Error("invalid opportunity uncertainty");
    if(evidence.conflicts!==undefined&&!Array.isArray(evidence.conflicts))throw new Error("invalid opportunity conflicts");
  }
  // Missing or unknown uncertainty is treated as High: only an explicitly
  // allowlisted, non-High label can unlock ENTER.
  const uncertainty=UNCERTAINTY_LEVELS.includes(evidence?.uncertainty)?evidence.uncertainty:"High";
  const p=sampleSize>=200&&Number.isFinite(calibratedProbability)?calibratedProbability:null;
  return{
    symbol,
    side,
    opportunityScore:score,
    calibratedProbability:p,
    sampleSize,
    uncertainty,
    conflicts:Array.isArray(evidence?.conflicts)?evidence.conflicts:[],
    decision:score>=75&&uncertainty!=="High"?"ENTER":"WAIT"
  };
}
