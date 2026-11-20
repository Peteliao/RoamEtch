// Elevation adapter: GPS altitude > online service (grid-cached) > cache > unavailable.
// Never fabricates or interpolates missing altitude.
import { get } from './settings.js';
import { elevationEndpoint, isServiceOffline } from './providers.js';
import { elevCacheGet, elevCachePut, gridKey, db } from './store.js';
import { emit } from './events.js';

const GPS_ACC_LIMIT = 30;      // metres altitudeAccuracy to trust GPS altitude
const BATCH_WINDOW = 350;      // ms collect window
const BATCH_MAX = 100;
const FETCH_TIMEOUT = 5000;

let queue = [];
let timer = null;

/** Priority chain for a single fix. Returns {alt, src}. */
export async function resolveAltitude(lat, lon, gpsAlt, gpsAltAcc) {
  if (gpsAlt != null && isFinite(gpsAlt) && gpsAltAcc != null && gpsAltAcc <= GPS_ACC_LIMIT) {
    return { alt: gpsAlt, src: 'gps' };
  }
  const cached = await elevCacheGet(lat, lon);
  if (cached != null) return { alt: cached, src: 'cache' };
  if (isServiceOffline() || !navigator.onLine) return { alt: null, src: null };
  return new Promise((resolve) => {
    queue.push({ lat, lon, resolve });
    if (queue.length >= BATCH_MAX) flushQueue();
    else if (!timer) timer = setTimeout(flushQueue, BATCH_WINDOW);
  });
}

async function flushQueue() {
  if (timer) { clearTimeout(timer); timer = null; }
  const batch = queue.splice(0, BATCH_MAX);
  if (!batch.length) return;
  // dedupe by grid cell
  const byCell = new Map();
  for (const q of batch) {
    const k = gridKey(q.lat, q.lon);
    if (!byCell.has(k)) byCell.set(k, { lat: q.lat, lon: q.lon, waiters: [] });
    byCell.get(k).waiters.push(q);
  }
  const cells = [...byCell.values()];
  try {
    const elevations = await fetchBatch(cells.map((c) => [c.lat, c.lon]));
    cells.forEach((c, i) => {
      const el = elevations[i];
      if (el != null && isFinite(el)) {
        elevCachePut(c.lat, c.lon, el);
        c.waiters.forEach((w) => w.resolve({ alt: el, src: 'svc' }));
      } else {
        c.waiters.forEach((w) => w.resolve({ alt: null, src: null }));
      }
    });
  } catch {
    // service failed: fall back to cache-only result, never fabricate
    for (const c of cells) {
      const cached = await elevCacheGet(c.lat, c.lon);
      c.waiters.forEach((w) => w.resolve(cached != null ? { alt: cached, src: 'cache' } : { alt: null, src: null }));
    }
  }
  if (queue.length) timer = setTimeout(flushQueue, BATCH_WINDOW);
}

async function fetchBatch(coords) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const base = elevationEndpoint();
    const sep = base.includes('?') ? '&' : '?';
    const url = `${base}${sep}latitude=${coords.map((c) => c[0].toFixed(5)).join(',')}&longitude=${coords.map((c) => c[1].toFixed(5)).join(',')}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const arr = data.elevation;
    if (!Array.isArray(arr)) throw new Error('bad payload');
    return arr;
  } finally {
    clearTimeout(t);
  }
}

/** Backfill null-altitude points of a trip in batches (after edits / back online). */
export async function backfillTripAltitudes(tripId, { onProgress } = {}) {
  if (isServiceOffline() || !navigator.onLine) return 0;
  const chunks = await db.trackChunks.where('tripId').equals(tripId).toArray();
  let filled = 0;
  for (const chunk of chunks) {
    const missing = chunk.points.map((p, i) => ({ p, i })).filter(({ p }) => p.alt == null);
    if (!missing.length) continue;
    for (let s = 0; s < missing.length; s += BATCH_MAX) {
      const slice = missing.slice(s, s + BATCH_MAX);
      // cache first
      const needFetch = [];
      for (const m of slice) {
        const cached = await elevCacheGet(m.p.lat, m.p.lon);
        if (cached != null) { m.p.alt = cached; m.p.altSrc = 'cache'; filled++; }
        else needFetch.push(m);
      }
      if (needFetch.length) {
        try {
          const els = await fetchBatch(needFetch.map((m) => [m.p.lat, m.p.lon]));
          needFetch.forEach((m, i) => {
            const el = els[i];
            if (el != null && isFinite(el)) {
              m.p.alt = el; m.p.altSrc = 'svc'; filled++;
              elevCachePut(m.p.lat, m.p.lon, el);
            }
          });
        } catch { /* keep null — never fabricate */ }
      }
      onProgress?.(filled);
    }
    if (filled) await db.trackChunks.put(chunk);
  }
  if (filled) emit('elev:backfilled', { tripId, filled });
  return filled;
}

export const altSourceLabelKey = (src) =>
  src === 'gps' ? 'panel.altGps' : src === 'svc' ? 'panel.altSvc' : src === 'cache' ? 'panel.altCache' : 'panel.altNone';
export const altSourceShortKey = (src) =>
  src === 'gps' ? 'panel.altGpsShort' : src === 'svc' ? 'panel.altSvcShort' : src === 'cache' ? 'panel.altCacheShort' : 'panel.altNoneShort';
export const altSourceTagClass = (src) => src === 'gps' ? 'gps' : src === 'svc' ? 'svc' : src === 'cache' ? 'cache' : 'none';

export { GPS_ACC_LIMIT };
export function currentThreshold() { return get('ascentThreshold'); }