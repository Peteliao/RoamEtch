// Lightweight share links: simplified polyline + text nodes in URL fragment.
// Fragment never hits a server. Size-capped for QR compatibility (<= 1.5 KB).
import { deflateSync, inflateSync } from 'fflate';
import { simplify, measureTrackStep, trackDistance } from './geo';
import { applyPrivacy } from './privacy';
import { sha256Hex, stableStringify } from './integrity';

const LIMIT = 1500;

function encPolyline(points) {
  let lastLat = 0, lastLng = 0, out = '';
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5), lng = Math.round(p.lon * 1e5);
    out += enc(lat - lastLat) + enc(lng - lastLng);
    lastLat = lat; lastLng = lng;
  }
  return out;
}
function decPolyline(str) {
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  const dec = () => {
    let r = 0, s = 0, b;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < str.length) {
    lat += dec(); lng += dec();
    pts.push({ lat: lat / 1e5, lon: lng / 1e5 });
  }
  return pts;
}

function b64urlEncode(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function buildTracks(segments, activity) {
  const tracks = [];
  for (const seg of segments) {
    let run = [];
    for (const point of seg.points || []) {
      if (run.length && !measureTrackStep(run[run.length - 1], point, activity).valid) {
        if (run.length >= 2) tracks.push(run);
        run = [point];
      } else {
        run.push(point);
      }
    }
    if (run.length >= 2) tracks.push(run);
  }
  return tracks;
}

function sampleForPreview(points, limit) {
  if (points.length <= limit) return points;
  const sampled = [points[0]];
  const step = (points.length - 1) / (limit - 1);
  for (let i = 1; i < limit - 1; i++) sampled.push(points[Math.round(i * step)]);
  sampled.push(points[points.length - 1]);
  return sampled;
}

function capTracks(tracks) {
  const maxPoints = Math.max(260, tracks.length * 2);
  const previewLimit = Math.max(256, Math.min(8192, maxPoints * 16));
  const bounded = tracks.map((points) => sampleForPreview(points, previewLimit));
  let tolerance = 20;
  let simplified = bounded.map((points) => simplify(points, tolerance));
  while (simplified.flat().length > maxPoints && tolerance < 1280) {
    tolerance *= 2;
    simplified = bounded.map((points) => simplify(points, tolerance));
  }
  if (simplified.flat().length <= maxPoints) return simplified;
  const capped = [];
  let remaining = maxPoints;
  for (const points of simplified) {
    capped.push(points.length <= remaining ? points : [points[0], points[points.length - 1]]);
    remaining -= capped[capped.length - 1].length;
  }
  return capped;
}

export function buildShareLink(full, privacy) {
  const cropped = applyPrivacy(full, privacy);
  const activity = full.trip.activity || 'hike';
  const tracks = capTracks(buildTracks(cropped.segments, activity));
  const pts = tracks.flat();
  if (pts.length < 2) throw new Error('no track');
  const breaks = [];
  let offset = 0;
  for (const track of tracks) { breaks.push(offset); offset += track.length; }
  const payload = {
    v: 2,
    n: (full.trip.name || '').slice(0, 40),
    a: activity,
    p: encPolyline(pts),
    b: breaks,
    d: Math.round(trackDistance(cropped.segments, activity)),
    w: cropped.waypoints.slice(0, 8).map((w) => ({ n: (w.name || '').slice(0, 24), t: w.type, la: Math.round(w.lat * 1e5) / 1e5, lo: Math.round(w.lon * 1e5) / 1e5 }))
  };
  const json = JSON.stringify(payload);
  const compressed = deflateSync(new TextEncoder().encode(json), { level: 9 });
  const raw = b64urlEncode(new TextEncoder().encode(json));
  const enc = compressed.length + 4 < raw.length ? 'z' + b64urlEncode(compressed) : 'r' + raw;
  if (enc.length > LIMIT) {
    const err: any = new Error('too-big');
    err.size = enc.length;
    throw err;
  }
  const base = location.href.split('#')[0];
  return { url: `${base}#t=${enc}`, size: enc.length };
}

export function parseShareFragment(hash) {
  const m = /[#&]t=([A-Za-z0-9\-_]+)/.exec(hash || '');
  if (!m) return null;
  try {
    const body = m[1];
    const mode = body[0];
    const data = b64urlDecode(body.slice(1));
    const json = mode === 'z'
      ? new TextDecoder().decode(inflateSync(data))
      : new TextDecoder().decode(data);
    const payload = JSON.parse(json);
    if ((payload.v !== 1 && payload.v !== 2) || !payload.p) return null;
    const points = decPolyline(payload.p);
    let segments = [points];
    if (payload.v === 2) {
      if (!Array.isArray(payload.b) || payload.b[0] !== 0) return null;
      segments = [];
      let start = 0;
      for (const end of [...payload.b.slice(1), points.length]) {
        if (!Number.isInteger(end) || end <= start || end > points.length) return null;
        segments.push(points.slice(start, end));
        start = end;
      }
      if (start !== points.length) return null;
    }
    const activity = payload.a || 'travel';
    return {
      name: payload.n || 'Shared trip',
      activity,
      points,
      segments,
      distance: trackDistance(segments.map((points) => ({ points })), activity),
      reportedDistance: payload.v === 2 && isFinite(payload.d) ? payload.d : null,
      waypoints: (payload.w || []).map((w) => ({ name: w.n, type: w.t, lat: w.la, lon: w.lo }))
    };
  } catch {
    return null;
  }
}

/**
 * Stable identity for the content a shared-trip link will import. Equivalent
 * raw/compressed encodings share a fingerprint; malformed fragments do not.
 */
export async function shareFragmentFingerprint(hash) {
  const shared = parseShareFragment(hash);
  if (!shared) return null;
  const content = stableStringify({
    name: shared.name,
    activity: shared.activity,
    segments: shared.segments.map((points) => points.map((point) => [point.lat, point.lon])),
    waypoints: shared.waypoints.map((waypoint) => [waypoint.name, waypoint.type, waypoint.lat, waypoint.lon]),
    reportedDistance: shared.reportedDistance
  });
  try {
    return await sha256Hex(content);
  } catch {
    // Keep imports usable on hosts without Web Crypto. The canonical content is
    // collision-free and remains bounded by the share-fragment size cap.
    return `raw:${content}`;
  }
}