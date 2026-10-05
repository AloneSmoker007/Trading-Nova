# V1 Capability & Research Traceability

**Status:** Initial traceability framework. This document does not claim that the historical ~1,900+ raw research items have been recovered verbatim.

## Classification

Each requirement/capability must eventually receive exactly one status:

- **Covered** — implementation and meaningful test/evidence exist.
- **Partial** — implementation exists but an acceptance/evidence gap remains.
- **Missing** — required implementation is absent.
- **Evidence Missing** — code/gate exists, but real operational evidence is absent.
- **N/A** — explicitly not applicable, with rationale.

## Consolidated capability inventory

Trading Nova currently tracks **103 consolidated capabilities**. The authoritative source is `docs/TRADING-NOVA-MASTER-ROADMAP.md`.

The final 13 reconciled capabilities are:

| # | Capability | Initial status |
|---|---|---|
| 91 | Model/Strategy Promotion Certificate | Covered / Evidence Missing |
| 92 | Defense-in-Depth Safety Controls | Covered / Evidence Missing |
| 93 | Control Calibration & Effectiveness Monitor | Partial |
| 94 | Control Conformance / Venue-Behavior Test Harness | Covered / Evidence Missing |
| 95 | Material-Change Impact Gate | Covered |
| 96 | Ongoing Validation & Revalidation Scheduler | Covered / Evidence Missing |
| 97 | Algorithm Registry + Authorized Operator Matrix | Covered |
| 98 | Third-Party / Outsourcing Control & Exit | Partial |
| 99 | Common-Mode / Correlated AI Failure Testing | Covered |
| 100 | AI Input Representativeness & Coverage Gate | Covered |
| 101 | Separation of Duties / Independent Challenge | Covered / Evidence Missing |
| 102 | Full Automated-Activity Reconstruction | Partial |
| 103 | Capacity & Peak-Stress Admission Gate | Covered / Evidence Missing |

## 1,900+ raw research requirements

The historical raw list is the source that must be mapped into the 103 capabilities. The repository currently records the aggregate count and consolidated inventory, not the verbatim historical 1,900+ rows.

Until that source is recovered or reattached, **do not invent row-level mappings** and **do not mark the raw-requirement traceability as complete**.

## Minimum traceability row

`Raw ID | Domain | Requirement | Consolidated capability | Status | Evidence | Test/Artifact | Owner | Notes`

## Gate

The Master List is complete only when:
1. all 103 consolidated capabilities are accounted for;
2. all available raw research rows are mapped without silent deletion;
3. duplicates are explicitly marked as duplicates;
4. non-applicable rows have a rationale;
5. every implementation claim has code/test evidence;
6. every operational claim has a real artifact;
7. unresolved critical/high gaps are visible.

**Important:** production readiness and profitability are separate claims. Traceability cannot be used as a substitute for live operational certification.