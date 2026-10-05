export function createCircuitBreaker({maxFailures=3,cooldownMs=30000}={}) {
  let failures=0, openedAt=0;
  return {
    recordFailure(){ failures++; if(failures>=maxFailures) openedAt=Date.now(); },
    recordSuccess(){ failures=0; openedAt=0; },
    isOpen(now=Date.now()){ return openedAt>0 && now-openedAt<cooldownMs; },
    snapshot(){ return {failures,openedAt}; }
  };
}