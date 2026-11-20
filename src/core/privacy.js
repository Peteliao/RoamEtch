// Privacy sanitization (non-destructive, applied at preview/export time):
// start/end privacy circles, sensitive waypoint hiding. EXIF already stripped at import.
import { haversine } from './geo.js';

/**
 * @param {{trip, segments, waypoints}} full
 * @param {{radius:number, hideSensitive:boolean}} opts
 * @returns {{segments, waypoints, croppedPoints, croppedWaypoints}}
 */
export function applyPrivacy(full, { radius = 300, hideSensitive = true } = {}) {
  const allPts = full.segments.flatMap((s) => s.points);
  if (!allPts.length) {
    return { segments: [], waypoints: hideSensitive ? full.waypoints.filter((w) => !w.hidden) : full.waypoints, croppedPoints: 0, croppedWaypoints: 0 };
  }
  const start = allPts[0];
  const end = allPts[allPts.length - 1];
  const inCircle = (lat, lon) =>
    (radius > 0 && haversine(lat, lon, start.lat, start.lon) <= radius) ||
    (radius > 0 && haversine(lat, lon, end.lat, end.lon) <= radius);

  let croppedPoints = 0;
  const segments = [];
  for (const seg of full.segments) {
    let run = [];
    for (const p of seg.points) {
      if (inCircle(p.lat, p.lon)) {
        croppedPoints++;
        if (run.length >= 2) segments.push({ id: seg.id + '-p' + segments.length, points: run });
        run = [];
      } else {
        run.push(p);
      }
    }
    if (run.length >= 2) segments.push({ id: seg.id + '-p' + segments.length, points: run });
  }

  let croppedWaypoints = 0;
  const waypoints = full.waypoints.filter((w) => {
    if (hideSensitive && w.hidden) { croppedWaypoints++; return false; }
    if (inCircle(w.lat, w.lon)) { croppedWaypoints++; return false; }
    return true;
  });

  return { segments, waypoints, croppedPoints, croppedWaypoints };
}