// Geodesy & track math. All inputs WGS-84 degrees, distances metres, time ms epoch.

const R = 6371008.8; // mean earth radius (m)
const rad = (d) => (d * Math.PI) / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
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