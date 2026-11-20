// Pure trip statistics. Shared by the Web Worker and main-thread fallback.
import { haversine, emaSeries, ascentDescent, slopeAt } from './geo.js';

const MOVING_SPEED = 0.5;   // m/s
const MAX_DT = 60_000;      // cap per-step time contribution (gap protection)

/**
 * @param {Array<{points: Array}>} segments
 * @param {{ascentThreshold?: number}} opts
 */
export function computeStats(segments, opts = {}) {
  const threshold = opts.ascentThreshold ?? 4;
  const all = [];
  const segStats = [];
  let distance = 0, movingMs = 0, maxSpeed = 0;
  let maxAlt = null, minAlt = null;
  let firstT = null, lastT = null;
  const dSeries = [], altSeries = [], speedSeries = [], slopeSeries = [], tSeries = [];
  let cumD = 0;

  segments.forEach((seg, si) => {
    const pts = seg.points || [];
    let segDist = 0, segAsc = 0;
    const segAlts = [];
    let prev = null;
    pts.forEach((p, i) => {
      all.push(p);
      if (firstT == null && p.t) firstT = p.t;
      if (p.t) lastT = p.t;
      let stepD = 0, speed = null;
      if (prev) {
        stepD = haversine(prev.lat, prev.lon, p.lat, p.lon);
        const dt = p.t && prev.t ? p.t - prev.t : 0;
        if (dt > 0 && dt <= MAX_DT) {
          speed = stepD / (dt / 1000);
          if (speed > MOVING_SPEED) movingMs += Math.min(dt, MAX_DT);
        } else if (p.speed != null) {
          speed = p.speed;
        }
      }
      if (p.speed != null && isFinite(p.speed)) speed = speed == null ? p.speed : Math.max(speed, 0);
      if (speed != null && speed > maxSpeed && speed < 80) maxSpeed = speed;
      segDist += stepD;
      cumD += stepD;
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
    segAsc = ascent;
    segStats.push({
      index: si, id: seg.id, distance: segDist, ascent, descent,
      duration: pts.length > 1 && pts[0].t && pts[pts.length - 1].t ? pts[pts.length - 1].t - pts[0].t : 0,
      pointCount: pts.length
    });
    // slope series (per segment window)
    pts.forEach((p, i) => slopeSeries.push(slopeAt(pts, i)));
    void segAsc;
  });

  const smoothAlt = emaSeries(altSeries, 0.35);
  const { ascent, descent } = ascentDescent(smoothAlt, threshold);
  const smoothSpeed = emaSeries(speedSeries, 0.3);
  const duration = firstT != null && lastT != null ? lastT - firstT : 0;
  const stillMs = Math.max(0, duration - movingMs);
  const hasTime = tSeries.some((t) => t != null);
  const avgSpeed = movingMs > 0 ? distance / (movingMs / 1000) : 0;

  return {
    distance, duration, movingMs, stillMs, avgSpeed, maxSpeed,
    avgPace: avgSpeed > 0.3 ? 1000 / avgSpeed : null,
    ascent, descent, maxAlt, minAlt,
    pointCount: all.length, segCount: segments.length, hasTime,
    segments: segStats,
    series: { d: dSeries, alt: smoothAlt, rawAlt: altSeries, speed: smoothSpeed, slope: slopeSeries, t: tSeries }
  };
}