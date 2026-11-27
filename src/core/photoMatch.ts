// Batch photo association: EXIF time + GPS against the recorded track.
// Pure helpers only; the UI preview decides whether a candidate is accepted.
import { haversine } from './geo';

const TIME_EDGE_MS = 15 * 60 * 1000;
const GPS_MATCH_M = 500;
const NODE_LINK_M = 120;
const NODE_LINK_MS = 3 * 60 * 1000;

export type PhotoMeta = {
  time?: number | null;
  lat?: number | null;
  lon?: number | null;
};

export type PhotoCandidate = {
  time: number;
  lat: number;
  lon: number;
  distanceAlong: number;
  trackDistance: number;
  basis: 'gps+time' | 'time' | 'gps';
  confidence: 'high' | 'medium' | 'low';
  waypointId: string | null;
  waypointName: string;
};

function validPoint(p: any) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t);
}

export function flattenTrack(segments: any[]) {
  const pts: any[] = [];
  const cum: number[] = [];
  let total = 0;
  for (const segment of segments || []) {
    let prev: any = null;
    for (const p of segment?.points || []) {
      if (!validPoint(p)) continue;
      if (prev) total += haversine(prev.lat, prev.lon, p.lat, p.lon);
      pts.push(p);
      cum.push(total);
      prev = p;
    }
  }
  return { pts, cum, start: pts[0]?.t ?? null, end: pts.at(-1)?.t ?? null };
}

function nearestByTime(pts, time) {
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(pts[lo - 1].t - time) <= Math.abs(pts[lo].t - time)) lo--;
  return lo;
}

function nearestByPosition(pts, lat, lon) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = haversine(lat, lon, pts[i].lat, pts[i].lon);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, distance: bestD };
}

function nearestNode(waypoints, time, lat, lon) {
  let best: any = null;
  let bestScore = Infinity;
  for (const w of waypoints || []) {
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lon)) continue;
    const d = haversine(lat, lon, w.lat, w.lon);
    const dt = w.time != null ? Math.abs(w.time - time) : Infinity;
    if (d > NODE_LINK_M && dt > NODE_LINK_MS) continue;
    const score = Math.min(1, d / NODE_LINK_M) + (Number.isFinite(dt) ? Math.min(1, dt / NODE_LINK_MS) : 0);
    if (score < bestScore) { bestScore = score; best = w; }
  }
  return best;
}

export function matchPhotoToTrip(meta: PhotoMeta, segments: any[], waypoints: any[] = []): PhotoCandidate | null {
  const { pts, cum, start, end } = flattenTrack(segments);
  if (!pts.length) return null;
  const time = Number.isFinite(meta.time) ? Number(meta.time) : null;
  const hasGps = Number.isFinite(meta.lat) && Number.isFinite(meta.lon);
  if (time == null && !hasGps) return null;

  let trackIndex = -1;
  let trackDistance = 0;
  let basis: PhotoCandidate['basis'];
  let strongTime = false;
  let strongGps = false;

  if (hasGps) {
    const pos = nearestByPosition(pts, Number(meta.lat), Number(meta.lon));
    if (pos.index >= 0 && pos.distance <= GPS_MATCH_M) {
      trackIndex = pos.index;
      trackDistance = pos.distance;
      strongGps = true;
    }
  }
  const timeInRange = time != null && start != null && end != null && time >= start - TIME_EDGE_MS && time <= end + TIME_EDGE_MS;
  if (timeInRange) {
    const idx = nearestByTime(pts, time);
    const dt = Math.abs(pts[idx].t - time);
    if (dt <= TIME_EDGE_MS) {
      if (trackIndex < 0) trackIndex = idx;
      strongTime = true;
      if (hasGps && strongGps) {
        // Keep the GPS point when it agrees with the time-selected point.
        if (Math.abs(pts[idx].t - pts[trackIndex].t) > 30 * 60 * 1000) trackIndex = idx;
      }
    }
  }
  if (trackIndex < 0) return null;

  const point = pts[trackIndex];
  basis = strongGps && strongTime ? 'gps+time' : strongTime ? 'time' : 'gps';
  const useGpsPosition = hasGps && (strongGps || strongTime);
  const lat = useGpsPosition ? Number(meta.lat) : point.lat;
  const lon = useGpsPosition ? Number(meta.lon) : point.lon;
  const photoTime = timeInRange && strongTime ? time : point.t;
  const confidence = strongGps && strongTime
    ? (trackDistance <= 100 && Math.abs(point.t - time) <= 10 * 60 * 1000 ? 'high' : 'medium')
    : strongGps || strongTime ? 'medium' : 'low';
  const node = nearestNode(waypoints, photoTime, lat, lon);
  return {
    time: photoTime,
    lat,
    lon,
    distanceAlong: cum[trackIndex],
    trackDistance,
    basis,
    confidence,
    waypointId: node?.id || null,
    waypointName: node?.name || ''
  };
}

export function candidateConfidenceLabel(candidate: PhotoCandidate) {
  return candidate.confidence;
}
