import { bearing, haversine, physicsFor } from './geo';
import { createJumpGate } from './trackFilter';

const GAP_MS = 60_000;
const ALT_JUMP_M = 50;
const ALT_JUMP_WINDOW_MS = 120_000;
const REVERSAL_DEG = 150;
const CLEAN_HISTORY_MS = 120_000;

export function assessGpsQuality(points, { poorAcc = 50, activity = 'hike' } = {}) {
  let accSum = 0, accN = 0, poorFixes = 0;
  let timedPairs = 0, gaps = 0, gapMs = 0, maxGapMs = 0;
  let altJumps = 0, reversals = 0;
  let prev = null, prevPrev = null;
  const minRevDist = physicsFor(activity).minRevDist;
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
      if (prevPrev && prevPrev.t != null) {
        const firstDt = prev.t - prevPrev.t;
        const firstDist = haversine(prevPrev.lat, prevPrev.lon, prev.lat, prev.lon);
        const secondDist = haversine(prev.lat, prev.lon, p.lat, p.lon);
        if (firstDt > 0 && firstDt <= GAP_MS && dt > 0 && dt <= GAP_MS
          && firstDist >= minRevDist && secondDist >= minRevDist) {
          const turn = Math.abs(((bearing(prevPrev.lat, prevPrev.lon, prev.lat, prev.lon)
            - bearing(prev.lat, prev.lon, p.lat, p.lon) + 540) % 360) - 180);
          if (turn > REVERSAL_DEG) reversals++;
        }
      }
    }
    prevPrev = prev;
    prev = p;
  }
  const fixes = points?.length || 0;
  const avgAcc = accN ? accSum / accN : null;
  const poorRatio = accN ? poorFixes / accN : null;
  const hasTime = timedPairs > 0;
  if (avgAcc == null && !hasTime) {
    return { fixes, avgAcc: null, poorFixes, poorRatio: null, gaps: 0, gapMs: 0, maxGapMs: 0, altJumps: 0, reversals: 0, hasTime: false, score: null };
  }
  let penalty = 0;
  if (avgAcc != null) {
    penalty += Math.min(45, Math.max(0, (avgAcc - 5) * 2));
    penalty += (poorRatio || 0) * 25;
  }
  if (hasTime) penalty += Math.min(30, gaps * 6);
  penalty += Math.min(10, altJumps * 2);
  penalty += Math.min(35, reversals * 4);
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  return {
    fixes, avgAcc, poorFixes, poorRatio,
    gaps, gapMs, maxGapMs, altJumps, reversals, hasTime, score,
    rating: score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'fair' : 'poor'
  };
}

export function cleanTrackSegments(segments, activity = 'hike', { confirmPoints = 4 } = {}) {
  const gate = createJumpGate({ confirmPoints });
  const cleaned = (segments || []).map((seg) => ({ ...seg, points: [] }));
  const source = new Map();
  let anchor = null;
  let history = [];
  let total = 0;

  const flushPending = () => {
    for (const point of gate.pendingPoints()) cleaned[source.get(point)].points.push(point);
    gate.reset();
  };

  for (let si = 0; si < (segments || []).length; si++) {
    gate.reset();
    let boundary = si > 0;
    for (const point of segments[si].points || []) {
      total++;
      source.set(point, si);
      const validCoords = isFinite(point.lat) && isFinite(point.lon) && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
      if (!validCoords) {
        flushPending();
        history = [];
        anchor = null;
        cleaned[si].points.push(point);
        continue;
      }
      const validTime = Number.isFinite(point.t) && (!anchor || point.t > anchor.t);
      if (boundary) {
        cleaned[si].points.push(point);
        anchor = point;
        history = validTime
          ? [...history, point].filter((p) => anchor.t - p.t <= CLEAN_HISTORY_MS).slice(-400)
          : [point];
        boundary = false;
        continue;
      }
      if (!validTime || (anchor && point.t - anchor.t > GAP_MS)) {
        flushPending();
        history = [];
        anchor = null;
        cleaned[si].points.push(point);
        continue;
      }
      const decision = gate.evaluate({ fix: point, anchor, history, activity });
      if (decision.action === 'pending') continue;
      for (const accepted of decision.points) cleaned[source.get(accepted)].points.push(accepted);
      anchor = decision.points[decision.points.length - 1];
      history = [...history, ...decision.points]
        .filter((p) => anchor.t - p.t <= CLEAN_HISTORY_MS)
        .slice(-400);
    }
    flushPending();
  }

  const kept = cleaned.reduce((sum, seg) => sum + seg.points.length, 0);
  return { segments: cleaned, removed: total - kept };
}
