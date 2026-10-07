// WS-B: medium-severity fixes — external-evidence trust fail-closed (M2),
// calibration row validation without NaN (M3), stream supervisor resync after
// GAP (M6) and shadow-runner empty-evidence policy (M8).
import test from "node:test";
import assert from "node:assert/strict";
import {normalizeExternalEvidence, externalEvidenceAllowed} from "../src/intelligence/alternative-data.js";
import {brierScore, calibrationBins, calibrationReport} from "../src/intelligence/calibration.js";
import {MarketStreamSupervisor} from "../src/market-data/stream.js";
import {runShadow} from "../src/shadow/runner.js";

test("WS-B M2: external evidence trust fails closed when trust is absent", () => {
  const noTrust = normalizeExternalEvidence({source: "news", type: "sentiment", value: 0.8, timestamp: 1000, now: 2000, maxAgeMs: 2000});
  assert.equal(noTrust.trust, 0);
  assert.equal(externalEvidenceAllowed(noTrust), false);

  const trusted = normalizeExternalEvidence({source: "news", type: "sentiment", value: 0.8, timestamp: 1000, now: 2000, maxAgeMs: 2000, trust: 0.9});
  assert.equal(externalEvidenceAllowed(trusted), true);
  assert.equal(externalEvidenceAllowed({...trusted, trust: undefined}), false);
  assert.equal(externalEvidenceAllowed({...trusted, trust: "0.9"}), false); // no string coercion
  assert.equal(externalEvidenceAllowed({...trusted, fresh: false}), false); // stale is never allowed

  assert.throws(() => normalizeExternalEvidence({source: "n", type: "t", value: 1, timestamp: 0, trust: 1.5}), /invalid external evidence/);
  assert.throws(() => normalizeExternalEvidence({source: "n", type: "t", value: 1, timestamp: 0, trust: NaN}), /invalid external evidence/);
  assert.throws(() => normalizeExternalEvidence({source: "n", type: "t", value: 1, timestamp: 0, trust: "0.9"}), /invalid external evidence/);
});

test("WS-B M3: calibration never returns NaN and rejects out-of-range rows", () => {
  assert.equal(brierScore([{probability: "x", outcome: 1}]), null);
  assert.ok(!Number.isNaN(brierScore([{probability: "x", outcome: 1}])));
  assert.equal(brierScore([{probability: 2, outcome: 5}]), null); // probability>1 / outcome>1 rejected
  assert.ok(Math.abs(brierScore([{probability: 0.8, outcome: 1}, {probability: "oops", outcome: 0}]) - 0.04) < 1e-12); // invalid row dropped
  assert.equal(brierScore([]), null);

  const rep = calibrationReport([{probability: 0.8, outcome: 1}, {probability: 2, outcome: 5}, {probability: null, outcome: 0}]);
  assert.equal(rep.rows, 3);
  assert.equal(rep.validRows, 1);
  assert.equal(rep.invalidRows, 2);
  assert.ok(Math.abs(rep.brier - 0.04) < 1e-12);

  const bins = calibrationBins([{probability: 0.8, outcome: 1}, {probability: 2, outcome: 5}, {probability: "", outcome: 0}], 10);
  assert.equal(bins[8].subset, 1); // only the valid row lands in a bin
  assert.equal(bins[0].subset, 0);
  assert.equal(bins[0].predicted, null);
});

test("WS-B M6: stream supervisor has a resync path after GAP", async () => {
  const handlers = [];
  const s = new MarketStreamSupervisor({connect: async (h) => { handlers.push(h); }, now: () => 1000, maxAgeMs: 100});
  await s.start();
  assert.deepEqual(s.accept({sequence: 1}), {accepted: true});
  assert.deepEqual(s.accept({sequence: 3}), {accepted: false, reason: "SEQUENCE_GAP"});
  assert.equal(s.state, "GAP");
  assert.equal(s.canTrade(), false);
  // a late replay of the missing sequence must NOT silently heal the gap
  assert.deepEqual(s.accept({sequence: 2}), {accepted: false, reason: "RESYNC_REQUIRED"});

  // explicit resync re-subscribes under a new session with a fresh baseline
  const stale = handlers[0];
  await s.resync();
  assert.equal(handlers.length, 2);
  assert.deepEqual(s.accept({sequence: 100}), {accepted: true});
  assert.equal(s.canTrade(), true);
  // events captured by the old subscription are rejected
  assert.deepEqual(stale.onEvent({sequence: 2}), {accepted: false, reason: "STALE_SESSION"});
});

test("WS-B M6: GAP fires the onGap hook so hosts can trigger the resync", async () => {
  const gaps = [];
  const s = new MarketStreamSupervisor({connect: async () => {}, now: () => 0, onGap: (g) => gaps.push(g)});
  await s.start();
  s.accept({sequence: 0});
  s.accept({sequence: 5});
  assert.deepEqual(gaps, [{expected: 1, received: 5}]);
});

test("WS-B M8: shadow tradeAllowed fails closed on empty evidence", () => {
  assert.equal(runShadow({signals: []}).tradeAllowed, false);
  assert.equal(runShadow({}).tradeAllowed, false);
  assert.equal(runShadow({signals: [{id: "1", decision: "WAIT"}]}).tradeAllowed, false);
  assert.equal(runShadow({signals: [{id: "1", decision: "ENTER"}], observations: [{id: "1", reconciled: false}]}).tradeAllowed, false);
  assert.equal(runShadow({signals: [{id: "1", decision: "ENTER"}], observations: [{id: "1", reconciled: true}]}).tradeAllowed, true);
});
