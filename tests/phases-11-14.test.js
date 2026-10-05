import test from "node:test";
import assert from "node:assert/strict";
import {
  phase11ProductionGate, phase12ControlledLiveGate, phase13AdvancedAiGate,
  phase14ScaleGate, productionThroughPhase14,
} from "../src/operations/phase-11-14.js";

test("phase 11 fails closed without external evidence", () => {
  const result = phase11ProductionGate({});
  assert.equal(result.ready, false);
  assert.equal(result.liveMoneyBlocked, true);
  assert.ok(result.missing.length > 0);
});

test("phase 12 requires testnet, reconciliation, rollback and human approval", () => {
  const blocked = phase12ControlledLiveGate({ phase11Certified: true, limitedLiveCap: 1 });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.liveMoneyBlocked, true);
  const ready = phase12ControlledLiveGate({
    phase11Certified: true, testnetEvidence: true, limitedLiveCap: 1,
    reconciliation: true, rollback: true, humanApproval: true,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.liveMoneyBlocked, false);
});

test("phase 13 keeps deterministic Risk Gate immutable", () => {
  const result = phase13AdvancedAiGate({
    calibration: true, challenger: true, revalidation: true,
    driftControls: true, riskGateImmutable: true,
  });
  assert.equal(result.ready, true);
  assert.equal(result.riskGateImmutable, true);
});

test("phase 14 fails closed until scale evidence exists", () => {
  assert.equal(phase14ScaleGate({}).ready, false);
});

test("all phases require evidence before declaring complete", () => {
  const result = productionThroughPhase14({});
  assert.equal(result.complete, false);
  assert.equal(result.liveMoneyBlocked, true);
});
