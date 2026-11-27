// Year / month footprint aggregation for the local trip library.
import { fmtAltitude, fmtDistance } from './geo';

export type CityFootprint = { name: string; lat: number; lon: number; countryCode: string; admin: string };

/** Shared validation for upstream geocoding, caches and footprint aggregation. */
export function normalizeCityFootprint(city: any): CityFootprint | null {
  if (!city || typeof city !== 'object' || city.lat == null || city.lon == null || city.lat === '' || city.lon === '') return null;
  const name = String(city.name || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  const rawCountry = String(city.countryCode || '').trim().toUpperCase();
  const countryCode = /^[A-Z]{2}$/.test(rawCountry) ? rawCountry : 'ZZ';
  const lat = Number(city.lat);
  const lon = Number(city.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)
    || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const admin = String(city.admin || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  return { name, lat, lon, countryCode, admin };
}

export function cityFootprintKey(city: CityFootprint) {
  const normalized = normalizeCityFootprint(city);
  return normalized ? `${normalized.countryCode}:${normalized.name.toLocaleLowerCase()}` : '';
}

export function footprintCacheKey({ year, activity, privacyRadius, trips }: {
  year: number | 'all';
  activity: string;
  privacyRadius: number;
  trips: any[];
}) {
  const radius = Number(privacyRadius);
  const safeRadius = Number.isFinite(radius) && radius >= 0 ? radius : 0;
  const revisions = (trips || []).map((trip) => JSON.stringify([
    String(trip?.id || ''), trip?.updatedAt ?? trip?.revision ?? 0,
    String(trip?.activity || ''), String(trip?.status || '')
  ])).sort();
  return JSON.stringify([String(year), String(activity || 'all'), safeRadius, revisions]);
}

function startDate(trip) {
  const d = new Date(trip?.createdAt);
  return isNaN(d.getTime()) ? null : d;
}

function dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function buildFootprints(trips, now = new Date()) {
  const years = new Map();
  for (const trip of trips || []) {
    if (trip?.status === 'recording' || trip?.status === 'paused') continue;
    const d = startDate(trip);
    if (!d) continue;
    const year = d.getFullYear();
    let entry = years.get(year);
    if (!entry) {
      entry = {
        year, trips: 0, distance: 0, ascent: 0, duration: 0, days: new Set(), cities: [],
        months: Array.from({ length: 12 }, (_, i) => ({
          month: i + 1, trips: 0, distance: 0, ascent: 0, days: new Set()
        }))
      };
      years.set(year, entry);
    }
    const month = entry.months[d.getMonth()];
    const distance = Number(trip.statsCache?.distance) || 0;
    const ascent = Number(trip.statsCache?.ascent) || 0;
    const duration = Number(trip.statsCache?.duration) || 0;
    entry.trips++;
    entry.distance += distance;
    entry.ascent += ascent;
    entry.duration += duration;
    entry.days.add(dayKey(d));
    month.trips++;
    month.distance += distance;
    month.ascent += ascent;
    month.days.add(dayKey(d));
  }
  const currentYear = now.getFullYear();
  const list = [...years.values()].map((entry) => ({
    ...entry,
    days: entry.days.size,
    months: entry.months.map((m) => ({ ...m, days: m.days.size }))
  }));
  list.sort((a, b) => b.year - a.year);
  const current = list.find((f) => f.year === currentYear) || {
    year: currentYear, trips: 0, distance: 0, ascent: 0, duration: 0, days: 0, cities: [],
    months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, trips: 0, distance: 0, ascent: 0, days: 0 }))
  };
  return { years: list, current };
}

export function aggregateCityFootprints(entries: any[]) {
  const cities = new Map<string, any>();
  const centres = new Map<string, { lat: number; lon: number; samples: number }>();
  for (const entry of entries || []) {
    const at = Number(entry.trip?.createdAt) || 0;
    for (const rawCity of entry.cities || []) {
      const city = normalizeCityFootprint(rawCity);
      if (!city) continue;
      const key = cityFootprintKey(city);
      let item = cities.get(key);
      if (!item) {
        item = { ...city, trips: 0, visits: 0, tripIds: new Set(), firstAt: at, lastAt: at };
        cities.set(key, item);
      }
      if (!item.tripIds.has(entry.trip?.id)) {
        item.tripIds.add(entry.trip?.id);
        item.trips++;
      }
      item.visits++;
      if (at && (!item.firstAt || at < item.firstAt)) item.firstAt = at;
      if (at > item.lastAt) item.lastAt = at;
      const centre = centres.get(key) || { lat: 0, lon: 0, samples: 0 };
      centre.lat = (centre.lat * centre.samples + city.lat) / (centre.samples + 1);
      centre.lon = (centre.lon * centre.samples + city.lon) / (centre.samples + 1);
      centre.samples++;
      centres.set(key, centre);
    }
  }
  return [...cities.values()]
    .map((city) => {
      const centre = centres.get(cityFootprintKey(city));
      return { ...city, lat: centre.lat, lon: centre.lon, tripIds: [...city.tripIds] };
    })
    .sort((a, b) => b.trips - a.trips || b.visits - a.visits || a.name.localeCompare(b.name));
}

export function withFootprintCities(fp, cities) {
  return { ...fp, cities: cities || [] };
}

export function recapFootprint(fp, units = 'metric') {
  const activeMonths = fp.months.filter((m) => m.trips > 0).length;
  let top = null;
  for (const m of fp.months) {
    if (m.trips > 0 && (!top || m.distance > top.distance)) top = m;
  }
  return {
    year: fp.year,
    trips: fp.trips,
    days: fp.days,
    distance: fmtDistance(fp.distance, units),
    ascent: fmtAltitude(fp.ascent, units),
    activeMonths,
    cityCount: fp.cities?.length || 0,
    topMonth: top,
    maxMonthDistance: Math.max(1, ...fp.months.map((m) => m.distance))
  };
}
