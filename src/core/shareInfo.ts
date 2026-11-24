// Share metadata for posters/videos: exact trip clock range plus ordered
// place names sampled along the track via OSM-based reverse geocoding.
import { haversine, fmtDuration } from './geo';
import { currentLang } from './i18n';
import { applyPrivacy } from './privacy';
import { migrateLegacyKey } from './storageKeys';

const CACHE_KEY = 'roametch.places.v1';
const CACHE_TTL = 30 * 24 * 3600 * 1000;
const EMPTY_TTL = 24 * 3600 * 1000;
const MAX_CACHE = 400;
const PHOTON_GAP = 350;
const NOMINATIM_GAP = 1100;
const PLACE_BUDGET = 9000;
const CITY_CACHE_KEY = 'roametch.cities.v1';
const CITY_CACHE_TTL = 180 * 24 * 3600 * 1000;
const CITY_BUDGET = 45_000;

migrateLegacyKey('trackmint.places.v1', CACHE_KEY);
migrateLegacyKey('trackmint.cities.v1', CITY_CACHE_KEY);

type Entry = { name: string; ts: number };
export type CityFootprint = { name: string; lat: number; lon: number };
type CityEntry = CityFootprint & { ts: number };

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
let cityCache: Record<string, CityEntry> = {};
try { cityCache = JSON.parse(localStorage.getItem(CITY_CACHE_KEY) || '{}') || {}; } catch { cityCache = {}; }
const cityInflight = new Map<string, Promise<CityFootprint | null>>();

function persistCities() {
  try {
    const keys = Object.keys(cityCache);
    if (keys.length > 600) {
      keys.sort((a, b) => cityCache[a].ts - cityCache[b].ts).slice(0, keys.length - 600).forEach((k) => delete cityCache[k]);
    }
    localStorage.setItem(CITY_CACHE_KEY, JSON.stringify(cityCache));
  } catch { /* cache is best-effort */ }
}

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

function photonCity(props: any) {
  return props?.city || props?.town || props?.village || props?.municipality || props?.county || props?.district || props?.state || '';
}

function nominatimCity(j: any) {
  const a = j?.address || {};
  return a.city || a.town || a.village || a.municipality || a.county || a.state || '';
}

async function reverseCity(lat: number, lon: number, signal?: AbortSignal): Promise<CityFootprint | null> {
  const roundedLat = Math.round(lat * 100) / 100;
  const roundedLon = Math.round(lon * 100) / 100;
  const key = `${roundedLat.toFixed(2)},${roundedLon.toFixed(2)}`;
  const hit = cityCache[key];
  if (hit && Date.now() - hit.ts < CITY_CACHE_TTL) {
    return hit.name ? { name: hit.name, lat: roundedLat, lon: roundedLon } : null;
  }
  if (!navigator.onLine) return null;
  const running = cityInflight.get(key);
  if (running) return running;
  const task = (async () => {
    const wait = Math.max(0, PHOTON_GAP - (Date.now() - lastRequestAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    const lang = currentLang() === 'zh' ? 'zh' : 'en';
    const photon = await fetchJson(`https://photon.komoot.io/reverse?lat=${roundedLat}&lon=${roundedLon}&lang=${lang}`, signal);
    let name = photonCity(photon?.features?.[0]?.properties);
    if (!name && !signal?.aborted) {
      const gap = Math.max(0, NOMINATIM_GAP - (Date.now() - lastRequestAt));
      if (gap) await new Promise((r) => setTimeout(r, gap));
      lastRequestAt = Date.now();
      const acceptLanguage = currentLang() === 'zh' ? 'zh-CN' : 'en';
      const nomi = await fetchJson(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${roundedLat}&lon=${roundedLon}&zoom=10&addressdetails=1&accept-language=${acceptLanguage}`,
        signal
      );
      name = nominatimCity(nomi);
    }
    if (signal?.aborted) return null;
    cityCache[key] = { name: String(name || ''), lat: roundedLat, lon: roundedLon, ts: Date.now() };
    persistCities();
    return name ? { name: String(name), lat: roundedLat, lon: roundedLon } : null;
  })();
  cityInflight.set(key, task);
  try { return await task; } finally { cityInflight.delete(key); }
}

function pointsAtDistances(points: any[], cum: number[], total: number, count: number, inset = 0) {
  if (count <= 1) return [points[Math.floor(points.length / 2)]];
  const out = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = total * (inset + ((1 - inset * 2) * i) / (count - 1));
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

function roundedPointInPrivacy(point: any, privacy: any) {
  const radius = Number(privacy?.radius) || 0;
  if (!(radius > 0)) return false;
  const lat = Math.round(point.lat * 100) / 100;
  const lon = Math.round(point.lon * 100) / 100;
  return [privacy.start, privacy.end].some((centre) => centre
    && haversine(lat, lon, centre.lat, centre.lon) <= radius);
}

export async function routeCities(
  segments: any[],
  { signal, onProgress, privacy }: {
    signal?: AbortSignal;
    onProgress?: (p: number) => void;
    privacy?: { radius?: number; start?: any; end?: any };
  } = {}
): Promise<CityFootprint[]> {
  const pts = segments.flatMap((s) => s.points || []);
  if (pts.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
  }
  const total = cum[cum.length - 1];
  if (!(total > 20)) return [];
  const count = total < 1500 ? 1 : Math.min(6, Math.max(2, Math.ceil(total / 8000) + 1));
  // Keep reverse-geocoding samples away from privacy-cropped route boundaries.
  const targets = pointsAtDistances(pts, cum, total, count, count > 1 ? 0.08 : 0);
  const cities = new Map<string, CityFootprint>();
  const budget = new AbortController();
  const stop = () => budget.abort();
  const timer = setTimeout(stop, CITY_BUDGET);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for (let i = 0; i < targets.length; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (budget.signal.aborted) break;
      if (roundedPointInPrivacy(targets[i], privacy)) {
        onProgress?.((i + 1) / targets.length);
        continue;
      }
      const city = await reverseCity(targets[i].lat, targets[i].lon, budget.signal);
      if (city) cities.set(String(city.name).trim().replace(/\s+/g, ' ').toLocaleLowerCase(), city);
      onProgress?.((i + 1) / targets.length);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
  onProgress?.(1);
  return [...cities.values()];
}

export async function resolveTripCities(full: any, privacy: any = {}, options: any = {}) {
  const cropped = applyPrivacy(full, privacy);
  const points = full?.segments?.flatMap((segment: any) => segment.points || []) || [];
  return routeCities(cropped.segments, {
    ...options,
    privacy: {
      radius: privacy.radius ?? 300,
      start: privacy.start || points[0],
      end: privacy.end || points[points.length - 1]
    }
  });
}
