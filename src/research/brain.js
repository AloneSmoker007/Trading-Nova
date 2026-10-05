import {evaluateEvidence,romanUrduExplanation} from "./council.js";
import {scoreOpportunity,calibratedProbability} from "../research/opportunity.js";
export function researchOpportunity({evidence,regime,sampleSize=0,calibration=null}={}){
  const council=evaluateEvidence(evidence);const features={technical:council.score,regime:regime?.score??50,evidence:council.score};
  const opportunity=scoreOpportunity(features);const probability=calibratedProbability({sampleSize,probability:calibration?.probability??null,minSamples:calibration?.minSamples??500});
  const decision=council.decision==="WAIT"?"WAIT":opportunity>=70?"RESEARCH":"NO_TRADE";
  return Object.freeze({opportunityScore:opportunity,probability,uncertainty:council.uncertainty,conflicts:council.conflicts,decision,explanation:romanUrduExplanation({decision,score:opportunity,uncertainty:council.uncertainty}),features});
}
export function counterEvidence(evidence=[]){return evidence.filter(x=>x&&x.direction==="against").map(x=>({source:x.source,reason:x.reason,score:x.score}));}
