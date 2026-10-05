export function classifyRegime({trend,volatility,volume}) {
  if (![trend,volatility,volume].every(Number.isFinite)) return "UNKNOWN";
  if (volatility>=0.7) return trend>=0.5?"HIGH_VOL_UP":"HIGH_VOL_DOWN";
  if (Math.abs(trend)<0.2 && volume<0.5) return "LOW_ACTIVITY_RANGE";
  return trend>=0.5?"UPTREND":trend<=-0.5?"DOWNTREND":"RANGE";
}