export function finalCertification({
  productionReady, backupVerified, marketProbePassed, venueConformance,
  observabilityPassed, paperShadowEvidence, humanApproval
}) {
  const human = typeof humanApproval === "string" && humanApproval.trim().length > 0;
  const checks = {
    productionReady: productionReady === true,
    backupVerified: backupVerified === true,
    marketProbePassed: marketProbePassed === true,
    venueConformance: venueConformance === true,
    observabilityPassed: observabilityPassed === true,
    paperShadowEvidence: paperShadowEvidence === true,
    humanApproval: human
  };
  const certified = Object.values(checks).every(Boolean);
  return Object.freeze({ certified, checks: Object.freeze(checks), tier: certified ? "eligible-for-human-controlled-promotion" : "NOT_CERTIFIED" });
}
