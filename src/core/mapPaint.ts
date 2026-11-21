// Native-resolution map painter shared by poster & track video.
// Tiles are fetched at a zoom where they map 1:1 (or downscale) into the target
// canvas — never upscaled from a screen snapshot, so output stays crisp.
import { get } from './settings';
import { isOfflineSim, isCorsFailSim } from './region';
import { availableBasemaps, defaultBasemapId, expandTiles } from './providers';
import { toDisplay } from './coords';
import { canvasPalette } from './palette';

const TILE = 256;
const MAX_LAT = 85.05112878;
const tileCache = new Map(); // url -> Promise<HTMLImageElement|null>

const ux = (lon) => (lon + 180) / 360;
const uy = (lat) => {
  const s = Math.sin((Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

export function pickProvider(basemapId) {
  const list = availableBasemaps();
  return list.find((b) => b.id === basemapId) || list.find((b) => b.id === defaultBasemapId()) || list[0] || null;
}

/** Web-Mercator fit of display-space points into w×h with padding. Zoom is
 *  floored so one tile pixel <= one canvas pixel (downscale only). */
export function mercatorFit(points, w, h, pad = 90, maxZoom = 18) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of points) {
    const x = ux(p.lon), y = uy(p.lat);
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  if (!isFinite(minx)) return null;
  const spanX = Math.max(maxx - minx, 1e-9);
  const spanY = Math.max(maxy - miny, 1e-9);
  const zx = Math.log2((w - pad * 2) / spanX / TILE);
  const zy = Math.log2((h - pad * 2) / spanY / TILE);
  const z = Math.max(1, Math.min(maxZoom, Math.floor(Math.min(zx, zy))));
  const world = TILE * 2 ** z;
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  return {
    z, world, cx, cy, w, h,
    toPx: (p) => [(ux(p.lon) - cx) * world + w / 2, (uy(p.lat) - cy) * world + h / 2]
  };
}

function loadTile(url) {
  if (tileCache.has(url)) return tileCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const to = setTimeout(() => { img.src = ''; resolve(null); }, 8000);
    img.onload = () => { clearTimeout(to); resolve(img); };
    img.onerror = () => { clearTimeout(to); resolve(null); };
    img.src = url;
  });
  tileCache.set(url, p);
  if (tileCache.size > 800) tileCache.delete(tileCache.keys().next().value);
  return p;
}

function fillUrl(tpl, z, x, y) {
  return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

export function paintVectorBackground(ctx, w, h) {
  const P = canvasPalette();
  ctx.fillStyle = P.vectorBg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
}

/**
 * Prepare a basemap background at native resolution plus a display-space track.
 * @returns {Promise<{bg:HTMLCanvasElement, fit, segments, waypoints, vector:boolean, label:string}>}
 */
export async function prepareMap({
  w, h, pad = 90, segments, waypoints = [], basemapId = '', vectorOnly = false, onProgress
}) {
  const offline = vectorOnly || isOfflineSim() || isCorsFailSim();
  const provider = offline ? null : pickProvider(basemapId);
  const cs = provider?.coordSystem || 'WGS84';
  const conv = (p) => {
    const [lon, lat] = toDisplay(p.lon, p.lat, cs);
    return lon === p.lon && lat === p.lat ? p : { ...p, lon, lat };
  };
  const dispSegs = cs === 'GCJ02' ? segments.map((s) => ({ ...s, points: s.points.map(conv) })) : segments;
  const dispWps = cs === 'GCJ02' ? waypoints.map(conv) : waypoints;
  const all = dispSegs.flatMap((s) => s.points);
  const fit = mercatorFit(all, w, h, pad, provider?.maxzoom ?? 18);

  const bg = document.createElement('canvas');
  bg.width = w; bg.height = h;
  const ctx = bg.getContext('2d');
  const label = provider?.id || 'vector';

  if (!provider || !fit) {
    paintVectorBackground(ctx, w, h);
    return { bg, fit, segments: dispSegs, waypoints: dispWps, vector: true, label: 'vector' };
  }

  const key = provider.requiresKey ? get(provider.requiresKey) : '';
  const baseUrls = expandTiles(provider, key);
  const overlayUrls = provider.overlay ? expandTiles({ tiles: provider.overlay, subdomains: provider.subdomains }, key) : null;
  const n = 2 ** fit.z;
  const ox = fit.cx * fit.world - w / 2;
  const oy = fit.cy * fit.world - h / 2;
  const x0 = Math.floor(ox / TILE), x1 = Math.floor((ox + w) / TILE);
  const y0 = Math.max(0, Math.floor(oy / TILE)), y1 = Math.min(n - 1, Math.floor((oy + h) / TILE));

  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % n) + n) % n;
      const px = tx * TILE - ox, py = ty * TILE - oy;
      jobs.push({ url: fillUrl(baseUrls[(wx + ty) % baseUrls.length], fit.z, wx, ty), px, py, layer: 0 });
      if (overlayUrls) jobs.push({ url: fillUrl(overlayUrls[(wx + ty) % overlayUrls.length], fit.z, wx, ty), px, py, layer: 1 });
    }
  }

  let done = 0, failed = false;
  const queue = [...jobs];
  const worker = async () => {
    while (queue.length && !failed) {
      const j = queue.shift();
      j.img = await loadTile(j.url);
      if (!j.img) { failed = true; break; }
      done++;
      onProgress?.(done / jobs.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  if (failed) {
    paintVectorBackground(ctx, w, h);
    return { bg, fit, segments: dispSegs, waypoints: dispWps, vector: true, label: 'vector' };
  }
  ctx.fillStyle = canvasPalette().panel;
  ctx.fillRect(0, 0, w, h);
  for (const layer of [0, 1]) {
    for (const j of jobs) if (j.layer === layer) ctx.drawImage(j.img, j.px, j.py);
  }
  return { bg, fit, segments: dispSegs, waypoints: dispWps, vector: false, label };
}

// Along-path gradient (teal → sky → indigo) with layered soft glow and a
// centre highlight — the neon-tube look used by modern recap renderers.
const STOPS = [[43, 205, 167], [56, 189, 248], [129, 140, 248]];
function lut(t, stops = STOPS) {
  const s = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(s));
  const f = s - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * Draw the track over a prepared map. `upto` limits rendering to the first N
 * points (video playback); the head point gets the amber marker.
 */
export function paintTrack(ctx, fit, segments, waypoints, {
  upto = Infinity, lineWidth = 8.5, dotRadius = 13, wpRadius = 6
} = {}) {
  if (!fit) return;
  const P = canvasPalette();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, fit.w, fit.h);
  ctx.clip();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const total = segments.reduce((a, s) => a + s.points.length, 0);
  const limit = Math.min(upto, total);
  const polys = [];
  let count = 0, first = null, head = null;
  for (const seg of segments) {
    const pts = [];
    for (const p of seg.points) {
      if (count >= limit) break;
      pts.push(p);
      count++;
    }
    if (pts.length) {
      polys.push(pts);
      if (!first) first = pts[0];
      head = pts[pts.length - 1];
    }
  }
  const chunk = Math.max(2, Math.ceil(count / 18));
  // Dark halo + casing keep the gradient readable on pale street maps; the
  // thin highlight prevents the line from looking flat on dark basemaps.
  const passes = [
    { w: lineWidth * 2.1, a: 0.20, color: P.trackHalo },
    { w: lineWidth + 4.5, a: 0.95, color: P.trackCasing },
    { w: lineWidth, a: 1 },
    { w: Math.max(1.4, lineWidth * 0.24), a: 0.34, color: 'rgba(255,255,255,0.9)' }
  ];
  for (const pass of passes) {
    ctx.globalAlpha = pass.a;
    ctx.lineWidth = pass.w;
    let gi = 0;
    for (const pts of polys) {
      for (let s = 0; s < pts.length - 1; s += chunk - 1) {
        const e = Math.min(pts.length, s + chunk);
        ctx.strokeStyle = pass.color || lut((gi + s + (e - s) / 2) / Math.max(1, count), P.lut);
        ctx.beginPath();
        for (let i = s; i < e; i++) {
          const [x, y] = fit.toPx(pts[i]);
          i === s ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      gi += pts.length;
    }
  }
  ctx.globalAlpha = 1;

  for (const wp of waypoints.slice(0, 40)) {
    const [x, y] = fit.toPx(wp);
    ctx.fillStyle = P.text;
    ctx.beginPath(); ctx.arc(x, y, wpRadius, 0, 7); ctx.fill();
    ctx.strokeStyle = P.wpRing;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, wpRadius + 1.5, 0, 7); ctx.stroke();
  }
  const ring = (p, fill) => {
    const [x, y] = fit.toPx(p);
    ctx.fillStyle = P.trackCasing;
    ctx.beginPath(); ctx.arc(x, y, dotRadius + 4, 0, 7); ctx.fill();
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.arc(x, y, dotRadius, 0, 7); ctx.fill();
    ctx.strokeStyle = P.endRing;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, dotRadius + 2.5, 0, 7); ctx.stroke();
  };
  if (first) ring(first, P.accent);
  if (head && head !== first) ring(head, P.amber);
  ctx.restore();
}