// Share metadata for posters/videos: exact trip clock range plus ordered
// place names sampled along the track via OSM-based reverse geocoding.
import { haversine, fmtDuration } from './geo';
import { currentLang } from './i18n';

const CACHE_KEY = 'trackmint.places.v1';
const CACHE_TTL = 30 * 24 * 3600 * 1000;
const EMPTY_TTL = 24 * 3600 * 1000;
const MAX_CACHE = 400;
const PHOTON_GAP = 350;
const NOMINATIM_GAP = 1100;
const PLACE_BUDGET = 9000;

type Entry = { name: string; ts: number };

function loadCache(): Record<string, Entry> {
  try {
    const o = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

let cache = loadCache();
let lastRequestAt = 0;
const inflight = new Map<string, Promise<string>>();

function persist() {
  try {
    const keys = Object.keys(cache);
    if (keys.length > MAX_CACHE) {
      keys.sort((a, b) => cache[a].ts - cache[b].ts)
        .slice(0, keys.length - MAX_CACHE)
        .forEach((k) => delete cache[k]);
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch { /* storage full — cache is best-effort */ }
}

const cacheKey = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`;

function pad2(n: number) { return String(n).padStart(2, '0'); }

/** Clock range + exact elapsed time from the trip's own point timestamps. */
export function tripTimeInfo(full: any) {
  const pts = full?.segments?.flatMap((s: any) => s.points || []) || [];
  let first = null, last = null;
  for (const p of pts) {
    if (!p?.t) continue;
    if (first == null) first = p.t;
    last = p.t;
  }
  if (first == null || last == null || last <= first) return null;
  const a = new Date(first), b = new Date(last);
  const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = a.toDateString() === b.toDateString();
  return {
    ts: first,
    te: last,
    date: a.toLocaleDateString(),
    start: hm(a),
    end: sameDay ? hm(b) : `${b.toLocaleDateString()} ${hm(b)}`,
    durationMs: last - first,
    duration: fmtDuration(last - first)
  };
}

function photonLabel(props: any) {
  if (!props) return '';
  return props.street || props.locality || props.district || props.name || props.city || '';
}

function nominatimLabel(j: any) {
  const a = j?.address || {};
  return a.road || a.pedestrian || a.footway || a.cycleway || a.path || a.square
    || a.neighbourhood || a.suburb || a.village || a.town || a.city_district
    || a.city || a.county || j?.name || '';
}

async function fetchJson(url: string, signal?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  const relay = () => ctrl.abort();
  signal?.addEventListener('abort', relay, { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

async function reverseOne(lat: number, lon: number, signal?: AbortSignal) {
  const key = cacheKey(lat, lon);
  const hit = cache[key];
  if (hit && Date.now() - hit.ts < (hit.name ? CACHE_TTL : EMPTY_TTL)) return hit.name;
  if (!navigator.onLine) return '';
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const wait = Math.max(0, PHOTON_GAP - (Date.now() - lastRequestAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    const photon = await fetchJson(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}`, signal);
    let name = photonLabel(photon?.features?.[0]?.properties);

    if (!name && !signal?.aborted) {
      const gap = Math.max(0, NOMINATIM_GAP - (Date.now() - lastRequestAt));
      if (gap) await new Promise((r) => setTimeout(r, gap));
      lastRequestAt = Date.now();
      const lang = currentLang() === 'zh' ? 'zh-CN' : 'en';
      const nomi = await fetchJson(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1&accept-language=${lang}`,
        signal
      );
      name = nominatimLabel(nomi);
    }

    if (signal?.aborted) return '';
    cache[key] = { name, ts: Date.now() };
    persist();
    return name;
  })();
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

function pointsAtDistances(points: any[], cum: number[], total: number, count: number) {
  const out = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (j < cum.length - 1 && cum[j] < target) j++;
    out.push(points[j]);
  }
  return out;
}

/**
 * Ordered place labels along the (already privacy-cropped) route.
 * Longer routes get more samples; consecutive duplicates are collapsed.
 */
export async function routePlaceNames(
  segments: any[],
  { max = 6, signal, onProgress }: { max?: number; signal?: AbortSignal; onProgress?: (p: number) => void } = {}
): Promise<string[]> {
  const pts = segments.flatMap((s) => s.points || []);
  if (pts.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
  }
  const total = cum[cum.length - 1];
  if (!(total > 20)) return [];

  const samples = Math.min(8, Math.max(3, Math.ceil(total / 1500) + 2));
  const targets = pointsAtDistances(pts, cum, total, samples);
  const names: string[] = [];
  const budget = new AbortController();
  const stop = () => budget.abort();
  const timer = setTimeout(stop, PLACE_BUDGET);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for (let i = 0; i < targets.length; i++) {
      if (budget.signal.aborted) break;
      const name = await reverseOne(targets[i].lat, targets[i].lon, budget.signal);
      if (name && names[names.length - 1] !== name) names.push(name);
      onProgress?.((i + 1) / targets.length);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
  onProgress?.(1);

  if (names.length <= max) return names;
  const kept: string[] = [];
  for (let i = 0; i < max; i++) {
    const n = names[Math.round((i * (names.length - 1)) / (max - 1))];
    if (kept[kept.length - 1] !== n) kept.push(n);
  }
  return kept;
}
