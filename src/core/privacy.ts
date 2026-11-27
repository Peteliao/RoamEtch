// Privacy sanitization (non-destructive, applied at preview/export time):
// start/end privacy circles, sensitive waypoint hiding. EXIF already stripped at import.
import { haversine } from './geo';

export type PrivacyOptions = {
  radius?: number;
  hideSensitive?: boolean;
  start?: any;
  end?: any;
};

/**
 * @param {{trip, segments, waypoints}} full
 * @param {PrivacyOptions} opts
 * @returns {{segments, waypoints, croppedPoints, croppedWaypoints}}
 */
export function applyPrivacy(full, { radius = 300, hideSensitive = true, start: anchorStart, end: anchorEnd }: PrivacyOptions = {}) {
  if (!full.segments.some((segment) => segment.points.length)) {
    return { segments: [], waypoints: hideSensitive ? full.waypoints.filter((w) => !w.hidden) : full.waypoints, croppedPoints: 0, croppedWaypoints: 0 };
  }
  let start = anchorStart;
  let end = anchorEnd;
  if (radius > 0 && (!start || !end)) {
    for (const segment of full.segments) {
      if (!segment.points.length) continue;
      start ||= segment.points[0];
      end = segment.points[segment.points.length - 1];
    }
  }
  if (!start && radius > 0) {
    return { segments: [], waypoints: hideSensitive ? full.waypoints.filter((w) => !w.hidden) : full.waypoints, croppedPoints: 0, croppedWaypoints: 0 };
  }
  const inCircle = (lat, lon) =>
    (radius > 0 && haversine(lat, lon, start.lat, start.lon) <= radius) ||
    (radius > 0 && haversine(lat, lon, end.lat, end.lon) <= radius);

  let croppedPoints = 0;
  const segments = [];
  if (radius > 0) {
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
  } else {
    segments.push(...full.segments.filter((segment) => segment.points.length >= 2));
  }

  let croppedWaypoints = 0;
  const waypoints = full.waypoints.filter((w) => {
    if (hideSensitive && w.hidden) { croppedWaypoints++; return false; }
    if (inCircle(w.lat, w.lon)) { croppedWaypoints++; return false; }
    return true;
  });

  return { segments, waypoints, croppedPoints, croppedWaypoints };
}