const TIERS = Object.freeze(["research", "validated", "paper", "shadow", "limited-live", "live"]);

export function createPromotionCertificate({
  from, to, validationEvidence, independentSafety, rollbackTest,
  venueConformance = false, humanApproval
}) {
  const fromIndex = TIERS.indexOf(from);
  const toIndex = TIERS.indexOf(to);
  const sequential = fromIndex >= 0 && toIndex === fromIndex + 1;
  const liveTier = to === "limited-live" || to === "live";
  const approved = typeof humanApproval === "string" && humanApproval.trim().length > 0;
  const eligible = sequential && validationEvidence === true && independentSafety === true &&
    rollbackTest === true && (!liveTier || venueConformance === true) && approved;

  return Object.freeze({
    version: 1, from, to, eligible,
    requirements: Object.freeze({
      sequential, validationEvidence: validationEvidence === true,
      independentSafety: independentSafety === true, rollbackTest: rollbackTest === true,
      venueConformance: liveTier ? venueConformance === true : true, humanApproval: approved
    }),
    humanApproval: approved ? humanApproval.trim() : null
  });
}

export function requirePromotionCertificate(certificate) {
  if (!certificate?.eligible) {
    const error = new Error("PROMOTION_NOT_CERTIFIED");
    error.code = "PROMOTION_NOT_CERTIFIED";
    throw error;
  }
  return certificate;
}
