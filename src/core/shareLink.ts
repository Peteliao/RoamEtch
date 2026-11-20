// Lightweight share links: simplified polyline + text nodes in URL fragment.
// Fragment never hits a server. Size-capped for QR compatibility (<= 1.5 KB).
import { deflateSync, inflateSync } from 'fflate';
import { simplify } from './geo';
import { applyPrivacy } from './privacy';

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

export function buildShareLink(full, privacy) {
  const cropped = applyPrivacy(full, privacy);
  const pts = simplify(cropped.segments.flatMap((s) => s.points), 20).slice(0, 260);
  if (pts.length < 2) throw new Error('no track');
  const payload = {
    v: 1,
    n: (full.trip.name || '').slice(0, 40),
    a: full.trip.activity,
    p: encPolyline(pts),
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
    if (payload.v !== 1 || !payload.p) return null;
    return {
      name: payload.n || 'Shared trip',
      activity: payload.a || 'travel',
      points: decPolyline(payload.p),
      waypoints: (payload.w || []).map((w) => ({ name: w.n, type: w.t, lat: w.la, lon: w.lo }))
    };
  } catch {
    return null;
  }
}