// Geodesy & track math. All inputs WGS-84 degrees, distances metres, time ms epoch.

const R = 6371008.8; // mean earth radius (m)
const rad = (d) => (d * Math.PI) / 180;

export const SPEED_TOLERANCE = 1.3;
export const MISSING_KINEMATICS_TOLERANCE = 1.15;

export const ACTIVITY_PHYSICS = {
  hike:   { vmax: 4.5, cruiseMin: 1.2, maxAccel: 3.0, minRevDist: 20 },
  run:    { vmax: 8.5, cruiseMin: 2.2, maxAccel: 4.5, minRevDist: 25 },
  bike:   { vmax: 20,  cruiseMin: 3.5, maxAccel: 6.0, minRevDist: 30 },
  drive:  { vmax: 45,  cruiseMin: 5.0, maxAccel: 9.0, minRevDist: 40 },
  travel: { vmax: 98,  cruiseMin: 6.0, maxAccel: 6.0, minRevDist: 50 },
  auto:   { vmax: 25,  cruiseMin: 2.0, maxAccel: 7.0, minRevDist: 30 }
} as const;

export function physicsFor(activity) {
  return ACTIVITY_PHYSICS[activity] || ACTIVITY_PHYSICS.hike;
}

export function usableTrackPoints<T extends { lat: number; lon: number; t?: number | null; [key: string]: any }>(points: readonly T[] = []): T[] {
  const usable: T[] = [];
  let lastT: number | null = null;
  for (const point of Array.isArray(points) ? points : []) {
    if (!point || !Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90
      || !Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) continue;
    const t = Number.isFinite(point.t) ? point.t as number : null;
    if (t != null) {
      if (lastT != null && t <= lastT) continue;
      lastT = t;
    }
    usable.push(point);
  }
  return usable;
}

export function measureTrackStep(prev, point, activity = 'hike') {
  const dist = haversine(prev.lat, prev.lon, point.lat, point.lon);
  const dt = Number(point.t) - Number(prev.t);
  const implied = dt > 0 ? dist / (dt / 1000) : null;
  const prevAcc = Number(prev.acc);
  const pointAcc = Number(point.acc);
  const avgAcc = ((isFinite(prevAcc) && prevAcc > 0 ? prevAcc : 15) + (isFinite(pointAcc) && pointAcc > 0 ? pointAcc : 15)) / 2;
  const jumpFloor = Math.max(10, avgAcc * 1.2);
  const tolerance = point.speed == null && point.heading == null ? MISSING_KINEMATICS_TOLERANCE : SPEED_TOLERANCE;
  const valid = !(implied != null && implied > physicsFor(activity).vmax * tolerance && dist > jumpFloor);
  return { dist: valid ? dist : 0, rawDist: dist, dt, implied, valid };
}

export function trackDistance(segments, activity = 'hike') {
  let total = 0;
  for (const seg of segments || []) {
    const points = usableTrackPoints(seg.points || []);
    for (let i = 1; i < points.length; i++) total += measureTrackStep(points[i - 1], points[i], activity).dist;
  }
  return total;
}

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Interpolate along the shorter longitude arc, including tracks crossing the dateline. */
export function interpolateLongitude(from: number, to: number, fraction: number) {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const delta = ((to - from + 180) % 360 + 360) % 360 - 180;
  const lon = from + delta * f;
  return lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon;
}

export type Wgs84Bounds = [number, number, number, number];

function wrapLongitude(lon: number) {
  return lon - Math.floor((lon + 180) / 360) * 360;
}

export function mergeWgs84Bounds(
  bounds: readonly (readonly [number, number, number, number] | null | undefined)[]
): Wgs84Bounds | null {
  const valid: Wgs84Bounds[] = [];
  for (const bbox of bounds) {
    if (!bbox || bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) continue;
    if (Math.abs(bbox[1]) > 90 || Math.abs(bbox[3]) > 90) continue;
    valid.push([bbox[0], bbox[1], bbox[2], bbox[3]]);
  }
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];
  const intervals = valid.map(([rawWest, south, rawEast, north]) => {
    const start = wrapLongitude(rawWest);
    const directWidth = rawEast - start;
    const width = rawWest === -180 && rawEast === 180
      ? 360
      : directWidth >= 0 && directWidth <= 360
        ? directWidth
        : ((directWidth % 360) + 360) % 360;
    return { start, end: start + width, south, north };
  });

  let best: { min: number; max: number; south: number; north: number } | null = null;
  const cuts = intervals.flatMap(({ start, end }) => [wrapLongitude(start), wrapLongitude(end)]);
  for (const cut of cuts) {
    let min = Infinity, max = -Infinity, south = Infinity, north = -Infinity;
    for (const interval of intervals) {
      const start = interval.start + Math.round((cut - interval.start) / 360) * 360;
      const end = start + (interval.end - interval.start);
      min = Math.min(min, start);
      max = Math.max(max, end);
      south = Math.min(south, interval.south);
      north = Math.max(north, interval.north);
    }
    if (!best || max - min < best.max - best.min) best = { min, max, south, north };
  }
  if (best.max - best.min >= 360 - 1e-9) return [-180, best.south, 180, best.north];
  return [wrapLongitude(best.min), best.south, wrapLongitude(best.max), best.north];
}

export function wgs84TrackBounds(
  segments: readonly { points?: readonly { lat: number; lon: number }[] }[]
): Wgs84Bounds | null {
  const bounds: Wgs84Bounds[] = [];
  for (const segment of segments) {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    let minUnwrapped = Infinity, maxUnwrapped = -Infinity, previousLon: number | null = null;
    let minLon = 0, maxLon = 0;
    for (const point of segment?.points || []) {
      if (!point || !Number.isFinite(point.lat) || Math.abs(point.lat) > 90
        || !Number.isFinite(point.lon) || Math.abs(point.lon) > 180) continue;
      const lon = previousLon == null ? point.lon : previousLon + wrapLongitude(point.lon - previousLon);
      previousLon = lon;
      west = Math.min(west, point.lon);
      east = Math.max(east, point.lon);
      south = Math.min(south, point.lat);
      north = Math.max(north, point.lat);
      minUnwrapped = Math.min(minUnwrapped, lon);
      maxUnwrapped = Math.max(maxUnwrapped, lon);
      if (lon <= minUnwrapped) minLon = point.lon;
      if (lon >= maxUnwrapped) maxLon = point.lon;
    }
    if (previousLon == null) continue;
    bounds.push(maxUnwrapped - minUnwrapped <= 180 && east - west > 180
      ? [minLon, south, maxLon, north]
      : [west, south, east, north]);
  }
  return mergeWgs84Bounds(bounds);
}

export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Douglas-Peucker simplification on [{lat,lon,...}], tolerance in metres (approx via degree scaling). */
export function simplify(points, toleranceM = 5) {
  if (points.length < 3) return points.slice();
  const lat0 = points[0].lat;
  const mPerDegLat = 111132;
  const mPerDegLon = 111320 * Math.cos(rad(lat0));
  const tolLat = toleranceM / mPerDegLat;
  const tolLon = toleranceM / mPerDegLon;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const ax = points[s].lon * mPerDegLon, ay = points[s].lat * mPerDegLat;
    const bx = points[e].lon * mPerDegLon, by = points[e].lat * mPerDegLat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const px = points[i].lon * mPerDegLon, py = points[i].lat * mPerDegLat;
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > toleranceM && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  void tolLat; void tolLon;
  return points.filter((_, i) => keep[i]);
}

export function sampleTrackSegments<T extends { points: any[] }>(segments: readonly T[], maxPoints = 4000): T[] {
  const list = Array.isArray(segments) ? segments : [];
  const lengths = list.map((segment) => segment.points?.length || 0);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const limit = Math.max(2, Math.floor(maxPoints));
  if (total <= limit) return [...list];
  const active = list.map((_, index) => index).filter((index) => lengths[index] > 0);
  const maxSegments = Math.max(1, Math.floor(limit / 2));
  const selected = new Set(active.length > maxSegments
    ? Array.from({ length: maxSegments }, (_, index) => active[maxSegments === 1 ? 0 : Math.round(index * (active.length - 1) / (maxSegments - 1))])
    : active);
  const selectedTotal = [...selected].reduce((sum, index) => sum + lengths[index], 0);
  const counts = new Map<number, number>();
  for (const index of selected) counts.set(index, Math.max(2, Math.floor(limit * lengths[index] / selectedTotal)));
  let allocated = [...counts.values()].reduce((sum, count) => sum + count, 0);
  while (allocated > limit) {
    let candidate = -1;
    for (const [index, count] of counts) {
      if (count > 2 && (candidate < 0 || count > counts.get(candidate)!)) candidate = index;
    }
    if (candidate < 0) break;
    counts.set(candidate, counts.get(candidate)! - 1);
    allocated--;
  }
  while (allocated < limit) {
    let candidate = -1;
    for (const [index, count] of counts) {
      if (candidate < 0 || lengths[index] / count > lengths[candidate] / counts.get(candidate)!) candidate = index;
    }
    counts.set(candidate, counts.get(candidate)! + 1);
    allocated++;
  }
  return list.map((segment, index) => {
    const count = counts.get(index) || 0;
    if (!count) return { ...segment, points: [] };
    if (count >= lengths[index]) return { ...segment, points: segment.points.slice() };
    const points = [];
    const step = (lengths[index] - 1) / (count - 1);
    for (let sample = 0; sample < count; sample++) points.push(segment.points[Math.round(sample * step)]);
    return { ...segment, points };
  });
}

/** EMA smoothing of a numeric series (null-aware). */
export function emaSeries(values, alpha = 0.3) {
  const out = [];
  let prev = null;
  for (const v of values) {
    if (v == null || !isFinite(v)) { out.push(null); continue; }
    prev = prev == null ? v : alpha * v + (1 - alpha) * prev;
    out.push(prev);
  }
  return out;
}

/**
 * Cumulative ascent/descent with hysteresis: only count a change once the
 * smoothed altitude has moved >= threshold from the last counted reference.
 */
export function ascentDescent(altitudes, threshold = 4) {
  let asc = 0, desc = 0;
  let ref = null;
  for (const a of altitudes) {
    if (a == null || !isFinite(a)) continue;
    if (ref == null) { ref = a; continue; }
    const d = a - ref;
    if (d >= threshold) { asc += d; ref = a; }
    else if (d <= -threshold) { desc += -d; ref = a; }
  }
  return { ascent: asc, descent: desc };
}

/** Sliding-window slope (%) between points: window of ~30 m horizontal distance. */
export function slopeAt(points, i, windowM = 30) {
  if (i <= 0 || i >= points.length) return null;
  const p = points[i];
  if (p.alt == null) return null;
  let j = i - 1, dist = 0;
  while (j > 0 && dist < windowM) {
    dist += haversine(points[j].lat, points[j].lon, points[j + 1].lat, points[j + 1].lon);
    j--;
  }
  const q = points[j];
  if (q.alt == null || dist < 5) return null;
  return ((p.alt - q.alt) / dist) * 100;
}

export function fmtDuration(ms, { compact = false } = {}) {
  if (ms == null || !isFinite(ms) || ms < 0) return '--';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (compact) return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(sec).padStart(2, '0')}s`;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function fmtDistance(m, units = 'metric'): any {
  if (m == null || !isFinite(m)) return '--';
  if (units === 'imperial') {
    const mi = m / 1609.344;
    return mi >= 0.1 ? { v: mi.toFixed(2), u: 'mi' } : { v: Math.round(m * 3.28084).toString(), u: 'ft' };
  }
  return m >= 1000 ? { v: (m / 1000).toFixed(2), u: 'km' } : { v: Math.round(m).toString(), u: 'm' };
}

export function fmtSpeed(ms, units = 'metric') {
  if (ms == null || !isFinite(ms) || ms < 0) return { v: '--', u: units === 'imperial' ? 'mph' : 'km/h' };
  return units === 'imperial' ? { v: (ms * 2.23694).toFixed(1), u: 'mph' } : { v: (ms * 3.6).toFixed(1), u: 'km/h' };
}

export function fmtPace(ms, units = 'metric') {
  if (ms == null || !isFinite(ms) || ms < 0.3) return { v: '--', u: units === 'imperial' ? '/mi' : '/km' };
  const secPerKm = 1000 / ms;
  const secPerUnit = units === 'imperial' ? secPerKm * 1.609344 : secPerKm;
  const m = Math.floor(secPerUnit / 60), s = Math.round(secPerUnit % 60);
  return { v: `${m}'${String(s).padStart(2, '0')}"`, u: units === 'imperial' ? '/mi' : '/km' };
}

export function fmtAltitude(m, units = 'metric') {
  if (m == null || !isFinite(m)) return { v: '--', u: units === 'imperial' ? 'ft' : 'm' };
  return units === 'imperial' ? { v: Math.round(m * 3.28084).toString(), u: 'ft' } : { v: Math.round(m).toString(), u: 'm' };
}

/** GPS fix quality from reported horizontal accuracy (metres) → 1..4 bars, 0 unknown. */
export function signalLevel(acc) {
  if (acc == null || !isFinite(acc) || acc <= 0) return 0;
  if (acc <= 8) return 4;
  if (acc <= 15) return 3;
  if (acc <= 30) return 2;
  return 1;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxx-xxxx-4xxx-yxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }) + '-' + Date.now().toString(36);
}