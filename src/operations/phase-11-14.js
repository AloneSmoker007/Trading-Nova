const REQUIRED_EXTERNAL = Object.freeze([
  "postgres",
  "backupRestore",
  "marketDataProduction",
  "venueConformance",
  "paperShadowEvidence",
  "observability",
  "humanApproval",
]);

export function phase11ProductionGate(evidence = {}) {
  const missing = REQUIRED_EXTERNAL.filter((key) => !evidence[key]);
  return { phase: 11, ready: missing.length === 0, missing, liveMoneyBlocked: true };
}

export function phase12ControlledLiveGate({
  phase11Certified = false, testnetEvidence = false, limitedLiveCap = 0,
  reconciliation = false, rollback = false, humanApproval = false,
} = {}) {
  const ready = Boolean(phase11Certified && testnetEvidence && limitedLiveCap > 0 &&
    reconciliation && rollback && humanApproval);
  return { phase: 12, ready, liveMoneyBlocked: !ready, requiresHumanApproval: true, limitedLiveCap };
}

export function phase13AdvancedAiGate({
  calibration = false, challenger = false, revalidation = false,
  driftControls = false, riskGateImmutable = true,
} = {}) {
  const ready = Boolean(calibration && challenger && revalidation && driftControls && riskGateImmutable);
  return { phase: 13, ready, riskGateImmutable: true, liveMoneyBlocked: !ready };
}

export function phase14ScaleGate({
  highAvailability = false, disasterRecovery = false, capacityEvidence = false,
  securityAudit = false, observability = false,
} = {}) {
  const ready = Boolean(highAvailability && disasterRecovery && capacityEvidence &&
    securityAudit && observability);
  return { phase: 14, ready, liveMoneyBlocked: !ready };
}

export function productionThroughPhase14(evidence = {}) {
  const p11 = phase11ProductionGate(evidence.phase11);
  const p12 = phase12ControlledLiveGate(evidence.phase12);
  const p13 = phase13AdvancedAiGate(evidence.phase13);
  const p14 = phase14ScaleGate(evidence.phase14);
  return {
    phases: { 11: p11, 12: p12, 13: p13, 14: p14 },
    complete: p11.ready && p12.ready && p13.ready && p14.ready,
    liveMoneyBlocked: !p12.ready,
  };
}
