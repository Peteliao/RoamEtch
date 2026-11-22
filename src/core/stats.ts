// Pure trip statistics. Shared by the Web Worker and main-thread fallback.
import { haversine, emaSeries, ascentDescent, slopeAt } from './geo';
import { estimateCalories } from './calories';

const MOVING_SPEED = 0.5;   // m/s
const MAX_DT = 60_000;      // cap per-step time contribution (gap protection)

/**
 * @param {Array<{points: Array}>} segments
 * @param {{ascentThreshold?: number}} opts
 */
export function computeStats(segments, opts: any = {}) {
  const threshold = opts.ascentThreshold ?? 4;
  const all = [];
  const segStats = [];
  let distance = 0, activeMs = 0, movingMs = 0, maxSpeed = 0;
  let maxAlt = null, minAlt = null;
  let accSum = 0, accN = 0;
  let minT = null, maxT = null;
  const dSeries = [], altSeries = [], speedSeries = [], slopeSeries = [], tSeries = [];
  let cumD = 0;

  segments.forEach((seg, si) => {
    const pts = seg.points || [];
    let segDist = 0, segActiveMs = 0, segMinT = null, segMaxT = null;
    const segAlts = [];
    let prev = null;
    pts.forEach((p, i) => {
      all.push(p);
      if (Number.isFinite(p.t)) {
        if (minT == null || p.t < minT) minT = p.t;
        if (maxT == null || p.t > maxT) maxT = p.t;
        if (segMinT == null || p.t < segMinT) segMinT = p.t;
        if (segMaxT == null || p.t > segMaxT) segMaxT = p.t;
      }
      let stepD = 0, speed = null;
      if (prev) {
        stepD = haversine(prev.lat, prev.lon, p.lat, p.lon);
        const dt = Number.isFinite(p.t) && Number.isFinite(prev.t) ? p.t - prev.t : 0;
        if (dt > 0 && dt <= MAX_DT) {
          speed = stepD / (dt / 1000);
          activeMs += dt;
          segActiveMs += dt;
          if (speed > MOVING_SPEED) movingMs += dt;
        } else if (p.speed != null) {
          speed = p.speed;
        }
      }
      if (p.speed != null && isFinite(p.speed)) speed = speed == null ? p.speed : Math.max(speed, 0);
      if (speed != null && speed > maxSpeed && speed < 80) maxSpeed = speed;
      segDist += stepD;
      cumD += stepD;
      if (p.acc != null && isFinite(p.acc) && p.acc > 0) { accSum += p.acc; accN++; }
      if (p.alt != null && isFinite(p.alt)) {
        segAlts.push(p.alt);
        if (maxAlt == null || p.alt > maxAlt) maxAlt = p.alt;
        if (minAlt == null || p.alt < minAlt) minAlt = p.alt;
      }
      dSeries.push(cumD);
      altSeries.push(p.alt ?? null);
      speedSeries.push(speed);
      tSeries.push(p.t ?? null);
      prev = p;
    });
    distance += segDist;
    const sm = emaSeries(segAlts, 0.35);
    const { ascent, descent } = ascentDescent(sm, threshold);
    segStats.push({
      index: si, id: seg.id, distance: segDist, ascent, descent,
      duration: segMinT != null && segMaxT != null ? segMaxT - segMinT : 0,
      activeMs: segActiveMs,
      pointCount: pts.length
    });
    // slope series (per segment window)
    pts.forEach((p, i) => slopeSeries.push(slopeAt(pts, i)));
  });

  const smoothAlt = emaSeries(altSeries, 0.35);
  const { ascent, descent } = ascentDescent(smoothAlt, threshold);
  const smoothSpeed = emaSeries(speedSeries, 0.3);
  const duration = minT != null && maxT != null ? maxT - minT : 0;
  const stillMs = Math.max(0, activeMs - movingMs);
  const breakMs = Math.max(0, duration - activeMs);
  const hasTime = tSeries.some((t) => t != null);
  const avgSpeed = movingMs > 0 ? distance / (movingMs / 1000) : 0;
  const calories = estimateCalories(opts.activity, movingMs, avgSpeed, opts.weightKg);

  return {
    distance, duration, activeMs, movingMs, stillMs, breakMs, avgSpeed, maxSpeed, calories,
    avgPace: avgSpeed > 0.3 ? 1000 / avgSpeed : null,
    ascent, descent, maxAlt, minAlt,
    avgAcc: accN ? accSum / accN : null,
    pointCount: all.length, segCount: segments.length, hasTime,
    segments: segStats,
    series: { d: dSeries, alt: smoothAlt, rawAlt: altSeries, speed: smoothSpeed, slope: slopeSeries, t: tSeries }
  };
}