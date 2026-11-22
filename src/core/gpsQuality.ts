// GPS sampling quality: accuracy, continuity and altitude sanity from recorded fixes.
const GAP_MS = 60_000;
const ALT_JUMP_M = 50;
const ALT_JUMP_WINDOW_MS = 120_000;

export function assessGpsQuality(points, { poorAcc = 50 } = {}) {
  let accSum = 0, accN = 0, poorFixes = 0;
  let timedPairs = 0, gaps = 0, gapMs = 0, maxGapMs = 0;
  let altJumps = 0;
  let prev = null;
  for (const p of points || []) {
    const acc = Number(p?.acc);
    if (isFinite(acc) && acc > 0) {
      accSum += acc;
      accN++;
      if (acc > poorAcc) poorFixes++;
    }
    if (prev && p?.t != null && prev.t != null) {
      timedPairs++;
      const dt = p.t - prev.t;
      if (dt > GAP_MS) {
        gaps++;
        gapMs += dt;
        if (dt > maxGapMs) maxGapMs = dt;
      }
      if (dt > 0 && dt <= ALT_JUMP_WINDOW_MS && p.alt != null && prev.alt != null
        && isFinite(p.alt) && isFinite(prev.alt) && Math.abs(p.alt - prev.alt) > ALT_JUMP_M) {
        altJumps++;
      }
    }
    prev = p;
  }
  const fixes = points?.length || 0;
  const avgAcc = accN ? accSum / accN : null;
  const poorRatio = accN ? poorFixes / accN : null;
  const hasTime = timedPairs > 0;
  if (avgAcc == null && !hasTime) {
    return { fixes, avgAcc: null, poorFixes, poorRatio: null, gaps: 0, gapMs: 0, maxGapMs: 0, altJumps: 0, hasTime: false, score: null };
  }
  let penalty = 0;
  if (avgAcc != null) {
    penalty += Math.min(45, Math.max(0, (avgAcc - 5) * 2));
    penalty += (poorRatio || 0) * 25;
  }
  if (hasTime) penalty += Math.min(30, gaps * 6);
  penalty += Math.min(10, altJumps * 2);
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  return {
    fixes, avgAcc, poorFixes, poorRatio,
    gaps, gapMs, maxGapMs, altJumps, hasTime, score,
    rating: score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'fair' : 'poor'
  };
}
