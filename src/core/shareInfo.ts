// Share metadata for posters/videos: exact trip clock range plus ordered
// place names sampled along the track via OSM-based reverse geocoding.
import { haversine, fmtDuration } from './geo';
import { currentLang } from './i18n';
import { languageTag } from './language';
import { applyPrivacy } from './privacy';
import { migrateLegacyKey } from './storageKeys';
import { cityFootprintKey, normalizeCityFootprint, type CityFootprint } from './footprint';

export type { CityFootprint } from './footprint';

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

function validCityCacheEntry(key: string, entry: any): entry is CityEntry {
  if (!entry || !Number.isFinite(entry.ts)) return false;
  if (!/^[A-Z]{2}$/.test(String(entry.countryCode || '').trim().toUpperCase())) return false;
  const normalized = normalizeCityFootprint(entry);
  const parts = key.split(',').map(Number);
  return !!normalized && parts.length === 2 && parts.every(Number.isFinite)
    && normalized.lat === parts[0] && normalized.lon === parts[1];
}

function loadCityCache(): Record<string, CityEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CITY_CACHE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean: Record<string, CityEntry> = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (validCityCacheEntry(key, entry)) clean[key] = entry;
    }
    return clean;
  } catch {
    return {};
  }
}

let cityCache: Record<string, CityEntry> = loadCityCache();
const cityInflight = new Map<string, Promise<CityFootprint | null>>();

function persistCities() {
  try {
    for (const key of Object.keys(cityCache)) {
      if (!validCityCacheEntry(key, cityCache[key])) delete cityCache[key];
    }
    const keys = Object.keys(cityCache);
    if (keys.length > 600) {
      keys.sort((a, b) => cityCache[a].ts - cityCache[b].ts).slice(0, keys.length - 600).forEach((k) => delete cityCache[k]);
    }
    localStorage.setItem(CITY_CACHE_KEY, JSON.stringify(cityCache));
  } catch { /* cache is best-effort */ }
}

// Persist the sanitized view so legacy entries without country metadata cannot
// be reused by this or a later session.
persistCities();

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
  const locale = languageTag(currentLang());
  const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = a.toDateString() === b.toDateString();
  return {
    ts: first,
    te: last,
    date: a.toLocaleDateString(locale),
    start: hm(a),
    end: sameDay ? hm(b) : `${b.toLocaleDateString(locale)} ${hm(b)}`,
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
      const locale = languageTag(currentLang());
      const nomi = await fetchJson(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1&accept-language=${locale}`,
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
  if (hit) {
    if (!validCityCacheEntry(key, hit) || Date.now() - hit.ts >= CITY_CACHE_TTL) {
      delete cityCache[key];
      persistCities();
    } else {
      return normalizeCityFootprint(hit);
    }
  }
  if (!navigator.onLine) return null;
  const running = cityInflight.get(key);
  if (running) return running;
  const task = (async () => {
    const wait = Math.max(0, PHOTON_GAP - (Date.now() - lastRequestAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    const locale = languageTag(currentLang());
    const lang = locale.split('-')[0];
    const photon = await fetchJson(`https://photon.komoot.io/reverse?lat=${roundedLat}&lon=${roundedLon}&lang=${lang}`, signal);
    const props = photon?.features?.[0]?.properties;
    let name = photonCity(props);
    let countryCode = String(props?.country_code || '').trim().toUpperCase();
    let admin = String(props?.state || props?.county || '').trim();
    if (!name && !signal?.aborted) {
      const gap = Math.max(0, NOMINATIM_GAP - (Date.now() - lastRequestAt));
      if (gap) await new Promise((r) => setTimeout(r, gap));
      lastRequestAt = Date.now();
      const acceptLanguage = languageTag(currentLang());
      const nomi = await fetchJson(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${roundedLat}&lon=${roundedLon}&zoom=10&addressdetails=1&accept-language=${acceptLanguage}`,
        signal
      );
      name = nominatimCity(nomi);
      countryCode ||= String(nomi?.address?.country_code || '').trim().toUpperCase();
      admin ||= String(nomi?.address?.state || nomi?.address?.county || '').trim();
    }
    if (signal?.aborted) return null;
    const city = normalizeCityFootprint({ name, countryCode, admin, lat: roundedLat, lon: roundedLon });
    if (city) {
      cityCache[key] = { ...city, ts: Date.now() };
      persistCities();
    }
    return city;
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

export function routeNodeNames(cropped: any, max = 6): string[] {
  const points = (cropped?.segments || []).flatMap((segment: any) => segment.points || []);
  const waypoints = (cropped?.waypoints || []).filter((wp: any) => wp?.type === 'route' && String(wp.name || '').trim());
  if (points.length < 2 || !waypoints.length) return [];
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon));
  }
  const timeDelta = (wp: any, index: number) => Number.isFinite(wp.time) && Number.isFinite(points[index].t)
    ? Math.abs(wp.time - points[index].t)
    : Infinity;
  const ordered = waypoints.map((wp: any, order: number) => {
    const cosLat = Math.cos((wp.lat * Math.PI) / 180);
    let bestIndex = 0, bestDistance = Infinity, bestTime = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dx = (points[i].lon - wp.lon) * cosLat;
      const dy = points[i].lat - wp.lat;
      const distance = dx * dx + dy * dy;
      const dt = timeDelta(wp, i);
      if (distance < bestDistance - 1e-10 || (Math.abs(distance - bestDistance) <= 1e-10 && dt < bestTime)) {
        bestIndex = i; bestDistance = distance; bestTime = dt;
      }
    }
    return { name: String(wp.name).trim(), distance: cumulative[bestIndex], time: Number.isFinite(wp.time) ? wp.time : Infinity, order };
  }).sort((a, b) => a.distance - b.distance || a.time - b.time || a.order - b.order);
  const names: string[] = [];
  for (const item of ordered) if (!names.includes(item.name)) names.push(item.name);
  if (names.length <= max) return names;
  const kept: string[] = [];
  for (let i = 0; i < max; i++) {
    const name = names[Math.round((i * (names.length - 1)) / (max - 1))];
    if (!kept.includes(name)) kept.push(name);
  }
  return kept;
}

export async function routeDisplayNames(
  cropped: any,
  { max = 6, signal, onProgress }: { max?: number; signal?: AbortSignal; onProgress?: (p: number) => void } = {}
): Promise<string[]> {
  const custom = routeNodeNames(cropped, max);
  if (custom.length) {
    onProgress?.(1);
    return custom;
  }
  return routePlaceNames(cropped.segments, { max, signal, onProgress });
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
      const normalized = normalizeCityFootprint(city);
      if (normalized) cities.set(cityFootprintKey(normalized), normalized);
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
  const cropped = applyPrivacy({ ...full, waypoints: [] }, privacy);
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
