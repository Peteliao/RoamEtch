// Pure trip statistics. Shared by the Web Worker and main-thread fallback.
import { slopeAt, measureTrackStep, physicsFor, SPEED_TOLERANCE, usableTrackPoints } from './geo';
import { estimateCalories } from './calories';

const MOVING_SPEED = 0.5;   // m/s
const MAX_DT = 60_000;      // cap per-step time contribution (gap protection)

/**
 * @param {Array<{points: Array}>} segments
 * @param {{ascentThreshold?: number}} opts
 */
export function computeStats(segments, opts: any = {}) {
  const threshold = opts.ascentThreshold ?? 4;
  const activity = opts.activity || 'hike';
  const speedLimit = physicsFor(activity).vmax * SPEED_TOLERANCE;
  const includeSeries = opts.series !== false;
  const segStats = [];
  let distance = 0, activeMs = 0, movingMs = 0, maxSpeed = 0;
  let maxAlt = null, minAlt = null;
  let accSum = 0, accN = 0;
  let minT = null, maxT = null;
  let pointCount = 0, hasTime = false;
  let smoothAlt = null, altRef = null, ascent = 0, descent = 0;
  let smoothSpeed = null;
  const dSeries = [], altSeries = [], rawAltSeries = [], speedSeries = [], slopeSeries = [], tSeries = [];
  let cumD = 0;

  segments.forEach((seg, si) => {
    const pts = usableTrackPoints(seg.points || []);
    let segDist = 0, segActiveMs = 0, segMinT = null, segMaxT = null;
    let segSmoothAlt = null, segAltRef = null, segAscent = 0, segDescent = 0;
    let prev = null;
    pts.forEach((p, i) => {
      pointCount++;
      if (Number.isFinite(p.t)) {
        hasTime = true;
        if (minT == null || p.t < minT) minT = p.t;
        if (maxT == null || p.t > maxT) maxT = p.t;
        if (segMinT == null || p.t < segMinT) segMinT = p.t;
        if (segMaxT == null || p.t > segMaxT) segMaxT = p.t;
      }
      let stepD = 0, speed = null;
      const step = prev ? measureTrackStep(prev, p, activity) : null;
      if (step) {
        stepD = step.dist;
        if (step.dt > 0 && step.dt <= MAX_DT) {
          activeMs += step.dt;
          segActiveMs += step.dt;
          if (step.valid && step.implied > MOVING_SPEED) movingMs += step.dt;
        }
      }
      const reported = p.speed != null && isFinite(p.speed) && p.speed >= 0 && p.speed <= speedLimit ? p.speed : null;
      if (step?.valid === false) speed = null;
      else speed = step?.implied ?? reported;
      if (speed != null && speed > maxSpeed && speed <= speedLimit) maxSpeed = speed;
      segDist += stepD;
      cumD += stepD;
      if (p.acc != null && isFinite(p.acc) && p.acc > 0) { accSum += p.acc; accN++; }
      if (p.alt != null && isFinite(p.alt)) {
        smoothAlt = smoothAlt == null ? p.alt : 0.35 * p.alt + 0.65 * smoothAlt;
        segSmoothAlt = segSmoothAlt == null ? p.alt : 0.35 * p.alt + 0.65 * segSmoothAlt;
        if (altRef == null) altRef = smoothAlt;
        else {
          const d = smoothAlt - altRef;
          if (d >= threshold) { ascent += d; altRef = smoothAlt; }
          else if (d <= -threshold) { descent += -d; altRef = smoothAlt; }
        }
        if (segAltRef == null) segAltRef = segSmoothAlt;
        else {
          const d = segSmoothAlt - segAltRef;
          if (d >= threshold) { segAscent += d; segAltRef = segSmoothAlt; }
          else if (d <= -threshold) { segDescent += -d; segAltRef = segSmoothAlt; }
        }
        if (maxAlt == null || p.alt > maxAlt) maxAlt = p.alt;
        if (minAlt == null || p.alt < minAlt) minAlt = p.alt;
      }
      if (speed != null) smoothSpeed = smoothSpeed == null ? speed : 0.3 * speed + 0.7 * smoothSpeed;
      if (includeSeries) {
        dSeries.push(cumD);
        altSeries.push(p.alt != null && isFinite(p.alt) ? smoothAlt : null);
        rawAltSeries.push(p.alt ?? null);
        speedSeries.push(speed != null ? smoothSpeed : null);
        tSeries.push(p.t ?? null);
      }
      prev = p;
    });
    distance += segDist;
    segStats.push({
      index: si, id: seg.id, distance: segDist, ascent: segAscent, descent: segDescent,
      duration: segMinT != null && segMaxT != null ? segMaxT - segMinT : 0,
      activeMs: segActiveMs,
      pointCount: pts.length
    });
    if (includeSeries) pts.forEach((p, i) => slopeSeries.push(slopeAt(pts, i)));
  });

  const duration = minT != null && maxT != null ? maxT - minT : 0;
  const stillMs = Math.max(0, activeMs - movingMs);
  const breakMs = Math.max(0, duration - activeMs);
  const avgSpeed = movingMs > 0 ? distance / (movingMs / 1000) : 0;
  const calories = estimateCalories(opts.activity, movingMs, avgSpeed, opts.weightKg);

  return {
    distance, duration, activeMs, movingMs, stillMs, breakMs, avgSpeed, maxSpeed, calories,
    avgPace: avgSpeed > 0.3 ? 1000 / avgSpeed : null,
    ascent, descent, maxAlt, minAlt,
    avgAcc: accN ? accSum / accN : null,
    pointCount, segCount: segments.length, hasTime,
    segments: segStats,
    series: includeSeries ? { d: dSeries, alt: altSeries, rawAlt: rawAltSeries, speed: speedSeries, slope: slopeSeries, t: tSeries } : undefined
  };
}
