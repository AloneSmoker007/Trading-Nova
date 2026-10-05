const REQUIRED=["orderSubmit","orderStatus","cancelOrder","fills","userDataStream"];
export function conformanceReport(adapter){const missing=REQUIRED.filter(k=>typeof adapter?.[k]!=="function");return Object.freeze({passed:missing.length===0,missing,liveEligible:missing.length===0});}
export function assertVenueConformance(report){if(!report?.passed)throw new Error("venue conformance incomplete");return true;}
