const ORDER=["research","validated","paper","shadow","limited-live","live"];
export function evaluatePromotion({from,to,certificate,validation,independentSafety,rollbackReady,operatorApproved}={}){
  const reasons=[];if(ORDER.indexOf(to)!==ORDER.indexOf(from)+1)reasons.push("INVALID_PROMOTION_STEP");
  if(!certificate||!validation)reasons.push("EVIDENCE_REQUIRED");if(independentSafety!==true)reasons.push("INDEPENDENT_SAFETY_REQUIRED");if(rollbackReady!==true)reasons.push("ROLLBACK_REQUIRED");if(operatorApproved!==true)reasons.push("HUMAN_APPROVAL_REQUIRED");
  if(["limited-live","live"].includes(to)&&validation?.venueConformance!==true)reasons.push("VENUE_CONFORMANCE_REQUIRED");
  return Object.freeze({allowed:reasons.length===0,reasons,from,to});
}
export function emergencyDisable(state={}){return Object.freeze({...state,liveEnabled:false,disabledAt:Date.now(),reason:"EMERGENCY_DISABLE"});}
