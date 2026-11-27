// Native-resolution map painter shared by poster & track video.
// Tiles are fetched at a zoom where they map 1:1 (or downscale) into the target
// canvas — never upscaled from a screen snapshot, so output stays crisp.
import { get } from './settings';
import { isOfflineSim, isCorsFailSim } from './region';
import { availableBasemaps, defaultBasemapId, expandTiles } from './providers';
import { toDisplay } from './coords';
import { canvasPalette } from './palette';
import { effectiveTheme } from './theme';
import { paintThemeBackground, themeDefinition } from './themeRegistry';

const TILE = 256;
const MAX_LAT = 85.05112878;
const tileCache = new Map(); // url -> Promise<HTMLImageElement|null>
const mapCache = new Map();  // view key -> prepared raster background (LRU, 4)
const MAP_CACHE_MAX = 4;

function cacheGet(key) {
  const hit = mapCache.get(key);
  if (!hit) return null;
  mapCache.delete(key);
  mapCache.set(key, hit);
  return hit;
}

function cachePut(key, entry) {
  mapCache.set(key, entry);
  while (mapCache.size > MAP_CACHE_MAX) mapCache.delete(mapCache.keys().next().value);
}

function cachedMap(entry, fit, segments, waypoints) {
  return {
    bg: entry.bg, fit, segments, waypoints,
    vector: entry.vector, label: entry.label, darkBg: entry.darkBg
  };
}

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
  p.then((img) => {
    if (!img && tileCache.get(url) === p) tileCache.delete(url);
  });
  if (tileCache.size > 800) tileCache.delete(tileCache.keys().next().value);
  return p;
}

function fillUrl(tpl, z, x, y) {
  return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

export function paintVectorBackground(ctx, w, h) {
  paintThemeBackground(ctx, w, h, effectiveTheme());
}

/** Average perceived luminance of the finished basemap (0..1), null if unreadable. */
function bgLuminance(bg) {
  try {
    const sample = document.createElement('canvas');
    sample.width = 48; sample.height = 48;
    const sctx = sample.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(bg, 0, 0, 48, 48);
    const data = sctx.getImageData(0, 0, 48, 48).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    return sum / (data.length / 4) / 255;
  } catch {
    return null;
  }
}

function mapResult(bg, fit, segments, waypoints, vector, label) {
  const luma = bgLuminance(bg);
  return { bg, fit, segments, waypoints, vector, label, darkBg: luma != null && luma < 0.5 };
}

/**
 * Prepare a basemap background at native resolution plus a display-space track.
 * @returns {Promise<{bg:HTMLCanvasElement, fit, segments, waypoints, vector:boolean, label:string, darkBg:boolean}>}
 */
export async function prepareMap({
  w, h, pad = 90, segments, waypoints = [], basemapId = '', vectorOnly = false, maxZoom = Infinity, onProgress = undefined
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
  const fit = mercatorFit(all, w, h, pad, Math.min(maxZoom ?? Infinity, provider?.maxzoom ?? 18));

  const bg = document.createElement('canvas');
  bg.width = w; bg.height = h;
  const ctx = bg.getContext('2d');
  const label = provider?.id || 'vector';
  const P = canvasPalette();
  const vectorKey = `vector|${w}x${h}|${themeDefinition(effectiveTheme()).effect}|${P.vectorBg}|${P.grid}`;

  if (!provider || !fit) {
    const hit = cacheGet(vectorKey);
    if (hit) { onProgress?.(1); return cachedMap(hit, fit, dispSegs, dispWps); }
    paintVectorBackground(ctx, w, h);
    const result = mapResult(bg, fit, dispSegs, dispWps, true, 'vector');
    cachePut(vectorKey, result);
    return result;
  }

  const key = provider.requiresKey ? get(provider.requiresKey) : '';
  const baseUrls = expandTiles(provider, key);
  const overlayUrls = provider.overlay ? expandTiles({ tiles: provider.overlay, subdomains: provider.subdomains }, key) : null;
  const rasterKey = [label, `${w}x${h}`, fit.z, fit.cx.toFixed(6), fit.cy.toFixed(6), P.panel,
    baseUrls.join('|'), overlayUrls?.join('|') || ''].join('~');
  const cached = cacheGet(rasterKey);
  if (cached) { onProgress?.(1); return cachedMap(cached, fit, dispSegs, dispWps); }

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
  await Promise.all(Array.from({ length: 10 }, worker));

  if (failed) {
    paintVectorBackground(ctx, w, h);
    return mapResult(bg, fit, dispSegs, dispWps, true, 'vector');
  }
  ctx.fillStyle = P.panel;
  ctx.fillRect(0, 0, w, h);
  for (const layer of [0, 1]) {
    for (const j of jobs) if (j.layer === layer) ctx.drawImage(j.img, j.px, j.py);
  }
  const result = mapResult(bg, fit, dispSegs, dispWps, false, label);
  cachePut(rasterKey, result);
  return result;
}

// Along-path gradient (teal → sky → indigo) with layered soft glow and a
// centre highlight — the neon-tube look used by modern recap renderers.
const BRIGHT_STOPS = [[43, 205, 167], [56, 189, 248], [129, 140, 248]];
function lut(t, stops = BRIGHT_STOPS) {
  const s = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(s));
  const f = s - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * Draw the track over a prepared map. `upto` limits rendering to the first N
 * points (video playback); the head point gets the amber marker. `darkBg`
 * switches to the bright gradient so the line stays visible on satellite or
 * night-style tiles.
 */
export function paintTrack(ctx, fit, segments, waypoints, {
  upto = Infinity, lineWidth = 6.5, dotRadius = 12, wpRadius = 5.5, darkBg = false,
  trackColor = '', hideStart = false, hideEnd = false, headKind = 'end'
} = {}) {
  if (!fit) return;
  const P = canvasPalette();
  const theme = effectiveTheme();
  // Preserve the original dark/light satellite treatment and Matrix behavior;
  // identity themes always use their own LUT instead of the shared bright ramp.
  const bright = darkBg && (theme === 'dark' || theme === 'light');
  const stops = bright ? BRIGHT_STOPS : P.lut;
  const halo = bright ? 'rgba(0,0,0,0.40)' : P.trackHalo;
  const casing = bright ? 'rgba(4,16,24,0.74)' : P.trackCasing;
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
  // Halo + casing separate the gradient from both pale street maps and dark
  // imagery; the thin highlight keeps the line from looking flat.
  const passes = trackColor
    ? [
        { w: lineWidth * 1.9, a: 0.18, color: halo },
        { w: lineWidth + 2.8, a: 0.90, color: casing },
        { w: lineWidth, a: 1, color: trackColor },
        { w: Math.max(1.2, lineWidth * 0.24), a: 0.26, color: 'rgba(255,255,255,0.9)' }
      ]
    : [
        { w: lineWidth * 1.9, a: 0.20, color: halo },
        { w: lineWidth + 2.8, a: bright ? 0.85 : 0.92, color: casing },
        { w: lineWidth, a: 1 },
        { w: Math.max(1.2, lineWidth * 0.24), a: bright ? 0.26 : 0.34, color: 'rgba(255,255,255,0.9)' }
      ];
  for (const pass of passes) {
    ctx.globalAlpha = pass.a;
    ctx.lineWidth = pass.w;
    let gi = 0;
    for (const pts of polys) {
      for (let s = 0; s < pts.length - 1; s += chunk - 1) {
        const e = Math.min(pts.length, s + chunk);
        ctx.strokeStyle = pass.color || lut((gi + s + (e - s) / 2) / Math.max(1, count), stops);
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
    ctx.fillStyle = bright ? 'rgba(255,255,255,0.95)' : P.text;
    ctx.beginPath(); ctx.arc(x, y, wpRadius, 0, 7); ctx.fill();
    ctx.strokeStyle = bright ? 'rgba(4,16,24,0.8)' : P.wpRing;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, wpRadius + 1.5, 0, 7); ctx.stroke();
  }
  const ring = (p, fill) => {
    const [x, y] = fit.toPx(p);
    ctx.fillStyle = casing;
    ctx.beginPath(); ctx.arc(x, y, dotRadius + 3.5, 0, 7); ctx.fill();
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.arc(x, y, dotRadius, 0, 7); ctx.fill();
    ctx.strokeStyle = bright ? 'rgba(255,255,255,0.92)' : P.endRing;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, dotRadius + 2.5, 0, 7); ctx.stroke();
  };
  if (first && !hideStart) ring(first, trackColor || P.accent);
  const atEnd = head && head !== first;
  const isPlayhead = headKind === 'playhead';
  if (atEnd && !(hideEnd && (!isPlayhead || upto >= total))) {
    ring(head, isPlayhead ? (trackColor || P.accent) : P.amber);
  }
  ctx.restore();
}